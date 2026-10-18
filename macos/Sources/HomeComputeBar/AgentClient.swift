import Foundation

/// Which Home Compute the app shows: this Mac's agent in the hosted cluster, or the old local
/// controller on :4786. `menubar.json`'s `mode`; unset, it is the agent when this Mac is enrolled.
enum AppMode: String, Sendable, CaseIterable, Identifiable {
    case agent, controller
    var id: String { rawValue }

    var title: String {
        switch self {
        case .agent: "This Mac's agent (hosted control plane)"
        case .controller: "Local controller (Bacalhau, :4786)"
        }
    }
}

/// `menubar.json`'s `agent` section. Every field is optional; the defaults are the agent's own.
struct AgentSettings: Equatable, Sendable {
    /// The agent's state directory; empty means `~/Library/Application Support/home-compute`.
    var stateDir = ""
    /// The status API's port; nil means `statusPort` from the agent's config.json, else 4787.
    var port: Int?
    /// The status token; empty means `<stateDir>/status-token`.
    var tokenFile = ""
    /// The dashboard to open; empty means the one the agent reports (hc-core's DASHBOARD_URL).
    var dashboardUrl = ""
    /// The LaunchAgent that "Restart agent" kickstarts when the agent itself does not answer.
    /// Empty means `dev.homecompute.agent` for the default state directory and none otherwise,
    /// so a development agent never restarts the real one.
    var launchdLabel = ""
    /// The agent's log; empty means what the agent reports, else ~/Library/Logs/home-compute/agent.log.
    var logFile = ""
    var notifyOnFailure = false

    static let defaultStateDir = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/Application Support/home-compute").path
    static let defaultLaunchdLabel = "dev.homecompute.agent"
    static let defaultLogFile = FileManager.default.homeDirectoryForCurrentUser
        .appending(path: "Library/Logs/home-compute/agent.log").path
    static let defaultPort = 4787

    var resolvedStateDir: String {
        let trimmed = stateDir.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? AgentSettings.defaultStateDir : (trimmed as NSString).expandingTildeInPath
    }

    var usesDefaultStateDir: Bool {
        URL(filePath: resolvedStateDir).standardizedFileURL == URL(filePath: AgentSettings.defaultStateDir).standardizedFileURL
    }

    /// The label "Restart agent" may kickstart, or nil (see `launchdLabel`).
    var restartLabel: String? {
        let trimmed = launchdLabel.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed == "-" ? nil : trimmed }
        return usesDefaultStateDir ? AgentSettings.defaultLaunchdLabel : nil
    }

    func read(_ dict: [String: Any]) -> AgentSettings {
        var copy = self
        if let value = dict["stateDir"] as? String { copy.stateDir = value }
        if let value = dict["port"] as? Int { copy.port = value }
        if let value = dict["tokenFile"] as? String { copy.tokenFile = value }
        if let value = dict["dashboardUrl"] as? String { copy.dashboardUrl = value }
        if let value = dict["launchdLabel"] as? String { copy.launchdLabel = value }
        if let value = dict["logFile"] as? String { copy.logFile = value }
        if let value = dict["notifyOnFailure"] as? Bool { copy.notifyOnFailure = value }
        return copy
    }

    var dictionary: [String: Any] {
        var dict: [String: Any] = ["notifyOnFailure": notifyOnFailure]
        let strings = ["stateDir": stateDir, "tokenFile": tokenFile, "dashboardUrl": dashboardUrl, "launchdLabel": launchdLabel, "logFile": logFile]
        for (key, value) in strings {
            let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { dict[key] = trimmed }
        }
        if let port { dict["port"] = port }
        return dict
    }
}

/// Where the agent's status API is and its token, read from the agent's state directory.
struct AgentEndpoint: Equatable, Sendable {
    var baseURL: URL
    var token: String
    var stateDir: String

    enum Problem: Error, Equatable, LocalizedError {
        case notEnrolled(String)
        case statusOff
        case noToken(String)

