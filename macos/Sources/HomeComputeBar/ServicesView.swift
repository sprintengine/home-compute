import AppKit
import SwiftUI

// MARK: - Shared pieces

struct StateDot: View {
    let color: Color
    var body: some View { Circle().fill(color).frame(width: 9, height: 9) }
}

enum ServiceStyle {
    static func color(_ state: String?) -> Color {
        switch state?.lowercased() {
        case "running": .green
        case "starting": .orange
        case "stopped": .red
        case "missing": .red
        default: .secondary
        }
    }

    static func label(_ state: String?) -> String {
        switch state?.lowercased() {
        case "running": "Running"
        case "starting": "Starting"
        case "stopped": "Stopped"
        case "missing": "Not installed"
        case let other?: other.capitalized
        case nil: "Unknown"
        }
    }
}

/// Shown on every control tab until a setup script has been chosen.
struct ScriptMissingView: View {
    @Environment(ControlStore.self) private var control
    @State private var error: String?

    var body: some View {
        ContentUnavailableView {
            Label("Choose the setup script", systemImage: "terminal")
        } description: {
            Text("The control panel runs deploy/home-compute/macmini.sh from your wingfoil checkout "
                 + "to set up, start and configure Home Compute on this Mac.")
        } actions: {
            Button("Choose macmini.sh…") { error = control.chooseScript() }
                .buttonStyle(.borderedProminent)
            if let error {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
    }
}

/// "Restart the scheduler to apply" with a button, after config or .env changes.
struct RestartBanner: View {
    @Environment(ControlStore.self) private var control

    var body: some View {
        if control.restartPending {
            HStack(spacing: 8) {
                Image(systemName: "arrow.triangle.2.circlepath").foregroundStyle(.orange)
                Text("Restart the scheduler to apply your changes.")
                Spacer()
                Button("Later") { control.restartPending = false }
                    .buttonStyle(.borderless)
                Button("Restart scheduler") { control.start(.restartController) }
                    .disabled(control.isRunning)
            }
            .font(.callout)
            .padding(10)
            .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

/// A long command running in the background while its log sheet is hidden.
struct RunBanner: View {
    @Environment(ControlStore.self) private var control

    var body: some View {
        if let run = control.run, !control.showLog, run.isRunning || run.finished.map({ Date.now.timeIntervalSince($0) < 600 }) == true {
            HStack(spacing: 8) {
                if run.isRunning {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: run.succeeded ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(run.succeeded ? .green : .red)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(run.statusText).fontWeight(.medium)
                    if run.isRunning, let line = run.lastLine {
                        Text(line).font(.caption.monospaced()).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                Button("Show log") { control.showLog = true }
                if !run.isRunning {
                    Button { control.dismissRun() } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                }
            }
            .font(.callout)
            .padding(10)
            .background(.blue.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
        }
    }
}

struct ErrorLine: View {
    let text: String?
    var body: some View {
        if let text {
            Label(text, systemImage: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.red)
                .textSelection(.enabled)
        }
    }
}

// MARK: - Log sheet

struct LogSheet: View {
    @Environment(ControlStore.self) private var control
    let run: LongRun

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if run.isRunning {
                    ProgressView().controlSize(.small)
                } else {
                    Image(systemName: run.succeeded ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(run.succeeded ? .green : .red)
                }
                Text(run.statusText).font(.headline)
                Spacer()
                Text("macmini.sh " + run.command.arguments.joined(separator: " "))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        ForEach(run.lines) { line in
                            Text(line.text.isEmpty ? " " : line.text)
                                .font(.system(.caption, design: .monospaced))
                                .fixedSize(horizontal: false, vertical: true)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .id(line.id)
                        }
                    }
                    .textSelection(.enabled)
                    .padding(8)
                }
                .background(Color(nsColor: .textBackgroundColor))
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(.separator))
                .onChange(of: run.lines.last?.id) { _, last in
                    if let last { proxy.scrollTo(last, anchor: .bottomLeading) }
                }
                .onAppear {
                    if let last = run.lines.last?.id { proxy.scrollTo(last, anchor: .bottomLeading) }
                }
            }
            HStack {
                if run.isRunning {
                    Text("This can take several minutes. You can hide this window; the command keeps running.")
                        .font(.caption).foregroundStyle(.secondary)
                } else if let finished = run.finished {
                    Text("Finished after \(Fmt.duration(finished.timeIntervalSince(run.started)))")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Button("Copy log") {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(run.lines.map(\.text).joined(separator: "\n"), forType: .string)
                }
                if run.isRunning {
                    Button("Hide") { control.showLog = false }
                } else {
                    Button("Close") { control.showLog = false }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(16)
        .frame(width: 620, height: 440)
        .interactiveDismissDisabled(run.isRunning)
    }
}

// MARK: - Services

struct ServicesTab: View {
    @Environment(ControlStore.self) private var control
    @State private var confirmStop = false
    @State private var logError: String?

    var body: some View {
        if control.script == nil {
            ScriptMissingView()
        } else {
            Form {
                if control.restartPending || control.run != nil {
                    Section {
                        RestartBanner()
                        RunBanner()
                    }
                }
                if let setup = control.state?.setup, setup.complete == false {
                    SetupSection(setup: setup, image: control.state?.image)
                }
                servicesSection
                colimaSection
                logsSection
                if control.state?.setup?.complete == true {
                    Section {
                        HStack {
                            Text("Run setup again to install anything missing and rewrite the launch agents. "
                                 + "It keeps the existing .env and starts nothing.")
                                .font(.caption).foregroundStyle(.secondary)
                            Spacer()
                            Button("Run setup again…") { control.start(.setup) }
                                .disabled(control.isRunning)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .confirmationDialog("Stop Home Compute?", isPresented: $confirmStop) {
                Button("Stop all", role: .destructive) { control.start(.stop) }
            } message: {
                Text("A forecast import that is already running keeps going until it finishes, "
                     + "but no new jobs are submitted until you start Home Compute again.")
            }
        }
    }

    private var services: SetupState.Services? { control.state?.services }

    private var servicesSection: some View {
        Section {
            ServiceRow(name: "Colima", role: "Docker VM the jobs run in",
                       state: services?.colima?.state, detail: colimaDetail)
            ServiceRow(name: "Bacalhau", role: "Runs the worker containers",
                       state: services?.bacalhau?.state, detail: bacalhauDetail)
            ServiceRow(name: "Scheduler", role: "Home Compute controller; submits jobs on the timetable",
                       state: services?.controller?.state, detail: controllerDetail)
            HStack {
                Button("Start all") { control.start(.start) }
                Button("Stop all…") { confirmStop = true }
                Button("Restart") { control.start(.restart) }
                Spacer()
                Button("Restart scheduler only") { control.start(.restartController) }
                    .help("Restart only the controller so it reads jobs.toml and .env again")
            }
            .disabled(control.isRunning || control.state?.setup?.complete == false)
        } header: {
            HStack {
                Text("Services")
                Spacer()
                if control.isLoadingState {
                    ProgressView().controlSize(.mini)
                } else if let updated = control.stateUpdated {
                    Text("Updated \(Fmt.clock(updated))").font(.caption).foregroundStyle(.secondary)
                }
                Button {
                    Task { await control.refreshState() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Refresh now")
            }
        } footer: {
            ErrorLine(text: control.stateError)
        }
    }

    private var colimaSection: some View {
        Section {
            Toggle("Start Colima at login", isOn: Binding(
                get: { services?.colima?.autostart ?? false },
                set: { control.start(.colimaAutostart($0)) }))
                .disabled(control.isRunning || services?.colima == nil || services?.colima?.state == "missing")
        } footer: {
            Text("Bacalhau and the scheduler start at login once set up; Colima's VM has to be running for jobs to run.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var logsSection: some View {
        Section {
            HStack {
                Button("Scheduler log") { logError = control.openLog(control.state?.paths?.controllerLog) }
                Button("Bacalhau log") { logError = control.openLog(control.state?.paths?.bacalhauLog) }
                Button("Logs folder") { logError = control.openLog(control.state?.paths?.logs) }
                Spacer()
            }
            .disabled(control.state?.paths == nil)
        } header: {
            Text("Logs")
        } footer: {
            ErrorLine(text: logError)
        }
    }

    private var colimaDetail: String? {
        guard let colima = services?.colima else { return nil }
        var parts: [String] = []
        if let cpus = colima.cpus { parts.append("\(cpus) CPUs") }
        if let memory = colima.memoryGiB { parts.append("\(memory.formatted(.number.precision(.fractionLength(0...1)))) GiB") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var bacalhauDetail: String? {
        guard let bacalhau = services?.bacalhau else { return nil }
        if let nodes = bacalhau.nodes { return nodes == 1 ? "1 node" : "\(nodes) nodes" }
        return bacalhau.loaded == false ? "Launch agent not loaded" : nil
    }

    private var controllerDetail: String? {
        guard let controller = services?.controller else { return nil }
        if controller.answering == true { return "Answering on its API" }
        if controller.loaded == true { return "Loaded, not answering yet" }
        return nil
    }
}

struct ServiceRow: View {
    let name: String
    let role: String
    let state: String?
    let detail: String?

    var body: some View {
        HStack(spacing: 10) {
            StateDot(color: ServiceStyle.color(state))
            VStack(alignment: .leading, spacing: 1) {
                Text(name).fontWeight(.medium)
                Text(role).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 1) {
                Text(ServiceStyle.label(state)).foregroundStyle(ServiceStyle.color(state))
                if let detail {
                    Text(detail).font(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }
}

struct SetupSection: View {
    @Environment(ControlStore.self) private var control
    let setup: SetupState.Setup
    let image: SetupState.Image?

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label("Not set up yet", systemImage: "wrench.and.screwdriver").font(.headline)
                Text("Set up installs Home Compute's Node packages, builds the worker image (several minutes), "
                     + "and writes the R2 settings (.env), the API token, this app's config and the launch agents. "
                     + "It starts nothing: use Start all afterwards.")
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                if !setup.missingTools.isEmpty {
                    Label("Missing tools: \(setup.missingTools.joined(separator: ", ")). Install them first "
                          + "(e.g. brew install colima docker node).", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 3) {
                    GridRow {
                        check("Tools installed", setup.missingTools.isEmpty)
                        check("Node packages", setup.homeComputeDeps)
                    }
                    GridRow {
                        check("Worker image", image?.present)
                        check(".env written", setup.envFile)
                    }
                    GridRow {
                        check("R2 configured", setup.r2Configured)
                        check("Launch agents", setup.agents)
                    }
                    GridRow {
                        check("Config current", setup.configCurrent)
                    }
                }
                .font(.caption)
                HStack {
                    Spacer()
                    Button("Set up…") { control.start(.setup) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(control.isRunning)
                }
            }
            .padding(.vertical, 4)
        }
    }

    private func check(_ label: String, _ ok: Bool?) -> some View {
        Label {
            Text(label)
        } icon: {
            Image(systemName: ok == true ? "checkmark.circle.fill" : ok == false ? "circle" : "questionmark.circle")
                .foregroundStyle(ok == true ? .green : .secondary)
        }
    }
}

// MARK: - Worker image

struct ImageTab: View {
    @Environment(ControlStore.self) private var control

    var body: some View {
        if control.script == nil {
            ScriptMissingView()
        } else {
            Form {
                if control.run != nil {
                    Section { RunBanner() }
                }
                Section("Worker image") {
                    if let image = control.state?.image {
                        details(image)
                    } else if control.isLoadingState {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("No image information yet.").foregroundStyle(.secondary)
                    }
                    ErrorLine(text: control.stateError)
                }
                Section {
                    HStack {
                        Text("Builds force5/Dockerfile in Colima's Docker; this takes several minutes. "
                             + "The next job submission uses the new image automatically; a job that is "
                             + "already running finishes on the old one.")
                            .font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button(control.state?.image?.present == true ? "Rebuild image" : "Build image") {
                            control.start(.image)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(control.isRunning)
                    }
                }
            }
            .formStyle(.grouped)
        }
    }

    @ViewBuilder private func details(_ image: SetupState.Image) -> some View {
        LabeledContent("Name") { Text(image.name ?? "-").textSelection(.enabled) }
        TimelineView(.periodic(from: .now, by: 30)) { context in
            LabeledContent("Built") {
                if let built = image.builtAt {
                    Text(Fmt.relative(built, now: context.date))
                        .help(built.formatted(date: .abbreviated, time: .standard))
                } else {
                    Text(image.present == true ? "Unknown" : "Not built").foregroundStyle(.secondary)
                }
            }
        }
        if let size = image.sizeBytes {
            LabeledContent("Size", value: Fmt.bytes(size))
        }
        LabeledContent("Status") {
            let (color, text) = freshness(image.freshness)
            HStack(spacing: 6) {
                StateDot(color: color)
                Text(text)
            }
        }
        if let source = image.sourceHash, let current = image.currentHash, source != current {
            LabeledContent("Code") {
                Text("built from \(source.prefix(10)), now \(current.prefix(10))")
                    .font(.caption.monospaced()).foregroundStyle(.secondary)
            }
        }
    }

    private func freshness(_ value: SetupState.Image.Freshness) -> (Color, String) {
        switch value {
        case .upToDate: (.green, "Up to date")
        case .stale: (.orange, "Code changed since it was built")
        case .untracked: (.orange, "Built before change tracking — rebuild to track")
        case .missing: (.red, "Not built yet")
        }
    }
}
