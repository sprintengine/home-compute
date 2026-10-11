import AppKit
import Foundation
import Observation

/// What the control panel needs from the app's monitoring store (a protocol so tests can stand in).
@MainActor
protocol ControlHost: AnyObject {
    var config: AppConfig { get }
    func updateConfig(_ config: AppConfig) throws
    func reloadConfig()
    func reconnect()
}

extension Store: ControlHost {}

/// The setup script's long commands.
enum LongCommand: Equatable, Sendable {
    case setup, start, stop, restart, restartController, image
    case colimaAutostart(Bool)

    var arguments: [String] {
        switch self {
        case .setup: ["setup"]
        case .start: ["start"]
        case .stop: ["stop"]
        case .restart: ["restart"]
        case .restartController: ["restart", "controller"]
        case .image: ["image"]
        case .colimaAutostart(let on): ["colima-autostart", on ? "on" : "off"]
        }
    }

    var title: String {
        switch self {
        case .setup: "Setting up"
        case .start: "Starting"
        case .stop: "Stopping"
        case .restart: "Restarting"
        case .restartController: "Restarting the scheduler"
        case .image: "Building the worker image"
        case .colimaAutostart(let on): on ? "Turning on Colima at login" : "Turning off Colima at login"
        }
    }

    var doneTitle: String {
        switch self {
        case .setup: "Set up"
        case .start: "Started"
        case .stop: "Stopped"
        case .restart: "Restarted"
        case .restartController: "Scheduler restarted"
        case .image: "Image built"
        case .colimaAutostart(let on): on ? "Colima starts at login" : "Colima no longer starts at login"
        }
    }

    /// Commands after which the scheduler has read the current config and .env.
    var appliesConfig: Bool { [.start, .restart, .restartController].contains(self) }
}

struct LogLine: Identifiable, Sendable {
    let id: Int
    let text: String
}

/// One run of a long command, shown in the log sheet and the popover.
@MainActor @Observable
final class LongRun: Identifiable {
    let id = UUID()
    let command: LongCommand
    let started = Date()
    private(set) var lines: [LogLine] = []
    private(set) var exitCode: Int32?
    private(set) var finished: Date?
    @ObservationIgnored private var nextLine = 0

    static let maxLines = 5000

    init(command: LongCommand) {
        self.command = command
    }

    var isRunning: Bool { exitCode == nil }
    var succeeded: Bool { exitCode == 0 }
    var lastLine: String? { lines.last { !$0.text.trimmingCharacters(in: .whitespaces).isEmpty }?.text }

    var statusText: String {
        switch exitCode {
        case nil: "\(command.title)…"
        case 0?: command.doneTitle
        case let code?: "\(command.title) failed (exit \(code))"
        }
    }

    func append(_ new: [String]) {
        guard !new.isEmpty else { return }
        for text in new {
            lines.append(LogLine(id: nextLine, text: text))
            nextLine += 1
        }
        if lines.count > Self.maxLines { lines.removeFirst(lines.count - Self.maxLines) }
    }

    func finish(_ code: Int32) {
        exitCode = code
        finished = .now
    }
}

@MainActor @Observable
final class ControlStore {
    static let shared = ControlStore(host: Store.shared)

    enum Tab: Hashable { case services, storage, image, timetable, connection }

    var selectedTab: Tab = .services
    /// Whether the log sheet for `run` is shown in the settings window.
    var showLog = false
    /// Set after a config or .env change the running scheduler hasn't picked up yet.
    var restartPending = false

    private(set) var state: SetupState?
    private(set) var stateError: String?
    private(set) var stateUpdated: Date?
    private(set) var isLoadingState = false

    private(set) var env: EnvInfo?
    private(set) var envError: String?
    private(set) var timetable: Timetable?
    private(set) var timetableError: String?

    private(set) var r2Result: R2TestResult?
    private(set) var r2Error: String?
    private(set) var isTestingR2 = false

    private(set) var run: LongRun?

