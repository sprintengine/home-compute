import SwiftUI

/// Editable copy of one job in deploy/local/jobs.toml, and the `jobs set` arguments for its changes.
struct JobDraft: Equatable {
    var enabled: Bool
    var everyHour: Bool
    var hours: Set<Int>
    var minutes: Set<Int>
    var memory: String

    init(_ job: TimetableJob) {
        enabled = job.enabled
        everyHour = job.hours == nil
        hours = Set(job.hours ?? [])
        minutes = Set(job.minutes)
        memory = job.memory ?? job.defaultMemory ?? ""
    }

    /// A problem that would make `jobs set` fail, caught before running it.
    func validationError(for job: TimetableJob) -> String? {
        guard job.scheduleEditable else { return nil }
        if minutes.isEmpty { return "Choose at least one minute past the hour." }
        if !everyHour && hours.isEmpty { return "Choose at least one hour, or run it every hour." }
        return nil
    }

    /// Arguments for `macmini.sh jobs set ID …`, only for what changed.
    func arguments(from job: TimetableJob) -> [String] {
        let original = JobDraft(job)
        var args: [String] = []
        if enabled != original.enabled {
            args += ["--enabled", enabled ? "true" : "false"]
        }
        if job.scheduleEditable {
            if everyHour != original.everyHour || (!everyHour && hours != original.hours) {
                args += ["--hours", everyHour ? "every" : Self.list(hours)]
            }
            if minutes != original.minutes {
                args += ["--minutes", Self.list(minutes)]
            }
        }
        if !memory.isEmpty, memory != original.memory {
            args += ["--memory", memory]
        }
        return args
    }

    var summary: String {
        Fmt.times(hours: everyHour ? nil : hours.sorted(), minutes: minutes.sorted())
    }

    private static func list(_ values: Set<Int>) -> String {
        values.sorted().map(String.init).joined(separator: ",")
    }
}

struct TimetableTab: View {
    @Environment(ControlStore.self) private var control

    var body: some View {
        if control.script == nil {
            ScriptMissingView()
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    RestartBanner()
                    header
                    if let timetable = control.timetable {
                        ForEach(timetable.jobs) { job in
                            JobEditor(job: job, timetable: timetable)
                        }
                        if timetable.jobs.isEmpty {
                            Text("No jobs in the timetable.").foregroundStyle(.secondary)
                        }
                    } else if control.timetableError == nil {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                .padding(20)
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("When each forecast job runs. Times are \(control.timetable.map { Fmt.timezoneLabel($0.timezone) } ?? "UTC").")
                    .font(.callout)
                Spacer()
                Button {
                    Task { await control.loadTimetable() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help("Reload the timetable")
            }
            if let file = control.state?.paths?.jobsFile {
                Text("Saved in \(file)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ErrorLine(text: control.timetableError)
        }
    }
}

struct JobEditor: View {
    @Environment(ControlStore.self) private var control
    let job: TimetableJob
    let timetable: Timetable
    @State private var draft: JobDraft
    @State private var saving = false
    @State private var error: String?
    @State private var saved = false

    init(job: TimetableJob, timetable: Timetable) {
        self.job = job
        self.timetable = timetable
        _draft = State(initialValue: JobDraft(job))
    }

    private var changed: Bool { !draft.arguments(from: job).isEmpty }

    var body: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                header
                if let description = job.description {
                    Text(description).font(.caption).foregroundStyle(.secondary)
                }
                schedule
                    .disabled(!job.scheduleEditable)
                    .opacity(draft.enabled ? 1 : 0.6)
                if !job.scheduleEditable {
                    Text("This job's schedule is fixed; only whether it runs and its memory can change.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                memory
                footer
            }
            .padding(6)
        }
        .onChange(of: job) { _, new in
            draft = JobDraft(new)
        }
        .onChange(of: draft) {
            error = nil
            saved = false
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text(job.id).font(.headline)
            ForEach(job.models, id: \.self) { Tag(text: Fmt.modelName($0), color: .secondary) }
            if let command = job.command, command != "worker" {
                Tag(text: command, color: .blue)
            }
            Spacer()
            Toggle("Enabled", isOn: $draft.enabled)
                .toggleStyle(.switch)
                .controlSize(.small)
        }
    }

    private var schedule: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Hours").font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 56, alignment: .leading)
                Toggle("Every hour", isOn: $draft.everyHour)
                    .toggleStyle(.checkbox)
            }
            if !draft.everyHour {
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(38), spacing: 4), count: 12), alignment: .leading, spacing: 4) {
                    ForEach(0..<24, id: \.self) { hour in
                        Chip(text: String(format: "%02d", hour), selected: draft.hours.contains(hour)) {
                            toggle(hour, in: \.hours)
                        }
                    }
                }
                .padding(.leading, 64)
            }
            HStack(alignment: .top) {
                Text("Minutes").font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 56, alignment: .leading)
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(38), spacing: 4), count: 12), alignment: .leading, spacing: 4) {
                    ForEach(minuteChoices, id: \.self) { minute in
                        Chip(text: String(format: ":%02d", minute), selected: draft.minutes.contains(minute)) {
                            toggle(minute, in: \.minutes)
                        }
                    }
                }
            }
            Label(draft.enabled ? draft.summary : "Off · " + draft.summary, systemImage: "clock")
                .font(.callout)
                .foregroundStyle(draft.enabled ? .primary : .secondary)
        }
    }

    /// The step's multiples, plus any minute already set that isn't one (so it can be cleared).
    private var minuteChoices: [Int] {
        Array(Set(timetable.minuteChoices).union(draft.minutes).union(job.minutes)).sorted()
    }

    private var memory: some View {
        HStack {
            Text("Memory").font(.caption.weight(.semibold)).foregroundStyle(.secondary).frame(width: 56, alignment: .leading)
            Picker("Memory", selection: $draft.memory) {
                ForEach(memoryChoices, id: \.self) { choice in
                    Text(choice == job.defaultMemory ? "\(choice) (default)" : choice).tag(choice)
                }
            }
            .labelsHidden()
            .fixedSize()
            if let timeout = job.timeoutSeconds {
                Text("Times out after \(Fmt.minutes(timeout))").font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    private var memoryChoices: [String] {
        var choices = timetable.memoryChoices
        for value in [job.memory, job.defaultMemory, draft.memory].compactMap({ $0 }) where !value.isEmpty && !choices.contains(value) {
            choices.append(value)
        }
        return choices
    }

    private var footer: some View {
        HStack {
            if saving {
                ProgressView().controlSize(.small)
            } else if let message = error ?? (changed ? draft.validationError(for: job) : nil) {
                ErrorLine(text: message)
            } else if saved {
                Label("Saved", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
            }
            Spacer()
            Button("Revert") { draft = JobDraft(job) }
            .disabled(!changed || saving)
            Button("Save") { Task { await save() } }
                .disabled(!changed || saving || draft.validationError(for: job) != nil)
        }
    }

    private func toggle(_ value: Int, in keyPath: WritableKeyPath<JobDraft, Set<Int>>) {
        if draft[keyPath: keyPath].contains(value) {
            draft[keyPath: keyPath].remove(value)
        } else {
            draft[keyPath: keyPath].insert(value)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        error = await control.saveJob(job.id, arguments: draft.arguments(from: job))
        saved = error == nil
    }
}

struct Chip: View {
    let text: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(text)
                .font(.caption.monospacedDigit())
                .frame(width: 38, height: 20)
                .foregroundStyle(selected ? Color.white : Color.primary)
                .background(selected ? Color.accentColor : Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
