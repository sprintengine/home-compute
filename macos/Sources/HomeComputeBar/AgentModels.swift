import Foundation

// The local agent's status API (agent/README.md, "Local status API"): GET /v1/status and
// GET /v1/history. Decoded leniently, like the controller's snapshot: a missing or oddly typed
// field never fails the whole answer.

struct AgentStatus: Decodable, Sendable, Equatable {
    var statusApi: Int?
    var agentVersion: String?
    var machineId: String?
    var name: String?
    var server: String?
    var dashboardUrl: String?
    var connection: String?
    var connected = false
    var paused = false
    var pausedAt: Date?
    var draining = false
    var serverDrain: Bool?
    var claiming = true
    var notClaimingBecause: [String] = []
    var lastSyncAt: Date?
    var nextSyncAt: Date?
    var lastError: String?
    var runtimeKind: String?
    var runtimeOK = true
    var runtimeError: String?
    var vmState: String?
    var current: [AgentRun] = []
    var outbox = 0
    var logFile: String?
    var logHint: String?

    private enum CodingKeys: String, CodingKey {
        case statusApi, agentVersion, machineId, name, server, dashboardUrl, connection, connected, paused, drain, pausedAt, draining
        case serverDrain, claiming, notClaimingBecause, lastSyncAt, nextSyncAt, lastError, runtime, current, outbox, agent
    }
    private enum RuntimeKeys: String, CodingKey { case kind, ok, lastError, vm }
    private enum VMKeys: String, CodingKey { case state }
    private enum AgentKeys: String, CodingKey { case logFile, logHint }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        statusApi = c.lenient(.statusApi)
        agentVersion = c.string(.agentVersion)
        machineId = c.string(.machineId)
        name = c.string(.name)
        server = c.string(.server)
        dashboardUrl = c.string(.dashboardUrl)
        connection = c.string(.connection)
        connected = c.lenient(.connected) ?? (connection == "online")
        // Agents before 0.3 call the pause switch `drain`.
        paused = c.lenient(.paused) ?? c.lenient(.drain) ?? false
        pausedAt = c.date(.pausedAt)
        draining = c.lenient(.draining) ?? false
        serverDrain = c.lenient(.serverDrain)
        notClaimingBecause = c.lenient(.notClaimingBecause) ?? []
        claiming = c.lenient(.claiming) ?? notClaimingBecause.filter { $0 != "full" }.isEmpty
        lastSyncAt = c.date(.lastSyncAt)
        nextSyncAt = c.date(.nextSyncAt)
        lastError = c.string(.lastError)
        if let runtime = try? c.nestedContainer(keyedBy: RuntimeKeys.self, forKey: .runtime) {
            runtimeKind = runtime.string(.kind)
            runtimeOK = runtime.lenient(.ok) ?? true
            runtimeError = runtime.string(.lastError)
            vmState = (try? runtime.nestedContainer(keyedBy: VMKeys.self, forKey: .vm))?.string(.state)
        }
        current = (c.lenient(.current) as [AgentRun]?)?.filter { !$0.id.isEmpty } ?? []
        outbox = c.lenient(.outbox) ?? 0
        if let agent = try? c.nestedContainer(keyedBy: AgentKeys.self, forKey: .agent) {
            logFile = agent.string(.logFile)
            logHint = agent.string(.logHint)
        }
    }

    /// The running jobs, oldest claim first, and those waiting only to report last.
    var running: [AgentRun] { current.filter { !$0.waitingToReport } }

    /// Why it claims nothing, in words; nil while it takes jobs.
    var notClaimingText: String? {
        let reasons = notClaimingBecause.filter { $0 != "full" }
        guard !reasons.isEmpty else { return nil }
        return reasons.map(AgentStatus.reasonText).joined(separator: "; ")
    }

    static func reasonText(_ reason: String) -> String {
        switch reason {
        case "paused": "Paused on this Mac"
        case "draining": "Draining: restarts when the running job finishes"
        case "drained-on-dashboard": "Drained from the dashboard"
        case "revoked": "Credential revoked: enrol again"
        case "upgrade-required": "The control plane needs a newer agent"
        case "runtime-unreachable": "The container runtime does not answer"
        case "runtime-failed": "The container runtime failed to start"
        case "full": "Every run slot is in use"
        default: reason
        }
    }
}

/// A run the agent has in hand (`current` in GET /v1/status).
struct AgentRun: Decodable, Sendable, Equatable, Identifiable {
    var id = ""
    var job = ""
    var attempt: Int?
    var image: String?
    var phase = "claimed"
    var claimedAt: Date?
    var startedAt: Date?
    var elapsedMs: Double?
    var cpuPct: Double?
    var memoryBytes: Double?
    var peakMemoryBytes: Double?
    var memoryLimitBytes: Double?
    var waitingToReport = false

    private enum CodingKeys: String, CodingKey {
        case id, job, attempt, image, phase, claimedAt, startedAt, elapsedMs, cpuPct, memoryBytes, peakMemoryBytes, memoryLimitBytes, waitingToReport
    }

    init(id: String, job: String, phase: String = "running", claimedAt: Date? = nil) {
        self.id = id
        self.job = job
        self.phase = phase
        self.claimedAt = claimedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? ""
        job = c.string(.job) ?? ""
        attempt = c.lenient(.attempt)
        image = c.string(.image)
        phase = c.string(.phase) ?? "claimed"
        claimedAt = c.date(.claimedAt)
        startedAt = c.date(.startedAt)
        elapsedMs = c.double(.elapsedMs)
        cpuPct = c.double(.cpuPct)
        memoryBytes = c.double(.memoryBytes)
        peakMemoryBytes = c.double(.peakMemoryBytes)
        memoryLimitBytes = c.double(.memoryLimitBytes)
        waitingToReport = c.lenient(.waitingToReport) ?? false
    }

