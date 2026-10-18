import AppKit
import Foundation
import Observation
import UserNotifications

@MainActor @Observable
final class Store {
    static let shared = Store()

    enum Connection: Equatable {
        case connecting
        case online
        case unauthorized
        case unreachable(String)
    }

    private(set) var config: AppConfig
    private(set) var snapshot: Snapshot?
    private(set) var connection: Connection = .connecting
    private(set) var lastUpdated: Date?
    private(set) var isRefreshing = false
    private(set) var streamConnected = false
    private(set) var unseenFailures = 0
    private(set) var busyJobs: Set<String> = []
    private(set) var iconFrame = 0
    var actionMessage: String?

    @ObservationIgnored private var pollTask: Task<Void, Never>?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var animationTask: Task<Void, Never>?
    @ObservationIgnored private var refreshQueued = false
    @ObservationIgnored private var streamBackoff: Double = 1
    @ObservationIgnored private var seenFinishes: Set<String> = []
    @ObservationIgnored private var hasBaseline = false
    @ObservationIgnored private let notifier = Notifier()

    static let pollInterval: Duration = .seconds(15)

    private init() {
        signal(SIGPIPE, SIG_IGN)
        config = ConfigFile.load()
        Log.info("starting; config \(ConfigFile.url.path) -> \(config.url) (token \(config.token.isEmpty ? "missing" : "set"))")
        // Agent mode never asks the old controller anything.
        if config.resolvedMode == .controller { start() }
    }

    /// Polls the controller (controller mode) or stops (agent mode).
    func setActive(_ active: Bool) {
        if active, pollTask == nil {
            start()
        } else if !active, pollTask != nil {
            pollTask?.cancel()
            streamTask?.cancel()
            pollTask = nil
            streamTask = nil
            updateAnimation()
        }
    }

    // MARK: Derived state

    var jobs: [Job] { snapshot?.jobs ?? [] }
    var runningJobs: [Job] { jobs.filter(\.isRunning) }

    var iconSymbol: String {
        switch connection {
        case .unreachable, .unauthorized: return "icloud.slash"
        case .connecting, .online: break
        }
        guard !runningJobs.isEmpty else { return "cloud.sun" }
        let frames = ["cloud", "cloud.drizzle", "cloud.rain", "cloud.heavyrain"]
        return frames[iconFrame % frames.count]
    }

    private var client: APIClient { APIClient(baseURL: config.url, token: config.token) }

    // MARK: Lifecycle

