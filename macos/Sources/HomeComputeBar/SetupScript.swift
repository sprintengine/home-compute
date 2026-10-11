import Foundation

enum ScriptError: LocalizedError, Equatable {
    case notConfigured
    case notFound(String)
    case launch(String)
    /// Exit 2: the script rejected the input; the message is meant for the user.
    case validation(String)
    case failed(code: Int32, message: String)
    case badOutput(String)
    case timedOut(TimeInterval)

    var errorDescription: String? {
        switch self {
        case .notConfigured: "No setup script chosen. Choose macmini.sh in Settings › Connection."
        case .notFound(let path): "Setup script not found: \(path)"
        case .launch(let message): "Could not run the setup script: \(message)"
        case .validation(let message): message
        case .failed(let code, let message): message.isEmpty ? "The setup script failed (exit \(code))" : message
        case .badOutput(let detail): "Unexpected output from the setup script: \(detail)"
        case .timedOut(let seconds): "The setup script did not answer within \(Int(seconds)) s"
        }
    }
}

/// Output of a long command: raw chunks of stdout+stderr, then the exit status.
enum ScriptOutput: Sendable {
    case output(Data)
    case exit(Int32)
}

/// Runs the setup script (`macmini.sh`) as `/bin/bash <script> <args…>`. Secrets are only ever
/// passed on stdin. All process I/O happens on background queues; nothing here blocks the caller.
struct SetupScript: Sendable {
    let path: String

    init?(configured: String) {
        let trimmed = configured.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        path = (trimmed as NSString).expandingTildeInPath
    }

    var exists: Bool { FileManager.default.isReadableFile(atPath: path) }

    /// A small fixed environment: a launch agent or Finder-launched app has a minimal PATH,
    /// and the script needs Homebrew's and ~/.local/bin's tools.
    static func environment() -> [String: String] {
        let home = NSHomeDirectory()
        var env = [
            "HOME": home,
            "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(home)/.local/bin",
            "LANG": "en_US.UTF-8",
            "NO_COLOR": "1",
            "TERM": "dumb",
        ]
        let inherited = ProcessInfo.processInfo.environment
        for key in ["USER", "LOGNAME", "TMPDIR", "HOME_COMPUTE_BAR_CONFIG"] {
            if let value = inherited[key], !value.isEmpty { env[key] = value }
        }
        return env
    }

    // MARK: JSON commands

