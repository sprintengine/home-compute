import Foundation
import Testing
@testable import HomeComputeBar

/// Runs the process runner and the control store against dev/fake-setup.sh. The fake keeps its
/// state next to `$HOME_COMPUTE_BAR_CONFIG`, which these tests point at a fresh temp directory,
/// so the tests are serialized and never touch ~/.config or the real setup script.
@Suite(.serialized)
@MainActor
final class SetupScriptTests {
    let dir: URL
    let configURL: URL
    let fake: SetupScript

    static let fakePath = URL(filePath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appending(path: "dev/fake-setup.sh").path

    init() throws {
        dir = FileManager.default.temporaryDirectory.appending(path: "hcb-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appending(path: "fake-setup"), withIntermediateDirectories: true)
        try Data("0.01".utf8).write(to: dir.appending(path: "fake-setup/delay"))
        configURL = dir.appending(path: "menubar.json")
        setenv("HOME_COMPUTE_BAR_CONFIG", configURL.path, 1)
        try Data(#"{"url": "http://127.0.0.1:1", "token": "old-token", "keepMe": 42, "setupScript": "\#(Self.fakePath)"}"#.utf8)
            .write(to: configURL)
        fake = SetupScript(configured: Self.fakePath)!
    }

    deinit {
        try? FileManager.default.removeItem(at: dir)
    }

    private func touch(_ name: String) throws {
        try Data().write(to: dir.appending(path: "fake-setup/\(name)"))
    }

    private func writeScript(_ body: String) throws -> SetupScript {
        let url = dir.appending(path: "script-\(UUID().uuidString).sh")
        try Data(body.utf8).write(to: url)
        return SetupScript(configured: url.path)!
    }

    private func collect(_ script: SetupScript, _ arguments: [String]) async -> (lines: [String], code: Int32?) {
        var splitter = LineSplitter()
        var lines: [String] = []
        var code: Int32?
        for await output in script.stream(arguments) {
            switch output {
            case .output(let data): lines += splitter.feed(data)
            case .exit(let status): lines += splitter.flush(); code = status
            }
        }
        return (lines, code)
    }

    // MARK: Runner

    @Test func environmentIsFixed() {
        let env = SetupScript.environment()
        #expect(env["PATH"] == "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(NSHomeDirectory())/.local/bin")
        #expect(env["HOME"] == NSHomeDirectory())
        #expect(env["HOME_COMPUTE_BAR_CONFIG"] == configURL.path)
    }

    @Test func readsStateEnvAndJobs() async throws {
        let state = try await fake.json(SetupState.self, ["state", "--json"])
        #expect(state.setup?.complete == false)
        #expect(state.services?.controller?.state == "stopped")
        #expect(state.isStopped)
        #expect(state.image?.freshness == .missing)

        let env = try await fake.json(EnvInfo.self, ["env", "--json"])
        #expect(env.values["S3_BUCKET"] == "force5-forecast")
        #expect(env.values["AWS_SECRET_ACCESS_KEY"] == nil)
        #expect(env.secrets["AWS_ACCESS_KEY_ID"]?.hint == "…ab12")

        let timetable = try await fake.json(Timetable.self, ["jobs", "--json"])
        #expect(timetable.jobs.map(\.id) == ["harmonie", "gfs", "ecmwf", "prune"])
    }

    @Test func secretsGoOnStdin() async throws {
        let reply = try await fake.reply(["env", "set", "AWS_SECRET_ACCESS_KEY"], input: "s3cr3t with spaces")
        #expect(reply.restartRequired == true)
        let stored = try String(contentsOf: dir.appending(path: "fake-setup/env"), encoding: .utf8)
        #expect(stored.contains("AWS_SECRET_ACCESS_KEY=s3cr3t with spaces\n"))
    }

    @Test func exitTwoIsAValidationError() async throws {
        await #expect(throws: ScriptError.validation("S3_ENDPOINT_URL must start with https://")) {
            try await self.fake.reply(["env", "set", "S3_ENDPOINT_URL"], input: "http://insecure")
        }
        await #expect(throws: ScriptError.validation("Minutes must be multiples of 5 between 0 and 55 (got 7)")) {
            try await self.fake.reply(["jobs", "set", "gfs", "--minutes", "0,7"])
        }
    }

    @Test func otherFailuresCarryStderr() async throws {
        do {
            _ = try await fake.json(ScriptReply.self, ["no-such-command"])
            Issue.record("expected a failure")
        } catch let error as ScriptError {
            #expect(error == .failed(code: 1, message: "fake-setup.sh: unknown command: no-such-command"))
        }
    }

    @Test func badOutputAndMissingScript() async throws {
        let script = try writeScript("echo 'not json'\n")
        await #expect(throws: ScriptError.badOutput("not json\n")) {
            try await script.json(ScriptReply.self, [])
        }
        let missing = SetupScript(configured: dir.appending(path: "nope.sh").path)!
        await #expect(throws: ScriptError.notFound(missing.path)) {
            try await missing.json(ScriptReply.self, [])
        }
        let (lines, code) = await collect(missing, ["start"])
        #expect(code == 127)
        #expect(lines.first?.hasPrefix("Setup script not found") == true)
    }

    @Test func jsonCommandsTimeOut() async throws {
        let script = try writeScript("sleep 30\n")
        let started = Date()
        await #expect(throws: ScriptError.timedOut(1)) {
            try await script.json(ScriptReply.self, [], timeout: 1)
        }
        #expect(Date().timeIntervalSince(started) < 10)
    }

    @Test func exitDoesNotWaitForInheritedPipes() async throws {
        // A background child keeps stdout open after the script exits (like a daemon would).
        let script = try writeScript("echo started\n(sleep 20) &\necho '{\"ok\": true}'\n")
        let started = Date()
        let reply = try await script.reply([])
        #expect(reply.ok == true)
        #expect(Date().timeIntervalSince(started) < 8)
    }

    @Test func streamsLongCommands() async throws {
        let (lines, code) = await collect(fake, ["setup"])
        #expect(code == 0)
        #expect(lines.first == "Checking deploy/local/jobs.toml")
        #expect(lines.contains("progress 100%"))
        #expect(lines.contains("doctor: Colima isn't running (warning)"))  // stderr is merged
        #expect(!lines.contains { $0.contains("\u{1B}") || $0.contains("\r") })
        #expect(lines.last == "Ready. Start it with: macmini.sh start")

        try touch("fail-image")
        let failed = await collect(fake, ["image"])
        #expect(failed.code == 1)
        #expect(failed.lines.last?.hasPrefix("ERROR: failed to solve") == true)
    }

    @Test func cancellingAStreamStopsTheScript() async throws {
        let script = try writeScript("echo one\nsleep 30\necho two\n")
        let started = Date()
        let task = Task { await self.collect(script, []) }
        try await Task.sleep(for: .milliseconds(500))
        task.cancel()
        let (lines, _) = await task.value
        #expect(lines == ["one"] || lines.isEmpty)
        #expect(Date().timeIntervalSince(started) < 10)
    }

    // MARK: Control store

    final class TestHost: ControlHost {
        var config: AppConfig
        var reconnects = 0

        init() { config = ConfigFile.load() }

        func updateConfig(_ config: AppConfig) throws {
            try ConfigFile.save(config)
            self.config = config.normalized
        }

        func reloadConfig() { config = ConfigFile.reload(keeping: config) }
        func reconnect() { reconnects += 1 }
    }

    private func waitFor(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(20)
        while !condition() {
            if Date() > deadline { Issue.record("timed out waiting"); return }
            try await Task.sleep(for: .milliseconds(50))
        }
    }

    @Test func storeRunsTheWholeFlow() async throws {
        let host = TestHost()
        #expect(host.config.setupScript == Self.fakePath)
        let control = ControlStore(host: host)

        await control.refreshAll()
        #expect(control.state?.isSetUp == false)
        #expect(control.env?.values["AWS_REGION"] == "auto")
        #expect(control.timetable?.jobs.count == 4)
        #expect(control.stateError == nil)

        // Setup, streamed, then everything reloads.
        let setup = try #require(control.start(.setup, showLog: true))
        #expect(control.showLog)
        #expect(control.start(.start) == nil)  // one long command at a time
        try await waitFor { !setup.isRunning && control.state?.isSetUp == true }
        #expect(setup.succeeded)
        #expect(setup.statusText == "Set up")
        #expect(control.state?.image?.freshness == .upToDate)

        // Saving values and a secret: restart needed; a bad value stops with a message.
        let saved = await control.saveEnv([("S3_BUCKET", "other-bucket"), ("AWS_ACCESS_KEY_ID", "NEWKEY9999")])
        #expect(saved.saved == ["S3_BUCKET", "AWS_ACCESS_KEY_ID"])
        #expect(saved.error == nil)
        #expect(control.restartPending)
        #expect(control.env?.values["S3_BUCKET"] == "other-bucket")
        #expect(control.env?.secrets["AWS_ACCESS_KEY_ID"]?.hint == "…9999")
        let failed = await control.saveEnv([("S3_PREFIX", "p/"), ("S3_ENDPOINT_URL", "ftp://x"), ("AWS_REGION", "eu")])
        #expect(failed.saved == ["S3_PREFIX"])
        #expect(failed.error == "S3_ENDPOINT_URL: S3_ENDPOINT_URL must start with https://")
        #expect(control.env?.values["AWS_REGION"] == "auto")

        // R2 test, good and bad.
        await control.testR2()
        #expect(control.r2Result?.ok == true)
        #expect(control.r2Result?.manifests.last?.missing == true)
        _ = await control.saveEnv([("S3_BUCKET", "bad")])
        await control.testR2()
        #expect(control.r2Result?.ok == false)
        #expect(control.r2Result?.error?.contains("NoSuchBucket") == true)

        // Timetable edits.
        #expect(await control.saveJob("gfs", arguments: ["--minutes", "0,7"]) == "Minutes must be multiples of 5 between 0 and 55 (got 7)")
        #expect(await control.saveJob("gfs", arguments: ["--hours", "every", "--minutes", "0,30"]) == nil)
        let gfs = try #require(control.timetable?.jobs.first { $0.id == "gfs" })
        #expect(gfs.hours == nil && gfs.minutes == [0, 30])

        // Token rotation rewrites menubar.json; the app reloads it and keeps other keys.
        #expect(await control.rotateToken() == nil)
        #expect(host.config.token.hasPrefix("fake-"))
        let file = try JSONSerialization.jsonObject(with: Data(contentsOf: configURL)) as? [String: Any]
        #expect(file?["keepMe"] as? Int == 42)
        #expect(file?["setupScript"] as? String == Self.fakePath)

        // Restarting the scheduler applies the changes.
        let restart = try #require(control.start(.restartController, showLog: false))
        #expect(!control.showLog)
        try await waitFor { !restart.isRunning && control.state?.services?.controller?.state == "running" }
        #expect(!control.restartPending)
        #expect(host.reconnects == 1)

        // Start, then the autostart toggle.
        control.start(.start)
        try await waitFor { control.run?.isRunning == false && control.state?.isStopped == false }
        control.start(.colimaAutostart(true))
        try await waitFor { control.state?.services?.colima?.autostart == true }
        control.dismissRun()
        #expect(control.run == nil)
    }

    @Test func reloadRestoresAScriptPathTheSetupDropped() throws {
        let host = TestHost()
        // What macmini.sh setup does today: rewrite the file with only url and token.
        try Data(#"{"url": "http://127.0.0.1:4786", "token": "new"}"#.utf8).write(to: configURL)
        host.reloadConfig()
        #expect(host.config.token == "new")
        #expect(host.config.setupScript == Self.fakePath)
        #expect(ConfigFile.load().setupScript == Self.fakePath)
    }
}
