import AppKit
import Foundation
import SwiftUI
import Testing
@testable import HomeComputeBar

/// Renders the control panel's views offscreen into PNGs, driven by dev/fake-setup.sh, so the
/// layout can be reviewed without screen capture. Opt-in:
///
///     HCB_SNAPSHOTS=/tmp/hcb-snapshots swift test --filter SnapshotTests
@Suite(.serialized, .enabled(if: ProcessInfo.processInfo.environment["HCB_SNAPSHOTS"] != nil))
@MainActor
struct SnapshotTests {
    @Test func renderControlPanel() async throws {
        let out = URL(filePath: ProcessInfo.processInfo.environment["HCB_SNAPSHOTS"]!)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        let dir = FileManager.default.temporaryDirectory.appending(path: "hcb-snapshots-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appending(path: "fake-setup"), withIntermediateDirectories: true)
        try Data("0.01".utf8).write(to: dir.appending(path: "fake-setup/delay"))
        let config = dir.appending(path: "menubar.json")
        try Data(#"{"url": "http://127.0.0.1:1", "token": "t", "setupScript": "\#(SetupScriptTests.fakePath)"}"#.utf8).write(to: config)
        setenv("HOME_COMPUTE_BAR_CONFIG", config.path, 1)
        defer { try? FileManager.default.removeItem(at: dir) }

        let store = Store.shared
        let control = ControlStore(host: store)
        await control.refreshAll()

        func render<V: View>(_ name: String, width: CGFloat = SettingsView.contentSize.width,
                             height: CGFloat = SettingsView.contentSize.height, _ view: V) async throws {
            let root = view.environment(store).environment(control).environment(AppModel.shared).frame(width: width, height: height)
            let host = NSHostingView(rootView: root)
            host.frame = CGRect(x: 0, y: 0, width: width, height: height)
            let window = NSWindow(contentRect: host.frame, styleMask: [.titled], backing: .buffered, defer: false)
            window.contentView = host
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .aqua)
            for _ in 0..<6 {
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(100))
            }
            let rep = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: rep)
            try #require(rep.representation(using: .png, properties: [:])).write(to: out.appending(path: "\(name).png"))
            window.close()
        }

        func waitForRun() async throws {
            while control.isRunning { try await Task.sleep(for: .milliseconds(50)) }
            try await Task.sleep(for: .milliseconds(300))
        }

        // Fresh install: not set up, everything stopped, controller unreachable.
        try await render("1-services-not-set-up", ServicesTab())
        try await render("2-popover-not-set-up", width: 380, height: 260, PopoverView())

        control.start(.setup)
        try await waitForRun()
        try await render("3-log-sheet-setup", width: 620, height: 440, LogSheet(run: control.run!))
        control.dismissRun()
        try await render("4-popover-stopped", width: 380, height: 260, PopoverView())

        control.start(.start, showLog: false)
        try await render("5-popover-starting", width: 380, height: 260, PopoverView())
        try await waitForRun()
        control.dismissRun()
        try await render("6-services-running", ServicesTab())

        _ = await control.saveEnv([("S3_PREFIX", "forecast/")])
        await control.testR2()
        try await render("7-storage", width: SettingsView.contentSize.width, height: 900, StorageTab())

        try await render("8-image", ImageTab())
        _ = await control.saveJob("gfs", arguments: ["--minutes", "0,30"])
        try await render("9-timetable", width: SettingsView.contentSize.width, height: 1100, TimetableTab())
        try await render("10-connection", ConnectionTab())

        try Data().write(to: dir.appending(path: "fake-setup/fail-image"))
        control.start(.image)
        try await waitForRun()
        try await render("11-log-sheet-failed", width: 620, height: 440, LogSheet(run: control.run!))
    }
}