    /// Runs a JSON command. Exit 0: stdout is decoded as `T`. Exit 2: a validation error whose
    /// `{"ok": false, "error": …}` message is thrown as `.validation`. Anything else: `.failed` with stderr.
    @concurrent func json<T: Decodable & Sendable>(_ type: T.Type, _ arguments: [String], input: String? = nil,
                                                    timeout: TimeInterval = 120) async throws -> T {
        let started = Date()
        let result = try await capture(arguments, input: input.map { Data($0.utf8) }, timeout: timeout)
        let elapsed = String(format: "%.1f", Date().timeIntervalSince(started))
        Log.info("script \(arguments.joined(separator: " ")): exit \(result.status) in \(elapsed) s")
        let stdout = Self.jsonBody(result.stdout)
        let stderr = String(decoding: result.stderr, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        switch result.status {
        case 0:
            do {
                return try JSONDecoder().decode(T.self, from: stdout)
            } catch {
                let text = String(decoding: result.stdout.prefix(300), as: UTF8.self)
                throw ScriptError.badOutput(text.isEmpty ? "no output" : text)
            }
        case 2:
            if let reply = try? JSONDecoder().decode(ScriptReply.self, from: stdout), let message = reply.error, !message.isEmpty {
                throw ScriptError.validation(message)
            }
            throw ScriptError.validation(stderr.isEmpty ? "The setup script rejected the request" : LineSplitter.clean(stderr))
        default:
            let message = stderr.isEmpty ? String(decoding: result.stdout, as: UTF8.self) : stderr
            throw ScriptError.failed(code: result.status, message: Self.tail(LineSplitter.clean(message)))
        }
    }

    /// Runs a mutating JSON command and returns its reply; `ok: false` is thrown as a validation error.
    @concurrent func reply(_ arguments: [String], input: String? = nil) async throws -> ScriptReply {
        let reply = try await json(ScriptReply.self, arguments, input: input)
        if reply.ok == false { throw ScriptError.validation(reply.error ?? "The setup script reported a failure") }
        return reply
    }

    struct Captured: Sendable {
        var status: Int32
        var stdout: Data
        var stderr: Data
    }

    func capture(_ arguments: [String], input: Data?, timeout: TimeInterval) async throws -> Captured {
        try checkExists()
        let path = self.path
        let collector = OutputCollector()
        return try await withCheckedThrowingContinuation { continuation in
            let process = ScriptProcess(
                path: path, arguments: arguments, mergeOutput: false,
                onOutput: { channel, data in collector.append(channel, data) },
                onExit: { status, timedOut in
                    if timedOut {
                        continuation.resume(throwing: ScriptError.timedOut(timeout))
                    } else {
                        continuation.resume(returning: collector.result(status: status))
                    }
                })
            do {
                try process.start(input: input)
            } catch {
                continuation.resume(throwing: ScriptError.launch(error.localizedDescription))
                return
            }
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { process.terminate(timedOut: true) }
        }
    }

    // MARK: Long commands

    /// Runs a long command with stdout and stderr merged. The stream yields output chunks as they
    /// arrive and ends with `.exit`. There is no timeout (an image build takes minutes);
    /// cancelling the consuming task terminates the script.
    func stream(_ arguments: [String]) -> AsyncStream<ScriptOutput> {
        let path = self.path
        let exists = self.exists
        return AsyncStream { continuation in
            guard exists else {
                continuation.yield(.output(Data("Setup script not found: \(path)\n".utf8)))
                continuation.yield(.exit(127))
                continuation.finish()
                return
            }
            let started = Date()
            let process = ScriptProcess(
                path: path, arguments: arguments, mergeOutput: true,
                onOutput: { _, data in continuation.yield(.output(data)) },
                onExit: { status, _ in
                    let elapsed = String(format: "%.1f", Date().timeIntervalSince(started))
                    Log.info("script \(arguments.joined(separator: " ")): exit \(status) after \(elapsed) s")
                    continuation.yield(.exit(status))
                    continuation.finish()
                })
            continuation.onTermination = { reason in
                if case .cancelled = reason { process.terminate(timedOut: false) }
            }
            do {
                Log.info("script \(arguments.joined(separator: " ")): started")
                try process.start(input: nil)
            } catch {
                continuation.yield(.output(Data("Could not run \(path): \(error.localizedDescription)\n".utf8)))
                continuation.yield(.exit(127))
                continuation.finish()
            }
        }
    }

    // MARK: Helpers

    private func checkExists() throws {
        guard exists else { throw ScriptError.notFound(path) }
    }

    /// The JSON object in stdout. Tolerates stray lines before or after it.
    static func jsonBody(_ data: Data) -> Data {
        guard let open = data.firstIndex(of: UInt8(ascii: "{")),
              let close = data.lastIndex(of: UInt8(ascii: "}")), open < close else { return data }
        return data[open...close]
    }

    /// The last few lines of an error message (scripts print a lot before failing).
    private static func tail(_ text: String, lines: Int = 8) -> String {
        let all = text.split(separator: "\n", omittingEmptySubsequences: true)
        return all.suffix(lines).joined(separator: "\n")
    }
}

/// Splits streamed output into display lines: strips ANSI escape sequences and other control
/// characters, and keeps only the final state of `\r`-overwritten progress lines.
struct LineSplitter {
    private var pending = Data()
    private static let maxPending = 64 * 1024

    mutating func feed(_ data: Data) -> [String] {
        pending.append(data)
        var lines: [String] = []
        var start = pending.startIndex
        while let newline = pending[start...].firstIndex(of: 0x0A) {
            lines.append(Self.clean(String(decoding: pending[start..<newline], as: UTF8.self)))
            start = pending.index(after: newline)
        }
        pending = Data(pending[start...])
        if pending.count > Self.maxPending { lines += flush() }
        return lines
    }

    mutating func flush() -> [String] {
        defer { pending = Data() }
        guard !pending.isEmpty else { return [] }
        return [Self.clean(String(decoding: pending, as: UTF8.self))]
    }

    static func clean(_ raw: String) -> String {
        let text = stripANSI(raw)
        guard text.contains("\r") else { return text }
        let parts = text.split(separator: "\r", omittingEmptySubsequences: true)
        return parts.last.map(String.init) ?? ""
    }

    /// Removes CSI (`ESC [ … m`), OSC (`ESC ] … BEL`) and two-character escapes, plus control
    /// characters other than tab, newline and carriage return.
    static func stripANSI(_ text: String) -> String {
        guard text.unicodeScalars.contains(where: { $0.value < 0x20 && $0 != "\t" && $0 != "\n" }) else { return text }
        var out = String.UnicodeScalarView()
        var it = text.unicodeScalars.makeIterator()
        while let c = it.next() {
            if c == "\u{1B}" {
                guard let next = it.next() else { break }
                if next == "[" {
                    while let x = it.next(), !(0x40...0x7E).contains(x.value) {}
                } else if next == "]" {
                    while let x = it.next() {
                        if x == "\u{07}" { break }
                        if x == "\u{1B}" { _ = it.next(); break }
                    }
                }
                continue
            }
            if c.value < 0x20, c != "\t", c != "\n", c != "\r" { continue }
            if c.value == 0x7F { continue }
            out.append(c)
        }
        return String(out)
    }
}

// MARK: - Process plumbing

private final class OutputCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var stdout = Data()
    private var stderr = Data()

