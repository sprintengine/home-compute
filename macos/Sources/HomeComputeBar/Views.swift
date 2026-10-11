import AppKit
import SwiftUI

struct PopoverView: View {
    @Environment(Store.self) private var store
    @Environment(ControlStore.self) private var control
    @Environment(\.openSettings) private var openSettings
    @State private var contentHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HeaderView()
                .padding(12)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    ServicesCard()
                    if !store.runningJobs.isEmpty {
                        RunningSection(jobs: store.runningJobs)
                    }
                    JobsSection(jobs: store.jobs)
                }
                .padding(12)
                .background(GeometryReader { proxy in
                    Color.clear.onAppear { contentHeight = proxy.size.height }
                        .onChange(of: proxy.size.height) { _, height in contentHeight = height }
                })
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(max(contentHeight, 60), 520))
            Divider()
            footer
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
        }
        .frame(width: 380)
        .onAppear {
            store.markSeen()
            Task { await control.refreshState() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
            store.markSeen()
            Task { await control.refreshState() }
        }
        .onChange(of: store.connection) {
            Task { await control.refreshState() }
        }
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let message = store.actionMessage {
                HStack(alignment: .top) {
                    Text(message).font(.caption).foregroundStyle(.red).textSelection(.enabled)
                    Spacer()
                    Button { store.actionMessage = nil } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                }
            }
            HStack {
                Button("Settings…") {
                    control.showLog = false
                    NSApp.activate()
                    openSettings()
                }
                .keyboardShortcut(",")
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
                    .keyboardShortcut("q")
            }
            .buttonStyle(.borderless)
        }
    }
}

// MARK: - Header

struct HeaderView: View {
    @Environment(Store.self) private var store

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Circle().fill(statusColor).frame(width: 9, height: 9)
                Text("Home Compute").font(.headline)
                Text(statusText).foregroundStyle(.secondary)
                Spacer()
                if store.isRefreshing {
                    ProgressView().controlSize(.small)
                } else {
                    Button {
                        Task { await store.refresh() }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .help("Refresh now")
                    .keyboardShortcut("r")
                }
            }
            HStack(spacing: 4) {
                Text(nodesText)
                if let updated = store.lastUpdated {
                    Text("·")
                    Text("Updated \(Fmt.clock(updated))")
                }
                Text("·")
                Text(store.streamConnected ? "Live" : "Polling")
                    .foregroundStyle(store.streamConnected ? .green : .secondary)
                    .help(store.streamConnected ? "Receiving server events" : "Event stream disconnected; polling every 15 s")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if let detail = detailText {
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(statusColor)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
        }
    }

    private var statusText: String {
        switch store.connection {
        case .connecting: "Connecting…"
        case .unauthorized: "Unauthorized"
        case .unreachable: "Unreachable"
        case .online: store.snapshot?.controller?.status == "degraded" ? "Degraded" : "Online"
        }
    }

    private var statusColor: Color {
        switch store.connection {
        case .connecting: .secondary
        case .unauthorized, .unreachable: .red
        case .online: store.snapshot?.controller?.status == "degraded" ? .orange : .green
        }
    }

    private var detailText: String? {
        switch store.connection {
        case .unreachable(let message): "\(message) (\(store.config.url))"
        case .unauthorized: "The controller rejected the API token. Open Settings to update it."
        case .online: store.snapshot?.controller?.clusterError.map { "Cluster: \($0)" }
        case .connecting: nil
        }
    }

    private var nodesText: String {
        guard let snapshot = store.snapshot else { return "No data" }
        let count = snapshot.nodeCount ?? snapshot.nodes.count
        let connected = snapshot.nodes.filter { $0.connection?.uppercased() == "CONNECTED" }.count
        let noun = count == 1 ? "node" : "nodes"
        if snapshot.nodes.isEmpty { return "\(count) \(noun)" }
        return connected == count ? "\(count) \(noun) connected" : "\(connected)/\(count) \(noun) connected"
    }
}

// MARK: - Services card