    private func start() {
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: Store.pollInterval)
            }
        }
        streamTask = Task {
            while !Task.isCancelled {
                do {
                    try await client.streamEvents { event in await self.handle(event) }
                    Log.info("event stream closed by server")
                } catch {
                    if Task.isCancelled { return }
                    Log.info("event stream error: \(error.localizedDescription)")
                }
                streamConnected = false
                try? await Task.sleep(for: .seconds(streamBackoff))
                streamBackoff = min(streamBackoff * 2, 60)
            }
        }
    }

    private func restart() {
        guard pollTask != nil else { return }
        pollTask?.cancel()
        streamTask?.cancel()
        snapshot = nil
        connection = .connecting
        streamConnected = false
        streamBackoff = 1
        seenFinishes = []
        hasBaseline = false
        updateAnimation()
        start()
    }

    func updateConfig(_ new: AppConfig) throws {
        let new = new.normalized
        try ConfigFile.save(new)
        let reconnect = new.url != config.url || new.token != config.token
        config = new
        Log.info("config saved to \(ConfigFile.url.path)")
        if reconnect { restart() }
    }

    /// Picks up changes another program made to menubar.json (the setup script writes the token).
    func reloadConfig() {
        let loaded = ConfigFile.reload(keeping: config)
        let reconnect = loaded.url != config.url || loaded.token != config.token
        config = loaded
        if reconnect {
            Log.info("config changed on disk; reconnecting")
            restart()
        }
    }

    /// Reconnects at once (after the scheduler was started), skipping the stream's backoff.
    func reconnect() { restart() }

    func markSeen() { unseenFailures = 0 }

    // MARK: Snapshot

    func refresh() async {
        if isRefreshing { refreshQueued = true; return }
        isRefreshing = true
        defer { isRefreshing = false }
        repeat {
            refreshQueued = false
            let client = self.client
            do {
                apply(try await client.snapshot())
            } catch is CancellationError {
                return
            } catch APIError.unauthorized {
                connection = .unauthorized
                Log.info("snapshot failed: unauthorized")
            } catch {
                connection = .unreachable(error.localizedDescription)
                Log.info("snapshot failed: \(error.localizedDescription)")
            }
        } while refreshQueued
    }

    private func apply(_ new: Snapshot) {
        let wasOnline = connection == .online
        snapshot = new
        connection = .online
        lastUpdated = .now
        if !wasOnline || !hasBaseline {
            Log.info("snapshot ok: \(new.jobs.count) jobs, \(new.runningCount) running, \(new.nodeCount ?? 0) nodes, controller \(new.controller?.status ?? "?")")
        }

        // Catch finishes the event stream missed (e.g. while it was reconnecting).
        for job in new.jobs {
            guard let key = job.lastFinishedJobId else { continue }
            if seenFinishes.insert(key).inserted, hasBaseline {
                finished(job: job.id, outcome: job.outcome, detail: job.failureDetail)
            }
        }
        hasBaseline = true
        updateAnimation()
    }

    // MARK: Events

    private func handle(_ event: ServerEvent) async {
        let payload = try? JSONDecoder().decode(EventPayload.self, from: event.data)
        Log.info("event \(event.name)\(payload?.job.map { " job=\($0)" } ?? "")\(payload?.outcome.map { " outcome=\($0)" } ?? "")")
        switch event.name {
        case "ready":
            streamConnected = true
            streamBackoff = 1
        case "job_finished":
            if let payload, let job = payload.job {
                let key = payload.bacalhauJobId ?? "\(job)@\(Date.now.timeIntervalSince1970)"
                if seenFinishes.insert(key).inserted {
                    let outcome = payload.outcome?.lowercased() ?? (payload.state?.lowercased() == "failed" ? "failed" : nil)
                    let errors = (payload.reports ?? []).compactMap(\.error) + [payload.error].compactMap { $0 }
                    finished(job: job, outcome: outcome, detail: errors.joined(separator: "\n"))
                }
            }
        default:
            break
        }
        await refresh()
    }

    private func finished(job: String, outcome: String?, detail: String) {
        switch outcome {
        case "failed":
            unseenFailures += 1
            notifier.post(id: "failed-\(job)-\(UUID().uuidString)", title: "\(job) failed",
                          body: detail.isEmpty ? "The forecast job did not complete." : detail)
        case "published" where config.notifyOnPublished:
            notifier.post(id: "published-\(job)-\(UUID().uuidString)", title: "\(job) published",
                          body: "A new forecast run was published.")
        default:
            break
        }
    }

    // MARK: Actions

    func perform(_ action: JobAction, job: String) async {
        busyJobs.insert(job)
        defer { busyJobs.remove(job) }
        do {
            try await client.perform(action, job: job)
            actionMessage = nil
            Log.info("\(action.rawValue) \(job): accepted")
        } catch {
            actionMessage = "\(action.title) \(job): \(error.localizedDescription)"
            Log.info("\(action.rawValue) \(job) failed: \(error.localizedDescription)")
        }
        await refresh()
    }

    // MARK: Dashboard

    /// Opens the controller's web dashboard in the default browser, signed in through a one-time
    /// link when the controller can mint one, else at its plain address (which then asks for the token).
    func openDashboard(route: String? = nil) async {
        let client = self.client
        var url: URL?
        do {
            url = try await client.dashboardLink(page: route)
        } catch {
            Log.info("dashboard link failed: \(error.localizedDescription); opening the plain address")
        }
        if url == nil, let base = DashboardURL.base(config.url) {
            url = route.flatMap { URL(string: base.absoluteString + $0) } ?? base
        }
        guard let url else {
            actionMessage = APIError.invalidURL(config.url).localizedDescription
            return
        }
        NSWorkspace.shared.open(url)
    }

    // MARK: Icon animation

    private func updateAnimation() {
        if runningJobs.isEmpty || connection != .online {
            animationTask?.cancel()
            animationTask = nil
            iconFrame = 0
        } else if animationTask == nil {
            animationTask = Task {
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(450))
                    iconFrame &+= 1
                }
            }
        }
    }
}

extension Snapshot {
    var runningCount: Int { jobs.filter(\.isRunning).count }
}

/// Posts user notifications. UNUserNotificationCenter needs a real app bundle,
/// so this is a no-op (log only) when running as a bare `swift run` binary.
@MainActor
final class Notifier {
    private var authorized: Bool?
    private let delegate = NotificationDelegate()

    static var isAvailable: Bool { Bundle.main.bundleIdentifier != nil }

    func post(id: String, title: String, body: String) {
        Log.info("notify: \(title)")
        guard Notifier.isAvailable else { return }
        Task {
            let center = UNUserNotificationCenter.current()
            center.delegate = delegate
            if authorized == nil {
                authorized = (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
            }
            guard authorized == true else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            content.sound = .default
            do {
                try await center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
            } catch {
                Log.info("notification failed: \(error.localizedDescription)")
            }
        }
    }
}

final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate, Sendable {
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