    @ObservationIgnored private let host: ControlHost
    @ObservationIgnored private var watchers = 0
    @ObservationIgnored private var pollTask: Task<Void, Never>?

    static let pollInterval: Duration = .seconds(5)

    init(host: ControlHost) {
        self.host = host
    }

    var script: SetupScript? { SetupScript(configured: host.config.setupScript) }
    var isRunning: Bool { run?.isRunning == true }

    // MARK: Setup script path

    func setScriptPath(_ path: String) throws {
        var config = host.config
        config.setupScript = path
        try host.updateConfig(config)
        state = nil
        stateError = nil
        env = nil
        timetable = nil
        r2Result = nil
        Log.info("setup script: \(path.isEmpty ? "cleared" : path)")
        Task { await refreshAll() }
    }

    /// Asks for macmini.sh with an open panel and saves the choice. Returns an error message.
    func chooseScript() -> String? {
        let panel = NSOpenPanel()
        panel.title = "Choose the setup script"
        panel.message = "Choose macmini.sh in your wingfoil checkout (deploy/home-compute/macmini.sh)."
        panel.prompt = "Choose"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        if let current = script?.path {
            panel.directoryURL = URL(filePath: current).deletingLastPathComponent()
        }
        NSApp.activate()
        guard panel.runModal() == .OK, let url = panel.url else { return nil }
        do {
            try setScriptPath(url.path)
            return nil
        } catch {
            return "Could not save: \(error.localizedDescription)"
        }
    }

    // MARK: Polling while a control view is visible

    func watch() {
        watchers += 1
        guard pollTask == nil else { return }
        pollTask = Task {
            while !Task.isCancelled {
                await refreshState()
                try? await Task.sleep(for: ControlStore.pollInterval)
            }
        }
    }

    func unwatch() {
        watchers = max(0, watchers - 1)
        if watchers == 0 {
            pollTask?.cancel()
            pollTask = nil
        }
    }

    // MARK: Read-only commands

    func refreshAll() async {
        async let state: Void = refreshState()
        async let env: Void = loadEnv()
        async let timetable: Void = loadTimetable()
        _ = await (state, env, timetable)
    }

    func refreshState() async {
        guard let script else { state = nil; stateError = nil; return }
        if isLoadingState { return }
        isLoadingState = true
        defer { isLoadingState = false }
        do {
            let new = try await script.json(SetupState.self, ["state", "--json"], timeout: 60)
            if new != state { logState(new) }
            state = new
            stateError = nil
            stateUpdated = .now
        } catch {
            stateError = error.localizedDescription
            Log.info("state failed: \(error.localizedDescription)")
        }
    }

    func loadEnv() async {
        guard let script else { return }
        do {
            env = try await script.json(EnvInfo.self, ["env", "--json"], timeout: 30)
            envError = nil
        } catch {
            envError = error.localizedDescription
            Log.info("env failed: \(error.localizedDescription)")
        }
    }

    func loadTimetable() async {
        guard let script else { return }
        do {
            timetable = try await script.json(Timetable.self, ["jobs", "--json"], timeout: 30)
            timetableError = nil
        } catch {
            timetableError = error.localizedDescription
            Log.info("jobs failed: \(error.localizedDescription)")
        }
    }

    func testR2() async {
        guard let script else { return }
        isTestingR2 = true
        defer { isTestingR2 = false }
        r2Error = nil
        do {
            let result = try await script.json(R2TestResult.self, ["r2-test", "--json"], timeout: 120)
            r2Result = result
            Log.info("r2-test: ok=\(result.ok) manifests=\(result.manifests.count)\(result.error.map { " error=\($0)" } ?? "")")
        } catch {
            r2Result = nil
            r2Error = error.localizedDescription
        }
    }

    // MARK: Mutating JSON commands (each returns an error message for inline display)

