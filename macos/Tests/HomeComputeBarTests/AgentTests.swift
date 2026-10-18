import Foundation
import Testing
@testable import HomeComputeBar

/// Agent mode: decoding the agent's status API, the menu bar icon, failure tracking, and how
/// the app finds the API (port and token) without ever restarting a real agent by mistake.
@MainActor
struct AgentTests {
    @Test func decodesARunningAgent() throws {
        let status = try AgentFixtures.decode(AgentStatus.self, AgentFixtures.statusRunning)
        #expect(status.name == "status-demo")
        #expect(status.connected && status.claiming && !status.paused)
        #expect(status.dashboardUrl?.hasPrefix("http://127.0.0.1:") == true)
        #expect(status.logFile == "/tmp/hc-status-demo/agent.log")
        #expect(status.running.map(\.job) == ["gfs", "wind-obs"])
        let gfs = try #require(status.running.first)
        #expect(gfs.phaseText == "Running")
        #expect(gfs.cpuPct == 72)
        #expect(gfs.since == ISODate.parse("2026-10-18T15:24:15.182Z"))
        #expect(gfs.statsText?.hasPrefix("CPU 72% · ") == true)
        #expect(gfs.statsText?.contains(" of ") == true, "memory with its limit")
    }

    @Test func decodesHistoryWithPassesFailuresAndACancel() throws {
        let runs = try AgentFixtures.decode(AgentHistory.self, AgentFixtures.history).runs
        #expect(runs.map(\.job) == ["gfs", "wind-obs", "icon-eu", "harmonie"])
        #expect(runs.map(\.mark) == ["✓", "–", "✓", "✗"])
        #expect(runs[2].outcomeText == "Published icon-eu 2026101806")
        #expect(runs[1].outcomeText == "Cancelled")
        let failed = runs[3]
        #expect(failed.isFailed && failed.exitCode == 1 && failed.outcomeText == "Exit 1")
        #expect(failed.error?.contains("503 Server Error") == true)
        #expect(failed.helpText.contains("Traceback (most recent call last):"), "the hover shows the detail")
        #expect(failed.reportedState == "failed")
        #expect(runs[0].duration == 120.002)
    }