        var errorDescription: String? {
            switch self {
            case .notEnrolled(let dir): "This Mac is not enrolled: there is no agent configuration in \(dir)."
            case .statusOff: "The agent's status API is turned off (statusPort is 0 in its config.json)."
            case .noToken(let file): "No status token at \(file). It is written when the agent first runs."
            }
        }
    }

    /// Reads `statusPort` from config.json (unless the settings name a port) and the token file.
    static func resolve(_ settings: AgentSettings) -> Result<AgentEndpoint, Problem> {
        let dir = settings.resolvedStateDir
        let configURL = URL(filePath: dir).appending(path: "config.json")
        let config = (try? Data(contentsOf: configURL)).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        var port = settings.port
        if port == nil {
            guard let config else { return .failure(.notEnrolled(dir)) }
            port = (config["statusPort"] as? Int) ?? AgentSettings.defaultPort
        }
        guard let port, port > 0, port < 65_536 else { return .failure(.statusOff) }
        let tokenPath = settings.tokenFile.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? URL(filePath: dir).appending(path: "status-token").path
            : (settings.tokenFile as NSString).expandingTildeInPath
        guard let data = FileManager.default.contents(atPath: tokenPath),
              let token = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines), !token.isEmpty else {
            return .failure(.noToken(tokenPath))
        }
        // Always loopback: the API listens nowhere else.
        return .success(AgentEndpoint(baseURL: URL(string: "http://127.0.0.1:\(port)")!, token: token, stateDir: dir))
    }
}

enum AgentAPIError: LocalizedError, Equatable {
    case notRunning(String)
    case unauthorized
    case http(Int, String?)

    var errorDescription: String? {
        switch self {
        case .notRunning(let detail): "The agent is not running (\(detail))."
        case .unauthorized: "The agent refused the status token. Restart the agent, or check the token file in Settings."
        case .http(let status, let message): message ?? "HTTP \(status)"
        }
    }
}

/// The local status API: read-mostly, 127.0.0.1 only, bearer token from the agent's 0600 file.
struct AgentClient: Sendable {
    let endpoint: AgentEndpoint

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 5
        config.connectionProxyDictionary = [:]
        return URLSession(configuration: config)
    }()

    @concurrent func status() async throws -> AgentStatus {
        try JSONDecoder().decode(AgentStatus.self, from: try await send("v1/status"))
    }

    @concurrent func history(limit: Int = 20) async throws -> [AgentHistoryEntry] {
        try JSONDecoder().decode(AgentHistory.self, from: try await send("v1/history", query: [URLQueryItem(name: "limit", value: String(limit))])).runs
    }

    @concurrent func pause() async throws -> AgentStatus { try await post("v1/pause") }
    @concurrent func resume() async throws -> AgentStatus { try await post("v1/resume") }
    @concurrent func drain(_ on: Bool = true) async throws -> AgentStatus { try await post("v1/drain", body: ["drain": on]) }
    @concurrent func restart() async throws -> AgentStatus { try await post("v1/restart") }

    private func post(_ path: String, body: [String: Bool] = [:]) async throws -> AgentStatus {
        let data = try JSONSerialization.data(withJSONObject: body)
        return try JSONDecoder().decode(AgentStatus.self, from: try await send(path, method: "POST", body: data))
    }

    private func send(_ path: String, method: String = "GET", query: [URLQueryItem] = [], body: Data? = nil) async throws -> Data {
        var url = endpoint.baseURL.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch let error as URLError where [.cannotConnectToHost, .timedOut, .networkConnectionLost, .cannotFindHost].contains(error.code) {
            throw AgentAPIError.notRunning("nothing answers on \(endpoint.baseURL.host() ?? "127.0.0.1"):\(endpoint.baseURL.port ?? 0)")
        }
        guard let http = response as? HTTPURLResponse else { return data }
        if http.statusCode == 401 { throw AgentAPIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            struct Body: Decodable { var error: String? }
            throw AgentAPIError.http(http.statusCode, (try? JSONDecoder().decode(Body.self, from: data))?.error)
        }
        return data
    }
}
