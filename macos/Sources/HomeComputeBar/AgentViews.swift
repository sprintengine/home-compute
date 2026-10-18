import AppKit
import ServiceManagement
import SwiftUI

// Agent mode's UI: the popover (what runs now, recent runs, whether the agent is connected, and
// the quick actions), the run history window, and the Agent settings tab.

struct AgentPopoverView: View {
    @Environment(AgentStore.self) private var agent
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            AgentHeader()
                .padding(12)
            Divider()
            VStack(alignment: .leading, spacing: 14) {
                AgentStateCard()
                if let running = agent.status?.running, !running.isEmpty {
                    AgentRunningSection(runs: running)
                }
                if agent.connection == .ok || !agent.history.isEmpty {
                    AgentRecentSection(entries: Array(agent.history.prefix(6))) { entry in
                        agent.selectedRun = entry.run
                        showHistory()
                    }
                }
            }
            .padding(12)
            Divider()
            footer
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
        }
        .frame(width: 380)
        .onAppear {
            agent.markSeen()
            Task { await agent.refresh() }
        }
    }

    private func showHistory() {
        HistoryWindowController.shared.show(agent)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let message = agent.actionMessage {
                HStack(alignment: .top) {
                    Text(message).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    Spacer()
                    Button { agent.actionMessage = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                }
            }
            HStack(spacing: 10) {
                pauseButton
                Menu("Restart agent") {
                    Button("Restart now") { Task { await agent.restart() } }
                        .help("Running jobs carry on; the agent picks them up again when it is back.")
                    if agent.connection == .ok {
                        if agent.status?.draining == true {
                            Button("Cancel restart when idle") { Task { await agent.setDraining(false) } }
                        } else {
                            Button("Restart when the running jobs finish") { Task { await agent.setDraining(true) } }
                        }
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                .disabled(agent.busy || (agent.connection != .ok && agent.settings.restartLabel == nil))
                Spacer()
                if agent.busy { ProgressView().controlSize(.small) }
            }
            HStack(spacing: 12) {
                Button("Dashboard") { agent.openDashboard() }
                    .keyboardShortcut("d")
                    .disabled(agent.dashboardURL == nil)
                    .help(agent.dashboardURL?.absoluteString ?? "The agent does not know the dashboard's address yet")
                Button("Log") { agent.openLog() }
                    .keyboardShortcut("l")
                    .help(agent.logFileURL?.path ?? "The agent's log")
                Button("History…") { showHistory() }
                    .keyboardShortcut("y")
                Button("Settings…") {
                    NSApp.activate()
                    openSettings()
                }
                .keyboardShortcut(",")
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut("q")
            }
        }
        .buttonStyle(.borderless)
    }

    @ViewBuilder private var pauseButton: some View {
        if agent.status?.paused == true {
            Button("Resume taking jobs") { Task { await agent.setPaused(false) } }
                .disabled(agent.busy)
        } else {
            Button("Pause taking jobs") { Task { await agent.setPaused(true) } }
                .disabled(agent.busy || agent.connection != .ok)
                .help("Claim nothing new until resumed, across restarts. Running jobs finish.")
        }
    }
}

// MARK: - Header

struct AgentHeader: View {
    @Environment(AgentStore.self) private var agent

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle().fill(color).frame(width: 9, height: 9)
                Text(agent.status?.name ?? "Home Compute").font(.headline)
                Text(title).foregroundStyle(.secondary)
                Spacer()
                Button {
                    Task { await agent.refresh() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh now")
                .keyboardShortcut("r")
            }
            TimelineView(.periodic(from: .now, by: 5)) { context in
                Text(subtitle(now: context.date))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
        }
    }

    private var title: String {
        switch agent.connection {
        case .connecting: "Connecting…"
        case .setup: "Not set up"
        case .notRunning: "Agent not running"
        case .unauthorized: "Token refused"
        case .ok: agent.status?.connected == true ? "Connected" : "Control plane unreachable"
        }
    }

    private var color: Color {
        switch agent.connection {
        case .connecting, .setup: .secondary
        case .notRunning, .unauthorized: .red
        case .ok: agent.status?.connected == true ? .green : .orange
        }
    }

    private func subtitle(now: Date) -> String {
        guard let status = agent.status else {
            return "Agent mode · \((agent.settings.resolvedStateDir as NSString).abbreviatingWithTildeInPath)"
        }
        var parts = [String]()
        if let runtime = status.runtimeKind { parts.append(runtime == "colima" ? "Colima \(status.vmState ?? "")".trimmingCharacters(in: .whitespaces) : runtime) }
        parts.append(status.lastSyncAt.map { "synced \(Fmt.relative($0, now: now))" } ?? "not synced yet")
        if let version = status.agentVersion { parts.append("agent \(version)") }
        if status.outbox > 0 { parts.append("\(status.outbox) result\(status.outbox == 1 ? "" : "s") waiting to send") }
        return parts.joined(separator: " · ")
    }
}

// MARK: - State card

/// Shown when the agent is not running, not set up, offline, paused or draining.
struct AgentStateCard: View {
    @Environment(AgentStore.self) private var agent
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        if let card {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: card.symbol).foregroundStyle(card.tint)
                VStack(alignment: .leading, spacing: 2) {
                    Text(card.title).fontWeight(.semibold)
                    if let detail = card.detail {
                        Text(detail).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).lineLimit(4)
                    }
                }
                Spacer(minLength: 4)
                actions
            }
            .font(.callout)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(card.tint.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private struct Card {
        var symbol: String
        var tint: Color
        var title: String
        var detail: String?
    }

    private var card: Card? {
        switch agent.connection {
        case .connecting: return nil
        case .setup(let detail): return Card(symbol: "wrench.and.screwdriver", tint: .orange, title: "Agent not set up", detail: detail)
        case .notRunning(let detail):
            return Card(symbol: "exclamationmark.triangle.fill", tint: .red, title: "The agent is not running", detail: detail)
        case .unauthorized:
            return Card(symbol: "lock.trianglebadge.exclamationmark", tint: .red, title: "The agent refused the token",
                        detail: "Check the token file in Settings › Agent.")
        case .ok: break
        }
        guard let status = agent.status else { return nil }
        if !status.connected {
            return Card(symbol: "icloud.slash", tint: .orange, title: "Can't reach the control plane",
                        detail: status.lastError ?? "Jobs already running carry on; results wait to be sent.")
        }
        if status.draining {
            let jobs = status.running.map(\.job)
            return Card(symbol: "arrow.triangle.2.circlepath", tint: .blue, title: "Restarting when idle",
                        detail: jobs.isEmpty ? "Sending the last results." : "Waiting for \(jobs.joined(separator: ", ")) to finish. No new jobs meanwhile.")
        }
        if status.paused {
            let since = status.pausedAt.map { " since \(Fmt.clock($0))" } ?? ""
            return Card(symbol: "pause.circle.fill", tint: .orange, title: "Not taking jobs", detail: "Paused on this Mac\(since). Running jobs finish.")
        }
        if let text = status.notClaimingText {
            return Card(symbol: "pause.circle", tint: .orange, title: "Not taking jobs", detail: text)
        }
        return nil
    }

    @ViewBuilder private var actions: some View {
        switch agent.connection {
        case .notRunning:
            if agent.settings.restartLabel != nil {
                Button("Start") { Task { await agent.restart() } }.buttonStyle(.borderedProminent).disabled(agent.busy)
            }
        case .setup, .unauthorized:
            Button("Settings…") {
                NSApp.activate()
                openSettings()
            }
        case .ok:
            if agent.status?.paused == true, agent.status?.connected == true {
                Button("Resume") { Task { await agent.setPaused(false) } }.disabled(agent.busy)
            } else if agent.status?.draining == true {
                Button("Cancel") { Task { await agent.setDraining(false) } }.disabled(agent.busy)
            }
        case .connecting:
            EmptyView()
        }
    }
}