    @Test func oddAnswersDecodeLeniently() throws {
        // An agent before 0.3 has only `drain` for the pause switch, and no `current`.
        let old = try AgentFixtures.decode(AgentStatus.self, #"{"connection": "online", "drain": true, "runs": [], "outbox": "x"}"#)
        #expect(old.paused && old.connected && old.current.isEmpty && old.outbox == 0 && old.statusApi == nil)
        // Its runs, from `runs`, for the icon and Running now.
        let busy = try AgentFixtures.decode(AgentStatus.self, #"{"connection": "online", "runs": [{"id": "r_1", "job": "gfs", "phase": "running", "since": "2026-10-18T15:00:00Z", "waitingToReport": false}]}"#)
        #expect(busy.running.map(\.job) == ["gfs"])
        #expect(busy.running.first?.since == ISODate.parse("2026-10-18T15:00:00Z"))
        let history = try AgentFixtures.decode(AgentHistory.self, #"{"runs": [{"run": "", "job": "x"}, {"run": "r_1", "outcome": "failed", "exitCode": "7"}]}"#)
        #expect(history.runs.count == 1, "a run without an id is dropped")
        #expect(history.runs[0].isFailed && history.runs[0].exitCode == nil)
    }

    @Test func iconFollowsTheAgent() throws {
        let running = try AgentFixtures.decode(AgentStatus.self, AgentFixtures.statusRunning)
        let idle = try AgentFixtures.decode(AgentStatus.self, AgentFixtures.statusIdle)
        #expect(AgentStore.iconState(connection: .ok, status: running) == .running(["gfs", "wind-obs"]))
        #expect(AgentStore.iconTitle(.running(["gfs", "wind-obs"])) == "gfs +1")
        #expect(AgentStore.iconTitle(.running(["a-very-long-job-name-indeed"])) == "a-very-long-job-n…")
        #expect(AgentStore.iconTitle(.idle) == nil)
        #expect(AgentStore.iconState(connection: .ok, status: idle) == .idle)
        #expect(AgentStore.iconState(connection: .ok, status: try AgentFixtures.status { $0["paused"] = true }) == .paused)
        #expect(AgentStore.iconState(connection: .ok, status: try AgentFixtures.status { $0["serverDrain"] = true }) == .paused)
        #expect(AgentStore.iconState(connection: .ok, status: try AgentFixtures.status { $0["connected"] = false }) == .offline)
        #expect(AgentStore.iconState(connection: .notRunning("refused"), status: nil) == .notRunning)
        #expect(AgentStore.iconState(connection: .setup("not enrolled"), status: nil) == .setup)
        let reasons = try AgentFixtures.status { $0["notClaimingBecause"] = ["drained-on-dashboard", "full"]; $0.removeValue(forKey: "claiming") }
        #expect(reasons.notClaimingText == "Drained from the dashboard")
        #expect(!reasons.claiming)
    }

    @Test func failuresAreCountedOnceAndOnlyAfterTheFirstAnswer() throws {
        let status = try AgentFixtures.decode(AgentStatus.self, AgentFixtures.statusIdle)
        let history = try AgentFixtures.decode(AgentHistory.self, AgentFixtures.history).runs
        let store = AgentStore(config: AppConfig())
        store.apply(status: status, history: history)
        #expect(store.unseenFailures == 0, "failures from before the app started are not news")
        #expect(store.connection == .ok)
        let fresh = AgentHistoryEntry(run: "r_new", job: "ecmwf", outcome: "failed", passed: false, finishedAt: .now, error: "HTTP 500")
        store.apply(status: status, history: [fresh] + history)
        store.apply(status: status, history: [fresh] + history)
        #expect(store.unseenFailures == 1)
        store.markSeen()
        #expect(store.unseenFailures == 0)
        #expect(AgentStore.newFailures(in: [fresh] + history, seen: []).map(\.run) == [history[3].run, "r_new"], "oldest first")
    }

    @Test func findsThePortAndTokenInTheStateDirectory() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "hcb-agent-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        var settings = AgentSettings()
        settings.stateDir = dir.path
        #expect(AgentEndpoint.resolve(settings) == .failure(.notEnrolled(dir.path)))
        try Data(#"{"statusPort": 4797}"#.utf8).write(to: dir.appending(path: "config.json"))
        #expect(AgentEndpoint.resolve(settings) == .failure(.noToken(dir.appending(path: "status-token").path)))
        try Data("abc123\n".utf8).write(to: dir.appending(path: "status-token"))
        let endpoint = try AgentEndpoint.resolve(settings).get()
        #expect(endpoint.baseURL.absoluteString == "http://127.0.0.1:4797")
        #expect(endpoint.token == "abc123")
        try Data(#"{"statusPort": 0}"#.utf8).write(to: dir.appending(path: "config.json"))
        #expect(AgentEndpoint.resolve(settings) == .failure(.statusOff))
        try Data(#"{"server": "x"}"#.utf8).write(to: dir.appending(path: "config.json"))
        #expect(try AgentEndpoint.resolve(settings).get().baseURL.port == 4787, "the default port")

        // Another user's agent: no readable state directory, a port and a copy of the token.
        var other = AgentSettings()
        other.stateDir = dir.appending(path: "missing").path
        other.port = 4801
        other.tokenFile = dir.appending(path: "status-token").path
        #expect(try AgentEndpoint.resolve(other).get().baseURL.absoluteString == "http://127.0.0.1:4801")
    }

    @Test func restartNeverKickstartsTheRealAgentForADevelopmentOne() {
        var settings = AgentSettings()
        #expect(settings.usesDefaultStateDir)
        #expect(settings.restartLabel == "dev.homecompute.agent")
        settings.stateDir = "/tmp/hc-status-demo/agent"
        #expect(settings.restartLabel == nil, "a development agent's settings name no LaunchAgent")
        settings.launchdLabel = "dev.homecompute.agent-test"
        #expect(settings.restartLabel == "dev.homecompute.agent-test")
        settings.stateDir = ""
        settings.launchdLabel = "-"
        #expect(settings.restartLabel == nil, "\"-\" turns it off")
    }

    @Test func settingsRoundTripThroughMenubarJSON() {
        var settings = AgentSettings()
        settings.stateDir = " /tmp/a "
        settings.port = 4797
        settings.notifyOnFailure = true
        let dict = settings.dictionary
        #expect(dict["stateDir"] as? String == "/tmp/a")
        #expect(dict["tokenFile"] == nil, "empty fields are left out")
        let back = AgentSettings().read(dict)
        #expect(back.stateDir == "/tmp/a" && back.port == 4797 && back.notifyOnFailure)

        var config = AppConfig()
        config.mode = .controller
        #expect(config.resolvedMode == .controller)
        config.mode = nil
        config.agent.stateDir = "/nonexistent-\(UUID().uuidString)"
        #expect(config.resolvedMode == .controller, "not enrolled: the controller")
    }

    @Test func dashboardAndLogComeFromSettingsElseTheAgent() throws {
        let store = AgentStore(config: AppConfig())
        #expect(store.dashboardURL == nil)
        store.apply(status: try AgentFixtures.decode(AgentStatus.self, AgentFixtures.statusIdle), history: [])
        #expect(store.dashboardURL?.absoluteString.hasPrefix("http://127.0.0.1:") == true)
        #expect(store.iconSymbol == "shippingbox")
    }
}
