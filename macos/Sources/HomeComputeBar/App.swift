import AppKit
import SwiftUI

@main
struct HomeComputeBarApp: App {
    @State private var store = Store.shared
    @State private var control = ControlStore.shared

    var body: some Scene {
        MenuBarExtra {
            PopoverView()
                .environment(store)
                .environment(control)
        } label: {
            MenuBarLabel(store: store, control: control)
        }
        .menuBarExtraStyle(.window)

        Settings {
            SettingsView()
                .environment(store)
                .environment(control)
        }
    }
}

/// The status item: a template SF Symbol that cycles while jobs run, with an optional
/// running count and a red dot for failures not yet seen in the popover.
struct MenuBarLabel: View {
    let store: Store
    let control: ControlStore
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        let running = store.runningJobs.count
        Image(nsImage: StatusIcon.make(
            symbol: store.iconSymbol,
            badge: running > 1 ? "\(running)" : nil,
            dot: store.unseenFailures > 0))
            .accessibilityLabel("Home Compute")
            .task {
                // Have the services state ready for the popover's first open.
                await control.refreshState()
                openSettingsForDevelopment()
            }
    }

    /// `HOME_COMPUTE_BAR_OPEN_SETTINGS=services|storage|image|timetable|connection` opens the
    /// settings window on that tab at launch (for development and testing).
    private func openSettingsForDevelopment() {
        guard let name = ProcessInfo.processInfo.environment["HOME_COMPUTE_BAR_OPEN_SETTINGS"], !name.isEmpty else { return }
        let tabs: [String: ControlStore.Tab] = ["services": .services, "storage": .storage, "image": .image,
                                                 "timetable": .timetable, "connection": .connection]
        control.selectedTab = tabs[name.lowercased()] ?? .services
        NSApp.activate()
        openSettings()
    }
}

@MainActor
enum StatusIcon {
    private static let height: CGFloat = 18
    private static let symbolWidth: CGFloat = 22

    static func make(symbol: String, badge: String?, dot: Bool) -> NSImage {
        let base = NSImage(systemSymbolName: symbol, accessibilityDescription: "Home Compute")?
            .withSymbolConfiguration(.init(pointSize: 14, weight: .medium)) ?? NSImage()
        let text = badge.map {
            NSAttributedString(string: $0, attributes: [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .semibold),
                .foregroundColor: NSColor.black,
            ])
        }
        let textWidth = text.map { ceil($0.size().width) + 1 } ?? 0
        let size = NSSize(width: symbolWidth + textWidth, height: height)

        let image = NSImage(size: size, flipped: false) { _ in
            // Template images only use alpha; with a coloured dot the image can't be a template,
            // so draw the glyph in the menu bar's text colour (resolved at draw time) instead.
            let ink: NSColor = dot ? .labelColor : .black
            let glyph = dot ? (base.withSymbolConfiguration(.init(paletteColors: [ink])) ?? base) : base
            let origin = NSPoint(x: (symbolWidth - glyph.size.width) / 2, y: (height - glyph.size.height) / 2)
            glyph.draw(in: NSRect(origin: origin, size: glyph.size))
            if let text {
                let colored = NSMutableAttributedString(attributedString: text)
                colored.addAttribute(.foregroundColor, value: ink, range: NSRange(location: 0, length: colored.length))
                colored.draw(at: NSPoint(x: symbolWidth, y: (height - colored.size().height) / 2))
            }
            if dot {
                NSColor.systemRed.setFill()
                NSBezierPath(ovalIn: NSRect(x: symbolWidth - 7, y: height - 7, width: 6, height: 6)).fill()
            }
            return true
        }
        image.isTemplate = !dot
        return image
    }
}