    func append(_ channel: ScriptProcess.Channel, _ data: Data) {
        lock.withLock {
            switch channel {
            case .stdout: stdout.append(data)
            case .stderr: stderr.append(data)
            }
        }
    }

    func result(status: Int32) -> SetupScript.Captured {
        lock.withLock { SetupScript.Captured(status: status, stdout: stdout, stderr: stderr) }
    }
}

/// One `/bin/bash script args…` process. Output is delivered from background queues via
/// `onOutput`; `onExit` is called exactly once, after the process exits and its pipes reach EOF,
/// or a short grace period after exit in case something the script started (a daemon)
/// inherited the pipes and keeps them open.
private final class ScriptProcess: @unchecked Sendable {
    enum Channel: Sendable { case stdout, stderr }

    private let process = Process()
    private let lock = NSLock()
    private let readers: [(Channel, FileHandle)]
    private let stdin: Pipe?
    private let onOutput: @Sendable (Channel, Data) -> Void
    private let onExit: @Sendable (Int32, Bool) -> Void
    private var openPipes: Int
    private var exitStatus: Int32?
    private var finished = false
    private var timedOut = false

    private static let exitGrace: TimeInterval = 2

    init(path: String, arguments: [String], mergeOutput: Bool,
         onOutput: @escaping @Sendable (Channel, Data) -> Void,
         onExit: @escaping @Sendable (Int32, Bool) -> Void) {
        self.onOutput = onOutput
        self.onExit = onExit
        process.executableURL = URL(filePath: "/bin/bash")
        process.arguments = [path] + arguments
        process.environment = SetupScript.environment()
        process.currentDirectoryURL = URL(filePath: path).deletingLastPathComponent()

        let out = Pipe()
        process.standardOutput = out
        if mergeOutput {
            process.standardError = out
            readers = [(.stdout, out.fileHandleForReading)]
        } else {
            let err = Pipe()
            process.standardError = err
            readers = [(.stdout, out.fileHandleForReading), (.stderr, err.fileHandleForReading)]
        }
        openPipes = readers.count
        stdin = Pipe()
        process.standardInput = stdin
    }

    func start(input: Data?) throws {
        // A script that exits without reading stdin must not kill the app with SIGPIPE.
        signal(SIGPIPE, SIG_IGN)
        for (channel, handle) in readers {
            handle.readabilityHandler = { [self] handle in
                let data = handle.availableData
                if data.isEmpty {
                    handle.readabilityHandler = nil
                    pipeClosed()
                } else {
                    deliver(channel, data)
                }
            }
        }
        process.terminationHandler = { [self] process in
            let status = process.terminationReason == .uncaughtSignal ? 128 + process.terminationStatus : process.terminationStatus
            exited(status)
        }
        do {
            try process.run()
        } catch {
            for (_, handle) in readers { handle.readabilityHandler = nil }
            process.terminationHandler = nil
            throw error
        }
        if let stdin {
            let writer = stdin.fileHandleForWriting
            if let input, !input.isEmpty { try? writer.write(contentsOf: input) }
            try? writer.close()
        }
    }

    func terminate(timedOut: Bool) {
        let running = lock.withLock { () -> Bool in
            guard !finished else { return false }
            if timedOut { self.timedOut = true }
            return true
        }
        if running, process.isRunning { process.terminate() }
    }

    private func deliver(_ channel: Channel, _ data: Data) {
        // Under the lock so no output is delivered after onExit.
        lock.withLock {
            guard !finished else { return }
            onOutput(channel, data)
        }
    }

    private func pipeClosed() {
        let ready = lock.withLock { () -> Bool in
            openPipes -= 1
            return openPipes <= 0 && exitStatus != nil
        }
        if ready { finish() }
    }

    private func exited(_ status: Int32) {
        let ready = lock.withLock { () -> Bool in
            exitStatus = status
            return openPipes <= 0
        }
        if ready {
            finish()
        } else {
            DispatchQueue.global().asyncAfter(deadline: .now() + Self.exitGrace) { [self] in finish() }
        }
    }

    private func finish() {
        let outcome = lock.withLock { () -> (Int32, Bool)? in
            guard !finished, let exitStatus else { return nil }
            finished = true
            return (exitStatus, timedOut)
        }
        guard let (status, timedOut) = outcome else { return }
        for (_, handle) in readers { handle.readabilityHandler = nil }
        process.terminationHandler = nil
        onExit(status, timedOut)
    }
}
