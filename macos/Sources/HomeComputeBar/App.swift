import AppKit
import SwiftUI

/// Which face the app shows (`AppMode`), switched from Settings without a restart.
@MainActor @Observable
final class AppModel {
    static let shared = AppModel()
    private(set) var mode: AppMode

    private init() {
        mode = ConfigFile.load().resolvedMode
        Log.info("mode: \(mode.rawValue)")
    }

    /// Starts the store of the current mode and stops the other's polling.
    func activate() {
        switch mode {
        case .agent:
            Store.shared.setActive(false)
            AgentStore.shared.start()
        case .controller:
            AgentStore.shared.stop()
            Store.shared.setActive(true)
        }
    }

    func switchMode(_ new: AppMode) {
        guard new != mode else { return }
        var config = ConfigFile.load()
        config.mode = new
        do {
            try ConfigFile.save(config)
        } catch {
            Log.info("could not save mode: \(error.localizedDescription)")
        }
        mode = new
        activate()
    }
}

@main
struct HomeComputeBarApp: App {
    @State private var app = AppModel.shared
    @State private var store = Store.shared
    @State private var control = ControlStore.shared
    @State private var agent = AgentStore.shared

    init() {
        AppModel.shared.activate()
    }

    var body: some Scene {
        MenuBarExtra {
            Group {
                if app.mode == .agent {
                    AgentPopoverView()
                } else {
                    PopoverView()
                }
            }
            .environment(app)
            .environment(store)
            .environment(control)
            .environment(agent)
        } label: {
            if app.mode == .agent {
                AgentMenuBarLabel(agent: agent)
            } else {
                MenuBarLabel(store: store, control: control)
            }
        }
        .menuBarExtraStyle(.window)

        Settings {
            Group {
                if app.mode == .agent {
                    AgentSettingsTab()
                        .frame(width: 560, height: 640)
                } else {
                    SettingsView()
                }
            }
            .environment(app)
            .environment(store)
            .environment(control)
            .environment(agent)
        }
    }
}

/// Agent mode's status item: a box that fills and empties while a job runs, with the job's
/// name beside it; a pause sign, a cloud with a slash (control plane unreachable) or a warning
/// (agent not running); a red dot for failures not yet seen in the popover.
struct AgentMenuBarLabel: View {
    let agent: AgentStore

    var body: some View {
        let image = Image(nsImage: StatusIcon.make(symbol: agent.iconSymbol, badge: nil, dot: agent.unseenFailures > 0))
            .accessibilityLabel("Home Compute")
        if let title = agent.iconTitle {
            HStack(spacing: 2) {
                image
                Text(title).monospacedDigit()
            }
        } else {
            image
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