// MARK: - Running now

struct AgentRunningSection: View {
    let runs: [AgentRun]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Running now")
            ForEach(runs) { run in
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(run.job).fontWeight(.medium)
                        Text(([run.phaseText] + [run.statsText].compactMap { $0 }).joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let since = run.since {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(Fmt.duration(context.date.timeIntervalSince(since)))
                                .font(.callout.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        .help("Claimed \(since.formatted(date: .abbreviated, time: .standard))\(run.image.map { "\n\($0)" } ?? "")")
                    }
                }
                .padding(8)
                .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

// MARK: - Recent runs

struct AgentRecentSection: View {
    let entries: [AgentHistoryEntry]
    let open: (AgentHistoryEntry) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionTitle("Recent runs")
            if entries.isEmpty {
                Text("No runs on this Mac yet").font(.callout).foregroundStyle(.secondary)
            }
            TimelineView(.periodic(from: .now, by: 30)) { context in
                VStack(alignment: .leading, spacing: 5) {
                    ForEach(entries) { entry in
                        row(entry, now: context.date)
                    }
                }
            }
        }
    }

    private func row(_ entry: AgentHistoryEntry, now: Date) -> some View {
        Button {
            open(entry)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                AgentMark(entry: entry)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(entry.job).fontWeight(.medium)
                        Text(entry.outcomeText).foregroundStyle(entry.isFailed ? .red : .secondary).lineLimit(1)
                        Spacer(minLength: 4)
                        if let duration = entry.duration { Text(Fmt.duration(duration)).foregroundStyle(.secondary) }
                        Text(Fmt.relative(entry.finishedAt, now: now)).foregroundStyle(.secondary)
                    }
                    if entry.isFailed, let error = entry.error {
                        Text(error).font(.caption2).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
                    }
                }
            }
            .font(.caption.monospacedDigit())
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(entry.helpText)
    }
}

