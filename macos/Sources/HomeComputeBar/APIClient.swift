import Foundation

enum APIError: LocalizedError {
    case invalidURL(String)
    case unauthorized
    case http(Int, String?)

    var errorDescription: String? {
        switch self {
        case .invalidURL(let url): "Invalid controller URL: \(url)"
        case .unauthorized: "Unauthorized - check the API token"
        case .http(let status, let message): message ?? "HTTP \(status)"
        }
    }
}

enum JobAction: String, Sendable {
    case run, pause, resume

    var title: String {
        switch self {
        case .run: "Run now"
        case .pause: "Pause"
        case .resume: "Resume"
        }
    }
}

struct ServerEvent: Sendable {
    var name: String
    var data: Data
}

/// Thin async client for the Home Compute HTTP API.
struct APIClient: Sendable {
    let baseURL: String
    let token: String

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 20
        return URLSession(configuration: config)
    }()

    /// The controller sends no heartbeats, so allow long idle gaps; a timeout just triggers a reconnect.
    private static let streamSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 300
        config.timeoutIntervalForResource = 7 * 24 * 3600
        return URLSession(configuration: config)
    }()

    @concurrent func health() async throws {
        let (data, response) = try await Self.session.data(for: request("v1/health"))
        try Self.check(response, data)
    }

    @concurrent func snapshot(live: Bool = true) async throws -> Snapshot {
        var req = try request("v1/snapshot", query: live ? [] : [URLQueryItem(name: "live", value: "false")])
        req.timeoutInterval = 30
        let (data, response) = try await Self.session.data(for: req)
        try Self.check(response, data)
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }

    @concurrent func perform(_ action: JobAction, job: String) async throws {
        var req = try request("v1/jobs/\(job)/\(action.rawValue)", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        let (data, response) = try await Self.session.data(for: req)
        try Self.check(response, data)
    }

    /// A one-time link that signs the browser in to the dashboard (`POST /v1/session/link`),
    /// landing on `page` (a dashboard route such as `#/job/gfs`) when given.
    @concurrent func dashboardLink(page: String? = nil) async throws -> URL {
        var req = try request("v1/session/link", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        let (data, response) = try await Self.session.data(for: req)
        try Self.check(response, data)
        struct Body: Decodable { var url: String }
        let link = try JSONDecoder().decode(Body.self, from: data)
        guard let url = DashboardURL.withPage(link.url, page: page) else { throw APIError.invalidURL(link.url) }
        return url
    }

    /// Asks the controller to re-read its configuration (`POST /v1/reload`), so a timetable
    /// change applies without a restart. Older controllers answer 404.
    @concurrent func reload() async throws -> ReloadResult {
        var req = try request("v1/reload", method: "POST")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        let (data, response) = try await Self.session.data(for: req)
        try Self.check(response, data)
        return try JSONDecoder().decode(ReloadResult.self, from: data)
    }

    /// Reads `GET /v1/events` until the stream ends or fails. Byte-level line splitting
    /// (rather than `bytes.lines`) keeps the blank lines that terminate SSE events.
    @concurrent func streamEvents(_ onEvent: @Sendable (ServerEvent) async -> Void) async throws {
        var req = try request("v1/events")
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        req.timeoutInterval = 300
        let (bytes, response) = try await Self.streamSession.bytes(for: req)
        try Self.check(response, nil)

        var parser = SSEParser()
        var line: [UInt8] = []
        for try await byte in bytes {
            switch byte {
            case 0x0A:
                if let event = parser.feed(String(decoding: line, as: UTF8.self)) { await onEvent(event) }
                line.removeAll(keepingCapacity: true)
            case 0x0D:
                continue
            default:
                line.append(byte)
            }
        }
    }

    private func request(_ path: String, method: String = "GET", query: [URLQueryItem] = []) throws -> URLRequest {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let base = URL(string: trimmed), base.scheme == "http" || base.scheme == "https", base.host() != nil else {
            throw APIError.invalidURL(trimmed)
        }
        var url = base.appending(path: path)
        if !query.isEmpty { url.append(queryItems: query) }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.cachePolicy = .reloadIgnoringLocalCacheData
        if !token.isEmpty { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }

    private static func check(_ response: URLResponse, _ data: Data?) throws {
        guard let http = response as? HTTPURLResponse else { return }
        if http.statusCode == 401 { throw APIError.unauthorized }
        guard (200..<300).contains(http.statusCode) else {
            struct Body: Decodable { var error: String? }
            let message = data.flatMap { try? JSONDecoder().decode(Body.self, from: $0) }?.error
            throw APIError.http(http.statusCode, message)
        }
    }
}

/// Minimal Server-Sent Events line parser.
struct SSEParser {
    private var name = ""
    private var data: [String] = []

    mutating func feed(_ line: String) -> ServerEvent? {
        if line.isEmpty {
            defer { name = ""; data = [] }
            guard !data.isEmpty || !name.isEmpty else { return nil }
            return ServerEvent(name: name.isEmpty ? "message" : name, data: Data(data.joined(separator: "\n").utf8))
        }
        if line.hasPrefix(":") { return nil }
        let field: Substring
        var value: Substring = ""
        if let colon = line.firstIndex(of: ":") {
            field = line[..<colon]
            value = line[line.index(after: colon)...]
            if value.hasPrefix(" ") { value = value.dropFirst() }
        } else {
            field = Substring(line)
        }
        switch field {
        case "event": name = String(value)
        case "data": data.append(String(value))
        default: break
        }
        return nil
    }
}

/// The answer to `POST /v1/reload`.
struct ReloadResult: Decodable, Sendable, Equatable {
    var added: [String] = []
    var removed: [String] = []
    var changed: [String] = []
    /// Configuration sections that changed but only apply at the next restart.
    var restartRequired: [String] = []

    private enum CodingKeys: String, CodingKey { case added, removed, changed, restartRequired }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        added = c.lenient(.added) ?? []
        removed = c.lenient(.removed) ?? []
        changed = c.lenient(.changed) ?? []
        restartRequired = c.lenient(.restartRequired) ?? []
    }

    var appliedWithoutRestart: Bool { restartRequired.isEmpty }
}

/// The dashboard's addresses.
enum DashboardURL {
    /// The dashboard at the controller's own address (`http://127.0.0.1:4786/`).
    static func base(_ controllerURL: String) -> URL? {
        guard var components = URLComponents(string: controllerURL.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "http" || components.scheme == "https", components.host != nil else { return nil }
        components.path = "/"
        components.query = nil
        components.fragment = nil
        return components.url
    }

    /// A sign-in link with `next` set to a dashboard route, so the browser lands on that page.
    static func withPage(_ link: String, page route: String?) -> URL? {
        guard var components = URLComponents(string: link) else { return nil }
        if let next = page(route) {
            components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "next", value: "#" + next)]
        }
        return components.url
    }

    /// The fragment for a route such as "#/job/gfs" ("/job/gfs"), or nil.
    private static func page(_ route: String?) -> String? {
        guard let route, route.hasPrefix("#/") else { return nil }
        return String(route.dropFirst())
    }

    /// The route of a job's page, or of one of its runs.
    static func route(job: String, run: String? = nil) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        let encode = { (value: String) in value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value }
        return "#/job/\(encode(job))" + (run.map { "/run/\(encode($0))" } ?? "")
    }
}
