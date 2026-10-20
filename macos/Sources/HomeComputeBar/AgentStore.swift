import AppKit
import Foundation
import Observation

/// The menu bar app's face for this Mac's agent (agent mode): it polls the agent's local status
/// API, tracks failures (a red dot, and a notification when asked for), and runs the actions.
@MainActor @Observable
final class AgentStore {
    static let shared = AgentStore(config: ConfigFile.load())

    enum Connection: Equatable {
        case connecting
        /// Not enrolled, no token, status API off: nothing to ask.
        case setup(String)
        /// Enrolled, but nothing answers: the agent is not running.
        case notRunning(String)
        case unauthorized
        case ok
    }

    private(set) var settings: AgentSettings
    private(set) var connection: Connection = .connecting
    private(set) var status: AgentStatus?
    private(set) var history: [AgentHistoryEntry] = []
    private(set) var lastUpdated: Date?
    private(set) var unseenFailures = 0
    private(set) var busy = false
    private(set) var iconFrame = 0
    var actionMessage: String?
    /// The run the history window shows; set by a click in the menu.
    var selectedRun: String?

    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var animationTask: Task<Void, Never>?
    @ObservationIgnored private var seenFailures: Set<String> = []
    @ObservationIgnored private var hasBaseline = false
    @ObservationIgnored private let notifier = Notifier()
    @ObservationIgnored private var refreshing = false

    static let busyInterval: Duration = .seconds(2)
    static let idleInterval: Duration = .seconds(5)
    static let historyLimit = 50

    /// false: never asks the agent (snapshot tests show a state they set).
    @ObservationIgnored private let live: Bool

    init(config: AppConfig, autostart: Bool = false, live: Bool = true) {
        settings = config.agent
        self.live = live
        if autostart { start() }
    }

    // MARK: Lifecycle

