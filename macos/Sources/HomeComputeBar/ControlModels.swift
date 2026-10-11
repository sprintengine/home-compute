import Foundation

// Types for the setup script's `--json` commands (macmini.sh). Like the snapshot types,
// every field is optional or defaulted and decoded leniently: a missing or oddly typed
// field never fails the whole response.

/// `macmini.sh state --json`
struct SetupState: Decodable, Sendable, Equatable {
    struct Paths: Decodable, Sendable, Equatable {
        var wingfoil: String?
        var homeCompute: String?
        var envFile: String?
        var jobsFile: String?
        var logs: String?
        var controllerLog: String?
        var bacalhauLog: String?
    }

    struct Setup: Decodable, Sendable, Equatable {
        var complete: Bool?
        var envFile: Bool?
        var r2Configured: Bool?
        var agents: Bool?
        var homeComputeDeps: Bool?
        var configCurrent: Bool?
        var tools: [String: Bool] = [:]

        private enum CodingKeys: String, CodingKey { case complete, envFile, r2Configured, agents, homeComputeDeps, configCurrent, tools }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            complete = c.bool(.complete)
            envFile = c.bool(.envFile)
            r2Configured = c.bool(.r2Configured)
            agents = c.bool(.agents)
            homeComputeDeps = c.bool(.homeComputeDeps)
            configCurrent = c.bool(.configCurrent)
            tools = c.lenient(.tools) ?? [:]
        }

        var missingTools: [String] { tools.filter { !$0.value }.keys.sorted() }
    }

    struct Colima: Decodable, Sendable, Equatable {
        var state: String?
        var cpus: Int?
        var memoryGiB: Double?
        var autostart: Bool?

        private enum CodingKeys: String, CodingKey { case state, cpus, memoryGiB, autostart }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = c.string(.state)
            cpus = c.int(.cpus)
            memoryGiB = c.double(.memoryGiB)
            autostart = c.bool(.autostart)
        }
    }

    struct Bacalhau: Decodable, Sendable, Equatable {
        var state: String?
        var loaded: Bool?
        var nodes: Int?

        private enum CodingKeys: String, CodingKey { case state, loaded, nodes }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = c.string(.state)
            loaded = c.bool(.loaded)
            nodes = c.int(.nodes)
        }
    }

    struct Controller: Decodable, Sendable, Equatable {
        var state: String?
        var loaded: Bool?
        var answering: Bool?

        private enum CodingKeys: String, CodingKey { case state, loaded, answering }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            state = c.string(.state)
            loaded = c.bool(.loaded)
            answering = c.bool(.answering)
        }
    }

    struct Services: Decodable, Sendable, Equatable {
        var colima: Colima?
        var bacalhau: Bacalhau?
        var controller: Controller?

        private enum CodingKeys: String, CodingKey { case colima, bacalhau, controller }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            colima = c.lenient(.colima)
            bacalhau = c.lenient(.bacalhau)
            controller = c.lenient(.controller)
        }
    }

    struct Image: Decodable, Sendable, Equatable {
        var name: String?
        var present: Bool?
        var builtAt: Date?
        var sourceHash: String?
        var currentHash: String?
        var stale: Bool?
        var sizeBytes: Int64?

        private enum CodingKeys: String, CodingKey { case name, present, builtAt, sourceHash, currentHash, stale, sizeBytes }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            name = c.string(.name)
            present = c.bool(.present)
            builtAt = c.date(.builtAt)
            sourceHash = c.string(.sourceHash)
            currentHash = c.string(.currentHash)
            stale = c.bool(.stale)
            sizeBytes = c.double(.sizeBytes).map { Int64($0) }
        }

        enum Freshness: Equatable { case missing, upToDate, stale, untracked }

        var freshness: Freshness {
            guard present == true else { return .missing }
            // An image built before the source hash was recorded can't be compared.
            guard let sourceHash, !sourceHash.isEmpty else { return .untracked }
            if let stale { return stale ? .stale : .upToDate }
            guard let currentHash else { return .untracked }
            return sourceHash == currentHash ? .upToDate : .stale
        }
    }

    var paths: Paths?
    var setup: Setup?
    var services: Services?
    var image: Image?

    private enum CodingKeys: String, CodingKey { case paths, setup, services, image }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        paths = c.lenient(.paths)
        setup = c.lenient(.setup)
        services = c.lenient(.services)
        image = c.lenient(.image)
    }

    var isSetUp: Bool { setup?.complete != false }

    /// The scheduler can't run jobs: the controller or Bacalhau is stopped or missing.
    var isStopped: Bool {
        let controller = services?.controller?.state?.lowercased()
        let bacalhau = services?.bacalhau?.state?.lowercased()
        return controller == "stopped" || bacalhau == "stopped" || bacalhau == "missing"
    }

    var isStarting: Bool {
        services?.controller?.state?.lowercased() == "starting" || services?.bacalhau?.state?.lowercased() == "starting"
    }
}

/// `macmini.sh env --json`
struct EnvInfo: Decodable, Sendable, Equatable {
    struct Secret: Decodable, Sendable, Equatable {
        var set = false
        var hint: String?