/// Shown above the jobs when Home Compute isn't running, isn't set up, or a start/stop is in progress.
struct ServicesCard: View {
    @Environment(Store.self) private var store
    @Environment(ControlStore.self) private var control
    @Environment(\.openSettings) private var openSettings

    private enum Mode {
        case run(LongRun)
        case notSetUp
        case starting
        case stopped(String)
        case unreachableNoScript
    }

    var body: some View {
        if let mode {
            VStack(alignment: .leading, spacing: 8) {
                content(mode)
            }
            .font(.callout)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(tint(mode).opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        }
    }

    private var unreachable: Bool {
        if case .unreachable = store.connection { return true }
        return false
    }

    private var mode: Mode? {
        if let run = control.run, run.isRunning || run.finished.map({ Date.now.timeIntervalSince($0) < 600 }) == true {
            return .run(run)
        }
        guard control.script != nil else { return unreachable ? .unreachableNoScript : nil }
        guard let state = control.state else { return unreachable ? .stopped("The scheduler isn't answering.") : nil }
        if !state.isSetUp { return .notSetUp }
        if state.isStarting { return .starting }
        if state.isStopped || unreachable {
            let services = state.services
            let stopped = [("Colima", services?.colima?.state), ("Bacalhau", services?.bacalhau?.state),
                           ("scheduler", services?.controller?.state)]
                .filter { ["stopped", "missing"].contains($0.1?.lowercased() ?? "") }
                .map(\.0)
            return .stopped(stopped.isEmpty ? "The scheduler isn't answering."
                            : "Not running: " + stopped.joined(separator: ", "))
        }
        return nil
    }

    private func tint(_ mode: Mode) -> Color {
        switch mode {
        case .run(let run): run.isRunning ? .blue : (run.succeeded ? .green : .red)
        case .notSetUp, .starting: .orange
        case .stopped, .unreachableNoScript: .red
        }
    }

    @ViewBuilder private func content(_ mode: Mode) -> some View {
        switch mode {
        case .run(let run):
            HStack(spacing: 8) {
                if run.isRunning {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: run.succeeded ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(run.succeeded ? .green : .red)
                }
                Text(run.statusText).fontWeight(.semibold)
                Spacer()
                Button("Show log") { open(.services, showLog: true) }
                    .buttonStyle(.borderless)
                if !run.isRunning {
                    Button { control.dismissRun() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                }
            }
            if let line = run.lastLine {
                Text(line).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(2)
            }
        case .notSetUp:
            HStack {
                Label("Not set up yet", systemImage: "wrench.and.screwdriver").fontWeight(.semibold)
                Spacer()
                Button("Set up…") { open(.services) }
            }
        case .starting:
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Scheduler starting…").fontWeight(.semibold)
                Spacer()
                Button("Open settings") { open(.services) }.buttonStyle(.borderless)
            }
        case .stopped(let detail):
            HStack {
                StateDot(color: .red)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Scheduler stopped").fontWeight(.semibold)
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Open settings") { open(.services) }.buttonStyle(.borderless)
                Button("Start") { control.start(.start, showLog: false) }
                    .buttonStyle(.borderedProminent)
                    .disabled(control.isRunning)
            }
        case .unreachableNoScript:
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Can't reach the scheduler").fontWeight(.semibold)
                    Text("Choose the setup script in Settings to start it from here.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Open settings") { open(.connection) }
            }
        }
    }

    private func open(_ tab: ControlStore.Tab, showLog: Bool = false) {
        control.selectedTab = tab
        control.showLog = showLog && control.run != nil
        NSApp.activate()
        openSettings()
    }
}

// MARK: - Running now