    func start() {
        guard pollTask == nil else { return }
        Log.info("agent mode: state \(settings.resolvedStateDir)")
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: (status?.running.isEmpty ?? true) ? AgentStore.idleInterval : AgentStore.busyInterval)
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        animationTask?.cancel()
        animationTask = nil
    }

    func update(_ new: AgentSettings) throws {
        var config = ConfigFile.load()
        config.agent = new
        try ConfigFile.save(config)
        settings = new
        hasBaseline = false
        seenFailures = []
        Task { await refresh() }
    }

    func markSeen() { unseenFailures = 0 }

    // MARK: Polling

    var client: AgentClient? {
        if case .success(let endpoint) = AgentEndpoint.resolve(settings) { return AgentClient(endpoint: endpoint) }
        return nil
    }

    func refresh() async {
        if refreshing || !live { return }
        refreshing = true
        defer { refreshing = false }
        switch AgentEndpoint.resolve(settings) {
        case .failure(let problem):
            setConnection(.setup(problem.localizedDescription))
            return
        case .success(let endpoint):
            let client = AgentClient(endpoint: endpoint)
            do {
                let status = try await client.status()
                let history = try await client.history(limit: AgentStore.historyLimit)
                apply(status: status, history: history)
            } catch is CancellationError {
                return
            } catch AgentAPIError.unauthorized {
                setConnection(.unauthorized)
            } catch AgentAPIError.notRunning(let detail) {
                setConnection(.notRunning(detail))
            } catch {
                setConnection(.notRunning(error.localizedDescription))
            }
        }
    }

    /// The connection state; also how snapshot tests show one without asking anything.
    func setConnection(_ new: Connection) {
        if new != connection { Log.info("agent: \(new)") }
        connection = new
        if new != .ok { status = nil }
        updateAnimation()
    }

    /// A fresh answer: the new state, and a failure count (and notification) for runs that failed since the last one.
    func apply(status: AgentStatus, history: [AgentHistoryEntry], now: Date = .now) {
        if connection != .ok { Log.info("agent answers: \(status.name ?? "?"), \(status.connection ?? "?"), \(status.running.count) running") }
        self.status = status
        self.history = history
        connection = .ok
        lastUpdated = now
        let fresh = AgentStore.newFailures(in: history, seen: seenFailures)
        seenFailures.formUnion(fresh.map(\.run))
        if hasBaseline {
            for entry in fresh {
                unseenFailures += 1
                if settings.notifyOnFailure {
                    notifier.post(id: "agent-failed-\(entry.run)", title: "\(entry.job) failed on \(status.name ?? "this Mac")", body: entry.error ?? entry.outcomeText)
                }
            }
        }
        hasBaseline = true
        updateAnimation()
    }

    /// Failed runs not seen before, oldest first.
    nonisolated static func newFailures(in history: [AgentHistoryEntry], seen: Set<String>) -> [AgentHistoryEntry] {
        history.filter { $0.isFailed && !seen.contains($0.run) }.reversed()
    }

    // MARK: Icon

    enum IconState: Equatable {
        case idle, running([String]), paused, offline, notRunning, setup
    }

    var iconState: IconState { AgentStore.iconState(connection: connection, status: status) }

    nonisolated static func iconState(connection: Connection, status: AgentStatus?) -> IconState {
        switch connection {
        case .connecting: return .idle
        case .setup: return .setup
        case .notRunning, .unauthorized: return .notRunning
        case .ok: break
        }
        guard let status else { return .idle }
        let jobs = status.running.map(\.job)
        if !jobs.isEmpty { return .running(jobs) }
        if !status.connected { return .offline }
        if status.paused || status.serverDrain == true || status.draining { return .paused }
        return .idle
    }

    var iconSymbol: String {
        switch iconState {
        case .idle: "shippingbox"
        case .running: iconFrame % 2 == 0 ? "shippingbox.fill" : "shippingbox"
        case .paused: "pause.circle"
        case .offline: "icloud.slash"
        case .notRunning: "exclamationmark.triangle"
        case .setup: "shippingbox"
        }
    }

    /// The text beside the icon while a job runs: its name, "+1" for each more.
    var iconTitle: String? { AgentStore.iconTitle(iconState) }

    nonisolated static func iconTitle(_ state: IconState) -> String? {
        guard case .running(let jobs) = state, let first = jobs.first else { return nil }
        let name = first.count > 18 ? String(first.prefix(17)) + "…" : first
        return jobs.count > 1 ? "\(name) +\(jobs.count - 1)" : name
    }

    private func updateAnimation() {
        if case .running = iconState {
            guard animationTask == nil else { return }
            animationTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(900))
                    iconFrame &+= 1
                }
            }
        } else {
            animationTask?.cancel()
            animationTask = nil
            iconFrame = 0
        }
    }

    // MARK: Actions

    private func act(_ name: String, _ work: @escaping @Sendable (AgentClient) async throws -> AgentStatus) async {
        guard let client else {
            actionMessage = "\(name): the agent's status API is not set up."
            return
        }
        busy = true
        defer { busy = false }
        do {
            let answer = try await work(client)
            status = answer
            actionMessage = nil
            Log.info("agent \(name): ok")
        } catch {
            actionMessage = "\(name): \(error.localizedDescription)"
            Log.info("agent \(name) failed: \(error.localizedDescription)")
        }
        await refresh()
    }

    func setPaused(_ paused: Bool) async {
        await act(paused ? "Pause" : "Resume") { paused ? try await $0.pause() : try await $0.resume() }
    }

    func setDraining(_ draining: Bool) async {
        await act(draining ? "Restart when idle" : "Cancel restart") { try await $0.drain(draining) }
    }

    /// Restarts the agent through its API; when it does not answer, kickstarts its LaunchAgent
    /// (only the configured label: a development agent's settings name none).
    func restart() async {
        if case .ok = connection {
            await act("Restart agent") { try await $0.restart() }
            return
        }
        guard let label = settings.restartLabel else {
            actionMessage = "The agent does not answer, and no LaunchAgent is set for it in Settings, so nothing was restarted."
            return
        }
        busy = true
        defer { busy = false }
        let target = "gui/\(getuid())/\(label)"
        let result = await Self.run("/bin/launchctl", ["kickstart", "-k", target])
        actionMessage = result.status == 0 ? nil : "launchctl kickstart -k \(target) failed: \(result.output.isEmpty ? "exit \(result.status)" : result.output)"
        Log.info("kickstart \(target): \(result.status)")
        try? await Task.sleep(for: .seconds(2))
        await refresh()
    }

    nonisolated private static func run(_ tool: String, _ arguments: [String]) async -> (status: Int32, output: String) {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(filePath: tool)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.terminationHandler = { finished in
                let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
                continuation.resume(returning: (finished.terminationStatus, output.trimmingCharacters(in: .whitespacesAndNewlines)))
            }
            do {
                try process.run()
            } catch {
                continuation.resume(returning: (-1, error.localizedDescription))
            }
        }
    }

    // MARK: Opening things

    /// The dashboard: the address in Settings, else the one the agent reports (hc-core's DASHBOARD_URL).
    var dashboardURL: URL? {
        let configured = settings.dashboardUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        let text = configured.isEmpty ? (status?.dashboardUrl ?? "") : configured
        guard let url = URL(string: text), ["http", "https"].contains(url.scheme ?? ""), url.host() != nil else { return nil }
        return url
    }

    /// The dashboard at `route` (`#/run/<id>`, `#/machine/<id>`), or at its overview.
    func openDashboard(route: String? = nil) {
        guard let base = dashboardURL else {
            actionMessage = "The agent does not know the dashboard's address yet; set it in Settings › Agent."
            return
        }
        var components = URLComponents(url: base, resolvingAgainstBaseURL: false)
        if let route, route.hasPrefix("#/") { components?.fragment = String(route.dropFirst()) }
        NSWorkspace.shared.open(components?.url ?? base)
    }

    func openRun(_ run: String) { openDashboard(route: "#/run/\(run)") }

    func openMachine() { openDashboard(route: status?.machineId.map { "#/machine/\($0)" }) }

    /// The agent's log file: from Settings, else what the agent reports, else the LaunchAgent's agent.log.
    var logFileURL: URL? {
        let candidates = [settings.logFile, status?.logFile ?? "", AgentSettings.defaultLogFile]
            .map { ($0 as NSString).expandingTildeInPath.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return candidates.first { FileManager.default.fileExists(atPath: $0) }.map { URL(filePath: $0) }
    }

    /// Opens the log in Console (it follows the file as it grows).
    func openLog() {
        guard let url = logFileURL else {
            actionMessage = "No agent log found\(status?.logHint.map { "; it logs to \($0)" } ?? " at \(AgentSettings.defaultLogFile)")."
            return
        }
        if let console = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Console") {
            NSWorkspace.shared.open([url], withApplicationAt: console, configuration: NSWorkspace.OpenConfiguration())
        } else {
            NSWorkspace.shared.open(url)
        }
    }
}