        private enum CodingKeys: String, CodingKey { case set, hint }

        init(set: Bool = false, hint: String? = nil) {
            self.set = set
            self.hint = hint
        }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            set = c.bool(.set) ?? false
            hint = c.string(.hint)
        }
    }

    var exists = false
    var values: [String: String] = [:]
    var secrets: [String: Secret] = [:]

    private enum CodingKeys: String, CodingKey { case exists, values, secrets }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        exists = c.bool(.exists) ?? false
        values = c.lenient(.values) ?? (c.lenient(.values) as [String: String?]?)?.mapValues { $0 ?? "" } ?? [:]
        secrets = c.lenient(.secrets) ?? [:]
    }

    static let editableValues = ["S3_BUCKET", "S3_ENDPOINT_URL", "S3_PREFIX", "AWS_REGION", "ECMWF_SOURCE"]
    static let editableSecrets = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
}

/// `macmini.sh r2-test --json`
struct R2TestResult: Decodable, Sendable, Equatable {
    struct Manifest: Decodable, Sendable, Equatable, Identifiable {
        var model = ""
        var key: String?
        var run: String?
        var lastModified: Date?
        var missing = false

        var id: String { key ?? model }

        private enum CodingKeys: String, CodingKey { case model, key, run, lastModified, missing }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            model = c.string(.model) ?? ""
            key = c.string(.key)
            run = c.string(.run)
            lastModified = c.date(.lastModified)
            missing = c.bool(.missing) ?? (run == nil && lastModified == nil)
        }
    }

    var ok = false
    var bucket: String?
    var endpoint: String?
    var objectsSeen: Int?
    var manifests: [Manifest] = []
    var error: String?

    private enum CodingKeys: String, CodingKey { case ok, bucket, endpoint, objectsSeen, manifests, error }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.bool(.ok) ?? false
        bucket = c.string(.bucket)
        endpoint = c.string(.endpoint)
        objectsSeen = c.int(.objectsSeen)
        manifests = c.lenient(.manifests) ?? []
        error = c.string(.error)
    }
}

/// `macmini.sh jobs --json`
struct Timetable: Decodable, Sendable, Equatable {
    var cronStepMinutes = 5
    var memoryChoices: [String] = []
    var timezone = "UTC"
    var jobs: [TimetableJob] = []

    private enum CodingKeys: String, CodingKey { case cronStepMinutes, memoryChoices, timezone, jobs }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let step = c.int(.cronStepMinutes), (1...60).contains(step) { cronStepMinutes = step }
        memoryChoices = c.lenient(.memoryChoices) ?? []
        timezone = c.string(.timezone) ?? "UTC"
        jobs = (c.lenient(.jobs) as [TimetableJob]?)?.filter { !$0.id.isEmpty } ?? []
    }

    /// 0, step, 2·step, … below 60.
    var minuteChoices: [Int] { Array(stride(from: 0, to: 60, by: cronStepMinutes)) }
}

struct TimetableJob: Decodable, Sendable, Equatable, Identifiable {
    var id = ""
    var description: String?
    var models: [String] = []
    var command: String?
    var enabled = true
    /// nil = every hour.
    var hours: [Int]?
    var minutes: [Int] = [0]
    var memory: String?
    var defaultMemory: String?
    var timeoutSeconds: Int?
    var scheduleEditable = true

    private enum CodingKeys: String, CodingKey {
        case id, description, models, command, enabled, hours, minutes, memory, defaultMemory, timeoutSeconds, scheduleEditable
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.string(.id) ?? ""
        description = c.string(.description)
        models = c.lenient(.models) ?? []
        command = c.string(.command)
        enabled = c.bool(.enabled) ?? true
        let hours: [Int]? = c.lenient(.hours)
        self.hours = (hours?.isEmpty ?? true) ? nil : hours?.sorted()
        minutes = (c.lenient(.minutes) as [Int]?)?.sorted() ?? [0]
        memory = c.string(.memory)
        defaultMemory = c.string(.defaultMemory)
        timeoutSeconds = c.int(.timeoutSeconds)
        scheduleEditable = c.bool(.scheduleEditable) ?? true
    }
}

/// `{"ok": …, "error": …, "restartRequired": …}` from the mutating JSON commands.
struct ScriptReply: Decodable, Sendable {
    var ok: Bool?
    var error: String?
    var restartRequired: Bool?

    private enum CodingKeys: String, CodingKey { case ok, error, restartRequired }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = c.bool(.ok)
        error = c.string(.error)
        restartRequired = c.bool(.restartRequired)
    }
}

extension KeyedDecodingContainer {
    func int(_ key: Key) -> Int? {
        if let i: Int = lenient(key) { return i }
        if let d: Double = lenient(key), d.isFinite { return Int(d) }
        if let s: String = lenient(key) { return Int(s) }
        return nil
    }

    func bool(_ key: Key) -> Bool? {
        if let b: Bool = lenient(key) { return b }
        if let i: Int = lenient(key) { return i != 0 }
        switch (lenient(key) as String?)?.lowercased() {
        case "true", "yes", "1", "on": return true
        case "false", "no", "0", "off": return false
        default: return nil
        }
    }
}
