import Foundation

// Snapshot types for GET /v1/snapshot. Every field is optional and decoded
// leniently: a missing or oddly typed field never fails the whole snapshot.

struct Snapshot: Decodable, Sendable {
    var version: Int?
    var generatedAt: Date?
    var controller: Controller?
    var nodeCount: Int?
    var nodes: [Node] = []
    var jobs: [Job] = []

    private enum CodingKeys: String, CodingKey { case version, generatedAt, controller, nodeCount, nodes, jobs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.lenient(.version)
        generatedAt = c.date(.generatedAt)
        controller = c.lenient(.controller)
        nodes = c.lenient(.nodes) ?? []
        nodeCount = c.lenient(.nodeCount) ?? nodes.count
        jobs = (c.lenient(.jobs) as [Job]?)?.filter { !$0.id.isEmpty } ?? []
    }
}

struct Controller: Decodable, Sendable {
    var status: String?
    var pollEvery: String?
    var clusterError: String?
    /// What this controller can do ("history", "logs", "reload", "timetable"); nil from older ones.
    var features: [String]?
}

extension Snapshot {
    /// Every job's finished runs, newest first: what the menu shows under "Recent runs".
    func recentRuns(limit: Int = 5) -> [RunSummary] {
        let finished = jobs.flatMap { job in
            (job.recentRuns ?? []).filter(\.isFinished).map { run in
                var run = run
                if run.job.isEmpty { run.job = job.id }
                return run
            }
        }
        return Array(finished.sorted { ($0.finishedAt ?? .distantPast) > ($1.finishedAt ?? .distantPast) }.prefix(limit))
    }

    /// Whether the controller serves the browser dashboard (and keeps run history).
    var hasDashboard: Bool { controller?.features?.contains("history") == true }
}

struct Node: Decodable, Sendable {
    var connection: String?
    var nodeID: String?

    private enum CodingKeys: String, CodingKey { case Connection, Info }
    private enum InfoKeys: String, CodingKey { case NodeID }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        connection = c.string(.Connection)
        nodeID = (try? c.nestedContainer(keyedBy: InfoKeys.self, forKey: .Info))?.string(.NodeID)
    }
}

struct Schedule: Decodable, Sendable {
    struct At: Decodable, Sendable {
        var hours: [Int]?
        var minutes: [Int]?
    }
    var every: String?
    var at: At?
    var cron: String?
    var timezone: String?

    private enum CodingKeys: String, CodingKey { case every, at, cron, timezone }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        every = c.string(.every)
        at = c.lenient(.at)
        cron = c.string(.cron)
        timezone = c.string(.timezone)
    }
}

struct Report: Decodable, Sendable {
    var event: String?
    var model: String?
    var run: String?
    var seconds: Double?
    var error: String?

    private enum CodingKeys: String, CodingKey { case event, model, run, seconds, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        event = c.string(.event)
        model = c.string(.model)
        run = c.string(.run)
        seconds = c.double(.seconds)
        error = c.string(.error)
    }
}

struct PublishedRun: Decodable, Sendable {
    var run: String?
    var at: Date?
    var seconds: Double?

    private enum CodingKeys: String, CodingKey { case run, at, seconds }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        run = c.string(.run)
        at = c.date(.at)
        seconds = c.double(.seconds)
    }
}

/// One run from a job's history (`recentRuns` in the snapshot; reports left out).
struct RunSummary: Decodable, Sendable, Identifiable {
    var id = ""
    var job = ""
    var state: String?
    var outcome: String?
    var exitCode: Int?
    var error: String?
    var submittedAt: Date?
    var startedAt: Date?
    var finishedAt: Date?
    var durationSeconds: Double?
    var queueSeconds: Double?
    var peakMemoryMb: Double?

    private enum CodingKeys: String, CodingKey {
        case id, job, state, outcome, exitCode, error, submittedAt, startedAt, finishedAt, durationSeconds, queueSeconds, metrics
    }
    private enum MetricKeys: String, CodingKey { case peakMemoryMb }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? ""
        job = c.string(.job) ?? ""
        state = c.string(.state)
        outcome = c.string(.outcome)
        exitCode = c.lenient(.exitCode)
        error = c.string(.error)
        submittedAt = c.date(.submittedAt)
        startedAt = c.date(.startedAt)
        finishedAt = c.date(.finishedAt)
        durationSeconds = c.double(.durationSeconds)
        queueSeconds = c.double(.queueSeconds)
        peakMemoryMb = (try? c.nestedContainer(keyedBy: MetricKeys.self, forKey: .metrics))?.double(.peakMemoryMb)
    }

    var isFinished: Bool { finishedAt != nil }
    var isFailed: Bool { outcome?.lowercased() == "failed" }
}

struct Job: Decodable, Sendable, Identifiable {
    var id = ""
    var enabled: Bool?
    var paused: Bool?
    var schedule: Schedule?
    var labels: [String: String]?
    var parameters: [String]?
    var description: String?
    var running: Bool?
    var activeJobId: String?
    var liveState: String?
    var lastSubmittedAt: Date?
    var lastFinishedAt: Date?
    var lastFinishedState: String?
    var lastFinishedJobId: String?
    var lastExitCode: Int?
    var lastOutcome: String?
    var lastSubmissionError: String?
    var lastSubmissionErrorAt: Date?
    var nextDueAt: Date?
    var lastReports: [Report]?
    var published: [String: PublishedRun]?
    /// Newest first; absent from controllers that keep no history.
    var recentRuns: [RunSummary]?