struct AgentMark: View {
    let entry: AgentHistoryEntry

    var body: some View {
        Text(entry.mark)
            .font(.callout.weight(.bold))
            .foregroundStyle(entry.passed == true ? .green : entry.passed == false ? .red : .secondary)
            .frame(width: 14)
            .accessibilityLabel(entry.passed == true ? "Passed" : entry.passed == false ? "Failed" : "Cancelled")
    }
}

// MARK: - History window

/// The run history window, made once and brought forward again (an AppKit window, so it never
/// opens on its own at launch as a SwiftUI window scene can in a menu bar app).
@MainActor
final class HistoryWindowController {
    static let shared = HistoryWindowController()
    private var window: NSWindow?

    func show(_ agent: AgentStore) {
        if window == nil {
            let host = NSHostingController(rootView: AgentHistoryWindow().environment(agent))
            let window = NSWindow(contentViewController: host)
            window.title = "Home Compute: runs on this Mac"
            window.styleMask = [.titled, .closable, .resizable, .miniaturizable]
            window.setContentSize(NSSize(width: 820, height: 520))
            window.isReleasedWhenClosed = false
            window.center()
            self.window = window
        }
        NSApp.activate()
        window?.makeKeyAndOrderFront(nil)
    }
}

struct AgentHistoryWindow: View {
    @Environment(AgentStore.self) private var agent

    var body: some View {
        @Bindable var agent = agent
        HSplitView {
            List(agent.history, selection: $agent.selectedRun) { entry in
                HStack(spacing: 6) {
                    AgentMark(entry: entry)
                    VStack(alignment: .leading, spacing: 1) {
                        HStack {
                            Text(entry.job).fontWeight(.medium)
                            Spacer()
                            Text(entry.finishedAt.map { $0.formatted(date: .abbreviated, time: .shortened) } ?? "-")
                                .foregroundStyle(.secondary)
                        }
                        Text(entry.isFailed ? (entry.error ?? entry.outcomeText) : entry.outcomeText)
                            .font(.caption).foregroundStyle(entry.isFailed ? .red : .secondary).lineLimit(1)
                    }
                }
                .font(.callout.monospacedDigit())
                .tag(entry.run)
            }
            .frame(minWidth: 260, idealWidth: 300)
            Group {
                if let entry = agent.history.first(where: { $0.run == agent.selectedRun }) ?? agent.history.first {
                    AgentRunDetail(entry: entry)
                } else {
                    Text("No runs on this Mac yet").foregroundStyle(.secondary).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(minWidth: 380, idealWidth: 460)
        }
        .frame(minWidth: 680, minHeight: 420)
        .onAppear { Task { await agent.refresh() } }
    }
}

struct AgentRunDetail: View {
    @Environment(AgentStore.self) private var agent
    let entry: AgentHistoryEntry

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    AgentMark(entry: entry).font(.title2)
                    Text(entry.job).font(.title2.weight(.semibold))
                    Text(entry.outcomeText).foregroundStyle(entry.isFailed ? .red : .secondary)
                    Spacer()
                }
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 4) {
                    row("Run", entry.run + (entry.attempt.map { " (attempt \($0))" } ?? ""))
                    row("Claimed", entry.claimedAt.map(Self.time))
                    row("Started", entry.startedAt.map(Self.time))
                    row("Finished", entry.finishedAt.map(Self.time))
                    row("Duration", entry.duration.map(Fmt.duration))
                    row("Exit code", entry.exitCode.map(String.init))
                    row("Peak memory", entry.peakMemoryBytes.map(Fmt.memory))
                    row("Average CPU", entry.avgCpuPct.map { "\(Int($0.rounded()))%" })
                    row("Image", entry.image)
                    row("Digest", entry.digest)
                    row("Control plane", entry.reportedState.map { state in
                        "has it (\(state))" + (entry.reportedAt.map { ", \(Self.time($0))" } ?? "")
                    } ?? "not sent yet")
                }
                .font(.callout)
                if entry.isFailed {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle("Error")
                        Text(entry.fullError)
                            .font(.callout.monospaced())
                            .textSelection(.enabled)
                            .padding(8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(.red.opacity(0.07), in: RoundedRectangle(cornerRadius: 6))
                    }
                }
                HStack {
                    Button("Open in dashboard") { agent.openRun(entry.run) }
                        .disabled(agent.dashboardURL == nil)
                    if entry.isFailed {
                        Button("Copy error") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(entry.fullError, forType: .string)
                        }
                    }
                    Spacer()
                }
            }
            .padding(16)
        }
    }

    @ViewBuilder private func row(_ label: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            GridRow {
                Text(label).foregroundStyle(.secondary)
                Text(value).textSelection(.enabled).lineLimit(2).truncationMode(.middle)
            }
        }
    }

    private static func time(_ date: Date) -> String { date.formatted(date: .abbreviated, time: .standard) }
}