    /// When the run's clock started for a person: the claim (that is what the agent's elapsed counts from).
    var since: Date? { claimedAt ?? startedAt }

    /// "Pulling the image", "Starting the VM", "Running".
    var phaseText: String {
        switch phase {
        case "claimed": "Claimed"
        case "starting-vm": "Starting the VM"
        case "pulling": "Pulling the image"
        case "running": "Running"
        case "reporting": "Reporting"
        default: phase.capitalized
        }
    }

    /// "CPU 52% · 812 MB of 1 GB", or nil before the first sample.
    var statsText: String? {
        var parts: [String] = []
        if let cpuPct { parts.append("CPU \(Int(cpuPct.rounded()))%") }
        if let memory = memoryBytes ?? peakMemoryBytes {
            var text = Fmt.memory(memory)
            if let limit = memoryLimitBytes { text += " of \(Fmt.memory(limit))" }
            parts.append(text)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// One finished run from the agent's history (GET /v1/history).
struct AgentHistoryEntry: Decodable, Sendable, Equatable, Identifiable {
    struct Published: Decodable, Sendable, Equatable {
        var key: String?
        var run: String?
    }

    var run = ""
    var job = ""
    var attempt: Int?
    var source: String?
    var image: String?
    var digest: String?
    var claimedAt: Date?
    var startedAt: Date?
    var finishedAt: Date?
    var outcome: String?
    var exitCode: Int?
    var oomKilled = false
    var timedOut = false
    var error: String?
    var errorDetail: String?
    var durationMs: Double?
    var peakMemoryBytes: Double?
    var avgCpuPct: Double?
    var published: [Published] = []
    /// true ✓, false ✗, nil (cancelled) –.
    var passed: Bool?
    var reportedState: String?
    var reportedAt: Date?

    var id: String { run }

    private enum CodingKeys: String, CodingKey {
        case run, job, attempt, source, image, digest, claimedAt, startedAt, finishedAt, outcome, exitCode, oomKilled, timedOut
        case error, errorDetail, durationMs, peakMemoryBytes, avgCpuPct, published, passed, reported
    }
    private enum ReportedKeys: String, CodingKey { case at, state }

    init(run: String, job: String, outcome: String, passed: Bool?, finishedAt: Date?, error: String? = nil) {
        self.run = run
        self.job = job
        self.outcome = outcome
        self.passed = passed
        self.finishedAt = finishedAt
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        run = c.string(.run) ?? ""
        job = c.string(.job) ?? ""
        attempt = c.lenient(.attempt)
        source = c.string(.source)
        image = c.string(.image)
        digest = c.string(.digest)
        claimedAt = c.date(.claimedAt)
        startedAt = c.date(.startedAt)
        finishedAt = c.date(.finishedAt)
        outcome = c.string(.outcome)
        exitCode = c.lenient(.exitCode)
        oomKilled = c.lenient(.oomKilled) ?? false
        timedOut = c.lenient(.timedOut) ?? false
        error = c.string(.error)
        errorDetail = c.string(.errorDetail)
        durationMs = c.double(.durationMs)
        peakMemoryBytes = c.double(.peakMemoryBytes)
        avgCpuPct = c.double(.avgCpuPct)
        published = c.lenient(.published) ?? []
        passed = c.lenient(.passed) ?? (outcome == "failed" ? false : nil)
        if let reported = try? c.nestedContainer(keyedBy: ReportedKeys.self, forKey: .reported) {
            reportedState = reported.string(.state)
            reportedAt = reported.date(.at)
        }
    }

    var isFailed: Bool { passed == false }

    var mark: String { passed == true ? "✓" : passed == false ? "✗" : "–" }

    /// "Published icon-eu 2026101806", "Exit 1", "Out of memory", "Cancelled".
    var outcomeText: String {
        switch outcome {
        case "failed":
            if oomKilled { return "Out of memory" }
            if timedOut { return "Timed out" }
            return exitCode.map { "Exit \($0)" } ?? "Failed"
        case "published":
            let runs = published.map { [$0.key, $0.run].compactMap { $0 }.joined(separator: " ") }.joined(separator: ", ")
            return runs.isEmpty ? "Published" : "Published \(runs)"
        case "unchanged": return "No new run"
        case "completed": return "Passed"
        case "cancelled": return "Cancelled"
        case let other?: return other.capitalized
        case nil: return "Unknown"
        }
    }

    /// What a hover shows: the error and its last detail lines, or the outcome.
    var helpText: String {
        guard isFailed else { return outcomeText }
        var lines = [error ?? outcomeText]
        if let detail = errorDetail, !detail.isEmpty, detail != error {
            lines.append(contentsOf: detail.split(separator: "\n", omittingEmptySubsequences: false).suffix(8).map(String.init))
        }
        return lines.joined(separator: "\n")
    }

    var duration: TimeInterval? { durationMs.map { $0 / 1000 } }

    /// The error and its detail, once: a traceback that already ends with the error line stands alone.
    var fullError: String {
        switch (error, errorDetail) {
        case (let error?, let detail?) where detail.contains(error): detail
        case (let error?, let detail?): "\(error)\n\n\(detail)"
        case (let error?, nil): error
        case (nil, let detail?): detail
        case (nil, nil): outcomeText
        }
    }
}

struct AgentHistory: Decodable, Sendable {
    var runs: [AgentHistoryEntry] = []

    private enum CodingKeys: String, CodingKey { case runs }

    init(runs: [AgentHistoryEntry] = []) { self.runs = runs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        runs = (c.lenient(.runs) as [AgentHistoryEntry]?)?.filter { !$0.run.isEmpty } ?? []
    }
}