    private enum CodingKeys: String, CodingKey {
        case id, enabled, paused, schedule, labels, parameters, description, running, activeJobId, liveState
        case lastSubmittedAt, lastFinishedAt, lastFinishedState, lastFinishedJobId, lastExitCode, lastOutcome
        case lastSubmissionError, lastSubmissionErrorAt, nextDueAt, lastReports, published, recentRuns
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? ""
        enabled = c.lenient(.enabled)
        paused = c.lenient(.paused)
        schedule = c.lenient(.schedule)
        labels = c.lenient(.labels)
        parameters = c.lenient(.parameters)
        description = c.string(.description)
        running = c.lenient(.running)
        activeJobId = c.string(.activeJobId)
        liveState = c.string(.liveState)
        lastSubmittedAt = c.date(.lastSubmittedAt)
        lastFinishedAt = c.date(.lastFinishedAt)
        lastFinishedState = c.string(.lastFinishedState)
        lastFinishedJobId = c.string(.lastFinishedJobId)
        lastExitCode = c.lenient(.lastExitCode)
        lastOutcome = c.string(.lastOutcome)
        lastSubmissionError = c.string(.lastSubmissionError)
        lastSubmissionErrorAt = c.date(.lastSubmissionErrorAt)
        nextDueAt = c.date(.nextDueAt)
        lastReports = c.lenient(.lastReports)
        published = c.lenient(.published)
        recentRuns = (c.lenient(.recentRuns) as [RunSummary]?)?.filter { !$0.id.isEmpty }
    }

    var isPaused: Bool { paused == true }

    /// Switched off in the timetable. The snapshot's `enabled` is also false while paused, so a pause is not "off".
    var isOff: Bool { enabled == false && !isPaused }

    /// `running` wins when present; otherwise fall back to the live Bacalhau state, then to an active job id.
    var isRunning: Bool {
        if let running { return running }
        if let liveState { return Job.activeStates.contains(liveState.lowercased()) }
        return activeJobId != nil
    }

    static let activeStates: Set<String> = ["queued", "pending", "running"]

    var models: [String] {
        if let raw = labels?["models"] {
            return raw.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }
        if let params = parameters, let i = params.firstIndex(of: "--models"), i + 1 < params.count {
            return params[i + 1].split(separator: ",").map(String.init)
        }
        return published.map { $0.keys.sorted() } ?? []
    }

    /// Normalised outcome: the controller's `lastOutcome`, else derived from the Bacalhau end state.
    var outcome: String? {
        if let lastOutcome { return lastOutcome.lowercased() }
        switch lastFinishedState?.lowercased() {
        case "failed", "error": return "failed"
        case "completed": return "completed"
        case "stopped", "cancelled", "canceled": return "stopped"
        default: return nil
        }
    }

    /// A submission error newer than the last finish (the job never started).
    var pendingSubmissionError: String? {
        guard let lastSubmissionError else { return nil }
        if let at = lastSubmissionErrorAt, let finished = lastFinishedAt, finished > at { return nil }
        return lastSubmissionError
    }

    var failureDetail: String {
        var lines = (lastReports ?? []).compactMap { r -> String? in
            guard let error = r.error else { return nil }
            return [r.model, r.run].compactMap { $0 }.joined(separator: " ") + ": " + error
        }
        if let pendingSubmissionError { lines.append("Submission: \(pendingSubmissionError)") }
        if let state = lastFinishedState { lines.append("Bacalhau state: \(state)") }
        if let code = lastExitCode { lines.append("Exit code: \(code)") }
        return lines.joined(separator: "\n")
    }
}

/// Payload of an SSE `data:` line (all event kinds share these fields).
struct EventPayload: Decodable, Sendable {
    var job: String?
    var bacalhauJobId: String?
    var state: String?
    var outcome: String?
    var error: String?
    var reports: [Report]?

    private enum CodingKeys: String, CodingKey { case job, bacalhauJobId, state, outcome, error, reports }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        job = c.string(.job)
        bacalhauJobId = c.string(.bacalhauJobId)
        state = c.string(.state)
        outcome = c.string(.outcome)
        error = c.string(.error)
        reports = c.lenient(.reports)
    }
}

// MARK: - Lenient decoding helpers

extension KeyedDecodingContainer {
    func lenient<T: Decodable>(_ key: Key) -> T? {
        (try? decodeIfPresent(T.self, forKey: key)) ?? nil
    }

    func string(_ key: Key) -> String? {
        if let s: String = lenient(key) { return s }
        if let i: Int = lenient(key) { return String(i) }
        if let d: Double = lenient(key) { return String(d) }
        return nil
    }

    func double(_ key: Key) -> Double? {
        if let d: Double = lenient(key) { return d }
        return string(key).flatMap(Double.init)
    }

    func date(_ key: Key) -> Date? { ISODate.parse(string(key)) }
}

enum ISODate {
    private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let plain = Date.ISO8601FormatStyle()

    static func parse(_ string: String?) -> Date? {
        guard let string, !string.isEmpty else { return nil }
        return (try? fractional.parse(string)) ?? (try? plain.parse(string))
    }
}