    /// Sends each changed `.env` value with `env set NAME`, value on stdin. Stops at the first error.
    func saveEnv(_ changes: [(name: String, value: String)]) async -> (saved: [String], error: String?) {
        guard let script else { return ([], ScriptError.notConfigured.localizedDescription) }
        var saved: [String] = []
        var failure: String?
        for (name, value) in changes {
            do {
                let reply = try await script.reply(["env", "set", name], input: value)
                if reply.restartRequired != false { restartPending = true }
                saved.append(name)
                Log.info("env set \(name): ok")
            } catch {
                failure = "\(name): \(error.localizedDescription)"
                Log.info("env set \(name) failed: \(error.localizedDescription)")
                break
            }
        }
        await loadEnv()
        return (saved, failure)
    }

    func rotateToken() async -> String? {
        guard let script else { return ScriptError.notConfigured.localizedDescription }
        do {
            let reply = try await script.reply(["token", "rotate", "--json"])
            if reply.restartRequired != false { restartPending = true }
            host.reloadConfig()
            Log.info("token rotated")
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func saveJob(_ id: String, arguments: [String]) async -> String? {
        guard let script else { return ScriptError.notConfigured.localizedDescription }
        guard !arguments.isEmpty else { return nil }
        do {
            let reply = try await script.reply(["jobs", "set", id] + arguments)
            if reply.restartRequired != false { restartPending = true }
            Log.info("jobs set \(id) \(arguments.joined(separator: " ")): ok")
            await loadTimetable()
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    // MARK: Long commands

    /// Starts a long command unless one is already running. `showLog` opens the log sheet.
    @discardableResult
    func start(_ command: LongCommand, showLog: Bool = true) -> LongRun? {
        guard !isRunning else { return nil }
        guard let script else {
            stateError = ScriptError.notConfigured.localizedDescription
            return nil
        }
        let run = LongRun(command: command)
        self.run = run
        self.showLog = showLog
        Task {
            var splitter = LineSplitter()
            for await output in script.stream(command.arguments) {
                switch output {
                case .output(let data):
                    run.append(splitter.feed(data))
                case .exit(let code):
                    run.append(splitter.flush())
                    run.finish(code)
                }
            }
            if run.isRunning { run.finish(-1) }
            await finished(run)
        }
        return run
    }

    /// Hides a finished run from the popover.
    func dismissRun() {
        guard let run, !run.isRunning else { return }
        self.run = nil
        showLog = false
    }

    private func finished(_ run: LongRun) async {
        // `setup` writes a new menubar.json; pick up the token (and keep the script path).
        host.reloadConfig()
        if run.succeeded, run.command.appliesConfig {
            restartPending = false
            host.reconnect()
        }
        if run.command == .setup {
            await refreshAll()
        } else {
            await refreshState()
        }
    }

    // MARK: Logs

    /// Opens a log file in Console (or the logs folder in Finder). Returns an error message.
    func openLog(_ path: String?) -> String? {
        guard let path, !path.isEmpty else { return "The setup script didn't report this log's path." }
        let url = URL(filePath: (path as NSString).expandingTildeInPath)
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else {
            return "No log yet at \(url.path)"
        }
        if isDirectory.boolValue {
            NSWorkspace.shared.open(url)
            return nil
        }
        guard let console = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Console") else {
            NSWorkspace.shared.open(url)
            return nil
        }
        NSWorkspace.shared.open([url], withApplicationAt: console, configuration: NSWorkspace.OpenConfiguration())
        return nil
    }

    private func logState(_ new: SetupState) {
        let services = new.services
        Log.info("state: setup \(new.setup?.complete.map { $0 ? "complete" : "incomplete" } ?? "?"), "
                 + "colima \(services?.colima?.state ?? "?"), bacalhau \(services?.bacalhau?.state ?? "?"), "
                 + "controller \(services?.controller?.state ?? "?"), image \(new.image?.freshness.description ?? "?")")
    }
}

extension SetupState.Image.Freshness: CustomStringConvertible {
    var description: String {
        switch self {
        case .missing: "missing"
        case .upToDate: "up to date"
        case .stale: "stale"
        case .untracked: "untracked"
        }
    }
}
