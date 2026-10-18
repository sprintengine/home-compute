import AppKit
import Foundation
import SwiftUI
import Testing
@testable import HomeComputeBar

/// Renders agent mode offscreen into PNGs from the real agent's answers (AgentFixtures), with
/// their times moved to now: the popover idle, running, with a failure, paused, without a
/// running agent and offline; the history window; the settings tab; the menu bar icon. Opt-in:
///
///     HCB_SNAPSHOTS=/tmp/hcb-snapshots swift test --filter AgentSnapshotTests
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["HCB_SNAPSHOTS"] != nil))
@MainActor
struct AgentSnapshotTests {
    private let out = URL(filePath: ProcessInfo.processInfo.environment["HCB_SNAPSHOTS"] ?? "/tmp")

    /// The fixture with every ISO time moved by `offset` seconds.
    private func shifted(_ json: String, by offset: TimeInterval) throws -> Data {
        func walk(_ value: Any) -> Any {
            if let dict = value as? [String: Any] { return dict.mapValues(walk) }
            if let list = value as? [Any] { return list.map(walk) }
            if let text = value as? String, text.count >= 20, let date = ISODate.parse(text) {
                let formatter = ISO8601DateFormatter()
                formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
                return formatter.string(from: date.addingTimeInterval(offset))
            }
            return value
        }
        return try JSONSerialization.data(withJSONObject: walk(try JSONSerialization.jsonObject(with: Data(json.utf8))))
    }

    /// Status and history as if the last sync (status) and the newest finish (history) were `ago` seconds before now.
    private func store(status json: String, history: String = AgentFixtures.history, statusAgo: TimeInterval = 3, historyAgo: TimeInterval = 240,
                       change: (inout AgentStatus) -> Void = { _ in }, entries: ([AgentHistoryEntry]) -> [AgentHistoryEntry] = { $0 }) throws -> AgentStore {
        let rawStatus = try AgentFixtures.decode(AgentStatus.self, json)
        let rawHistory = try AgentFixtures.decode(AgentHistory.self, history).runs
        let statusOffset = Date.now.timeIntervalSince(rawStatus.lastSyncAt ?? .now) - statusAgo
        let historyOffset = Date.now.timeIntervalSince(rawHistory.first?.finishedAt ?? .now) - historyAgo
        var status = try JSONDecoder().decode(AgentStatus.self, from: shifted(json, by: statusOffset))
        change(&status)
        let runs = try JSONDecoder().decode(AgentHistory.self, from: shifted(history, by: historyOffset)).runs
        var config = AppConfig()
        config.agent.stateDir = "/tmp/hc-status-demo/agent"
        let store = AgentStore(config: config, live: false)
        store.apply(status: status, history: entries(runs))
        return store
    }

    private func render<V: View>(_ name: String, width: CGFloat, height: CGFloat? = nil, appearance: NSAppearance.Name = .aqua,
                                 _ store: AgentStore, _ view: V) async throws {
        let root = view.environment(store).environment(AppModel.shared).environment(Store.shared).environment(ControlStore.shared)
        let host = NSHostingView(rootView: root.frame(width: width))
        host.appearance = NSAppearance(named: appearance)
        let size = height.map { CGSize(width: width, height: $0) } ?? host.fittingSize
        host.frame = CGRect(origin: .zero, size: CGSize(width: width, height: max(size.height, 40)))
        let window = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: appearance)
        for _ in 0..<6 {
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
        }
        let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try #require(rep.representation(using: .png, properties: [:])).write(to: out.appending(path: "\(name).png"))
        window.close()
    }

    @Test func renderAgentMode() async throws {
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let withoutFailure: ([AgentHistoryEntry]) -> [AgentHistoryEntry] = { $0.filter { !$0.isFailed } }

        try await render("agent-1-idle", width: 380, try store(status: AgentFixtures.statusIdle, entries: withoutFailure), AgentPopoverView())
        try await render("agent-2-running", width: 380, try store(status: AgentFixtures.statusRunning, historyAgo: 900, entries: withoutFailure), AgentPopoverView())
        // A failure that just happened: newest first, and the red dot on the icon.
        let failed = try store(status: AgentFixtures.statusIdle, historyAgo: 60, entries: { runs in
            runs.filter { !$0.isFailed }.map { var entry = $0; entry.finishedAt = entry.finishedAt?.addingTimeInterval(-600); return entry }
        })
        // It fails after the app has started: news, so the icon gets its red dot.
        let failure = try JSONDecoder().decode(AgentHistory.self, from: shifted(AgentFixtures.history, by: 0)).runs.first(where: \.isFailed)!
        var fresh = failure
        let took = (failure.finishedAt ?? .now).timeIntervalSince(failure.claimedAt ?? .now)
        fresh.finishedAt = Date.now.addingTimeInterval(-60)
        fresh.claimedAt = fresh.finishedAt?.addingTimeInterval(-took)
        fresh.startedAt = fresh.claimedAt
        failed.apply(status: failed.status!, history: [fresh] + failed.history)
        try await render("agent-3-failure", width: 380, failed, AgentPopoverView())
        try await render("agent-4-paused", width: 380, try store(status: AgentFixtures.statusIdle) {
            $0.paused = true
            $0.pausedAt = Date.now.addingTimeInterval(-1500)
            $0.claiming = false
            $0.notClaimingBecause = ["paused"]
        }, AgentPopoverView())
        try await render("agent-5-draining", width: 380, try store(status: AgentFixtures.statusRunning, historyAgo: 900, change: {
            $0.draining = true
            $0.claiming = false
            $0.notClaimingBecause = ["draining"]
        }, entries: withoutFailure), AgentPopoverView())
        try await render("agent-6-offline", width: 380, try store(status: AgentFixtures.statusIdle, change: {
            $0.connected = false
            $0.connection = "offline"
            $0.lastSyncAt = Date.now.addingTimeInterval(-340)
            $0.lastError = "https://hc-core.example.workers.dev is unreachable: ENOTFOUND"
            $0.outbox = 1
        }), AgentPopoverView())
        let down = AgentStore(config: AppConfig(), live: false)
        down.setConnection(.notRunning("nothing answers on 127.0.0.1:4787"))
        try await render("agent-7-not-running", width: 380, down, AgentPopoverView())

        failed.selectedRun = failed.history.first?.run
        try await render("agent-8-history-window", width: 820, height: 520, failed, AgentHistoryWindow())
        try await render("agent-9-settings", width: 560, height: 640, failed, AgentSettingsTab())

        // The status item in each state, on a light and a dark menu bar. (Opening the popover saw the
        // failure above, so the red dot needs another one.)
        var another = fresh
        another.run = "r_another"
        failed.apply(status: failed.status!, history: [another] + failed.history)
        let running = try store(status: AgentFixtures.statusRunning)
        let states: [(String, AgentStore)] = [("idle", try store(status: AgentFixtures.statusIdle, entries: withoutFailure)), ("running", running),
                                              ("failure", failed), ("paused", try store(status: AgentFixtures.statusIdle) { $0.paused = true }), ("not running", down)]
        for appearance in [NSAppearance.Name.aqua, .darkAqua] {
            let strip = HStack(spacing: 18) {
                ForEach(Array(states.enumerated()), id: \.offset) { _, item in
                    VStack(spacing: 4) {
                        AgentMenuBarLabel(agent: item.1)
                        Text(item.0).font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(10)
            .background(appearance == .aqua ? Color(white: 0.93) : Color(white: 0.16))
            try await render("agent-0-icons-\(appearance == .aqua ? "light" : "dark")", width: 480, height: 64, appearance: appearance, running, strip)
        }
    }
}