struct RunningSection: View {
    let jobs: [Job]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Running now")
            ForEach(jobs) { job in
                HStack(spacing: 10) {
                    ProgressView().controlSize(.small)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(job.id).fontWeight(.medium)
                        Text(([job.liveState ?? "Running"] + job.models.map(Fmt.modelName)).joined(separator: " · "))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    if let started = job.lastSubmittedAt {
                        TimelineView(.periodic(from: .now, by: 1)) { context in
                            Text(Fmt.duration(context.date.timeIntervalSince(started)))
                                .font(.callout.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }
                        .help("Submitted \(started.formatted(date: .abbreviated, time: .standard))")
                    }
                }
                .padding(8)
                .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

// MARK: - Jobs

struct JobsSection: View {
    let jobs: [Job]

    /// Jobs switched off in the timetable never run, so they get one line at the end, not a row each.
    private var active: [Job] { jobs.filter { !$0.isOff } }
    private var off: [Job] { jobs.filter(\.isOff) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionTitle("Jobs")
            if active.isEmpty {
                Text("No jobs").foregroundStyle(.secondary).font(.callout)
            }
            ForEach(active) { job in
                JobRow(job: job)
                if job.id != active.last?.id { Divider() }
            }
            if !off.isEmpty {
                Divider()
                Label {
                    Text("Off: " + off.map(\.id).joined(separator: ", "))
                } icon: {
                    Image(systemName: "pause.circle")
                }
                .font(.caption)
                .foregroundStyle(.secondary)
                .help("Switched off in the timetable. Turn one back on in Settings › Timetable.")
            }
        }
    }
}

struct JobRow: View {
    @Environment(Store.self) private var store
    let job: Job

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(alignment: .top, spacing: 8) {
                details(now: context.date)
                Spacer(minLength: 4)
                actions
            }
        }
        .opacity(job.isPaused ? 0.55 : 1)
        .contextMenu { actionItems }
    }

    private func details(now: Date) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(job.id).fontWeight(.semibold)
                if job.isPaused { Tag(text: "Paused", color: .orange) }
                if job.isRunning { Tag(text: "Running", color: .blue) }
                ForEach(job.models, id: \.self) { Tag(text: Fmt.modelName($0), color: .secondary) }
            }
            if let description = job.description {
                Text(description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
            Label {
                Text(scheduleLine(now: now))
            } icon: {
                Image(systemName: "clock")
            }
            .font(.caption)
            .foregroundStyle(.secondary)

            let style = OutcomeStyle(job: job)
            HStack(spacing: 5) {
                Circle().fill(style.color).frame(width: 7, height: 7)
                Text(style.label).foregroundStyle(style.color == .secondary ? .secondary : style.color)
                if let finished = job.lastFinishedAt {
                    Text("· \(Fmt.relative(finished, now: now))").foregroundStyle(.secondary)
                }
            }
            .font(.caption)
            .help(job.failureDetail.isEmpty ? style.label : job.failureDetail)

            ForEach((job.published ?? [:]).sorted { $0.key < $1.key }, id: \.key) { model, run in
                HStack(spacing: 4) {
                    Text(Fmt.modelName(model)).fontWeight(.medium)
                    Text(Fmt.modelRun(run.run))
                    if let at = run.at {
                        Text("· fetched \(Fmt.relative(at, now: now))").foregroundStyle(.secondary)
                    }
                }
                .font(.caption2.monospacedDigit())
                .help(run.seconds.map { "Import took \(Int($0)) s" } ?? "")
            }
        }
    }

    private func scheduleLine(now: Date) -> String {
        var line = Fmt.schedule(job.schedule)
        if job.isPaused { return line }
        if let next = job.nextDueAt {
            line += " · next " + (next <= now ? "due now" : Fmt.relative(next, now: now))
        }
        return line
    }

    @ViewBuilder private var actions: some View {
        if store.busyJobs.contains(job.id) {
            ProgressView().controlSize(.small)
        } else {
            Menu {
                actionItems
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
    }

    @ViewBuilder private var actionItems: some View {
        Button("Run now") { act(.run) }
            .disabled(job.isRunning)
        if job.isPaused {
            Button("Resume") { act(.resume) }
        } else {
            Button("Pause") { act(.pause) }
        }
    }

    private func act(_ action: JobAction) {
        Task { await store.perform(action, job: job.id) }
    }
}

struct Tag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, 5)
            .padding(.vertical, 1)
            .foregroundStyle(color)
            .background(color.opacity(0.12), in: Capsule())
    }
}

struct SectionTitle: View {
    let title: String
    init(_ title: String) { self.title = title }

    var body: some View {
        Text(title.uppercased())
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }
}