// MARK: - Settings

struct AgentSettingsTab: View {
    @Environment(AgentStore.self) private var agent
    @Environment(AppModel.self) private var app
    @State private var draft = AgentSettings()
    @State private var port = ""
    @State private var saveError: String?
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginMessage: String?

    private var isBundled: Bool { Bundle.main.bundleIdentifier != nil }

    var body: some View {
        Form {
            Section("Show") {
                Picker("Mode", selection: Binding(get: { app.mode }, set: { app.switchMode($0) })) {
                    ForEach(AppMode.allCases) { Text($0.title).tag($0) }
                }
            }
            Section {
                TextField("State directory", text: $draft.stateDir, prompt: Text(AgentSettings.defaultStateDir))
                TextField("Status port", text: $port, prompt: Text("statusPort from the agent's config.json"))
                TextField("Token file", text: $draft.tokenFile, prompt: Text("<state directory>/status-token"))
                LabeledContent("Status API") {
                    Text(endpointText).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
            } header: {
                Text("Agent")
            } footer: {
                Text("The agent's local status API listens on 127.0.0.1 only and needs the token in its 0600 status-token file.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Section("Quick actions") {
                TextField("Dashboard", text: $draft.dashboardUrl, prompt: Text(agent.status?.dashboardUrl ?? "the address hc-core reports"))
                TextField("Log file", text: $draft.logFile, prompt: Text(agent.status?.logFile ?? AgentSettings.defaultLogFile))
                TextField("LaunchAgent", text: $draft.launchdLabel, prompt: Text(draft.usesDefaultStateDir ? AgentSettings.defaultLaunchdLabel : "none"))
                    .help("Restart agent kickstarts this LaunchAgent when the agent itself does not answer.")
            }
            Section("Notifications") {
                Toggle("Notify when a job fails on this Mac", isOn: $draft.notifyOnFailure)
                if !isBundled {
                    Text("Notifications need the .app bundle (build-app.sh); they are skipped for the bare binary.")
                        .font(.caption).foregroundStyle(.orange)
                }
            }
            Section("General") {
                Toggle("Launch at login", isOn: Binding(get: { launchAtLogin }, set: { setLaunchAtLogin($0) }))
                    .disabled(!isBundled)
                if let loginMessage { Text(loginMessage).font(.caption).foregroundStyle(.orange) }
                LabeledContent("Config file") { Text(ConfigFile.url.path).font(.caption).textSelection(.enabled) }
            }
            HStack {
                if let saveError { Text(saveError).font(.caption).foregroundStyle(.red) }
                Spacer()
                Button("Revert") { load() }
                Button("Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(edited == agent.settings)
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: load)
    }

    private var edited: AgentSettings {
        var copy = draft
        copy.port = Int(port.trimmingCharacters(in: .whitespaces))
        return copy
    }

    private var endpointText: String {
        switch AgentEndpoint.resolve(edited) {
        case .success(let endpoint): "\(endpoint.baseURL.absoluteString) (token found)"
        case .failure(let problem): problem.localizedDescription
        }
    }

    private func load() {
        draft = agent.settings
        port = agent.settings.port.map(String.init) ?? ""
        saveError = nil
        launchAtLogin = SMAppService.mainApp.status == .enabled
        loginMessage = isBundled ? (SMAppService.mainApp.status == .requiresApproval
            ? "Approve Home Compute Bar in System Settings › General › Login Items." : nil)
            : "Launch at login is only available when running the .app bundle."
    }

    private func save() {
        do {
            try agent.update(edited)
            saveError = nil
        } catch {
            saveError = "Could not save: \(error.localizedDescription)"
        }
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
            loginMessage = nil
        } catch {
            loginMessage = "Launch at login failed: \(error.localizedDescription)"
        }
        launchAtLogin = SMAppService.mainApp.status == .enabled
    }
}
