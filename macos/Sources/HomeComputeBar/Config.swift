import Foundation
import os

struct AppConfig: Equatable, Sendable {
    static let defaultURL = "http://127.0.0.1:4786"

    var url = AppConfig.defaultURL
    var token = ""
    var notifyOnPublished = false
    /// Path of the setup script (`macmini.sh`) the control panel runs; empty = not chosen.
    var setupScript = ""
    /// `mode` in menubar.json; nil = the agent when this Mac is enrolled, else the controller.
    var mode: AppMode?
    var agent = AgentSettings()

    /// The mode the app runs in.
    var resolvedMode: AppMode {
        if let mode { return mode }
        let enrolled = FileManager.default.fileExists(atPath: URL(filePath: agent.resolvedStateDir).appending(path: "config.json").path)
        return enrolled ? .agent : .controller
    }

    var normalized: AppConfig {
        var copy = self
        copy.url = url.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        copy.setupScript = setupScript.trimmingCharacters(in: .whitespacesAndNewlines)
        if copy.url.isEmpty { copy.url = AppConfig.defaultURL }
        return copy
    }
}

/// Reads and writes `~/.config/home-compute/menubar.json` (or `$HOME_COMPUTE_BAR_CONFIG`).
/// Unknown keys written by other tools are preserved on save.
enum ConfigFile {
    static var url: URL {
        if let override = ProcessInfo.processInfo.environment["HOME_COMPUTE_BAR_CONFIG"], !override.isEmpty {
            return URL(filePath: (override as NSString).expandingTildeInPath)
        }
        return FileManager.default.homeDirectoryForCurrentUser
            .appending(path: ".config/home-compute/menubar.json")
    }

    static func load() -> AppConfig {
        var config = AppConfig()
        let dict = readDictionary()
        if let url = dict["url"] as? String, !url.isEmpty { config.url = url }
        if let token = dict["token"] as? String { config.token = token }
        if let notify = dict["notifyOnPublished"] as? Bool { config.notifyOnPublished = notify }
        if let script = dict["setupScript"] as? String { config.setupScript = script }
        if let mode = dict["mode"] as? String { config.mode = AppMode(rawValue: mode) }
        if let agent = dict["agent"] as? [String: Any] { config.agent = config.agent.read(agent) }
        return config.normalized
    }

    /// Re-reads the file after the setup script may have rewritten it (setup, token rotation).
    /// If the rewrite dropped the setup script path the user chose, it is restored and saved.
    static func reload(keeping current: AppConfig) -> AppConfig {
        var loaded = load()
        if loaded.setupScript.isEmpty, !current.setupScript.isEmpty {
            loaded.setupScript = current.setupScript
            do {
                try save(loaded)
                Log.info("restored setupScript in \(url.path)")
            } catch {
                Log.info("could not restore setupScript: \(error.localizedDescription)")
            }
        }
        return loaded
    }

    static func save(_ config: AppConfig) throws {
        let fm = FileManager.default
        let target = url
        let dir = target.deletingLastPathComponent()
        if !fm.fileExists(atPath: dir.path) {
            try fm.createDirectory(at: dir, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        }
        var dict = readDictionary()
        let config = config.normalized
        dict["url"] = config.url
        dict["token"] = config.token
        dict["notifyOnPublished"] = config.notifyOnPublished
        dict["setupScript"] = config.setupScript.isEmpty ? nil : config.setupScript
        dict["mode"] = config.mode?.rawValue
        let agent = config.agent.dictionary
        dict["agent"] = agent.count == 1 && agent["notifyOnFailure"] as? Bool == false ? nil : agent
        let data = try JSONSerialization.data(withJSONObject: dict, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])

        // Write a 0600 temp file and rename it over the target so the token is never world-readable.
        let temp = dir.appending(path: ".\(target.lastPathComponent).\(UUID().uuidString).tmp")
        guard fm.createFile(atPath: temp.path, contents: data + Data("\n".utf8), attributes: [.posixPermissions: 0o600]) else {
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: temp.path])
        }
        if rename(temp.path, target.path) != 0 {
            try? fm.removeItem(at: temp)
            throw CocoaError(.fileWriteUnknown, userInfo: [NSFilePathErrorKey: target.path])
        }
    }

    private static func readDictionary() -> [String: Any] {
        guard let data = try? Data(contentsOf: url),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }
}

enum Log {
    private static let logger = Logger(subsystem: "dev.sprintengine.home-compute-bar", category: "app")

    /// Logs to the unified log and to stdout (visible when the binary is run from a terminal).
    static func info(_ message: String) {
        logger.info("\(message, privacy: .public)")
        FileHandle.standardOutput.write(Data("[home-compute-bar] \(message)\n".utf8))
    }
}
