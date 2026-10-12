import ServiceManagement
import SwiftUI

/// The "Home Compute" settings window: a tab per area of control.
struct SettingsView: View {
    @Environment(ControlStore.self) private var control

    static let contentSize = CGSize(width: 660, height: 580)

    var body: some View {
        @Bindable var control = control
        TabView(selection: $control.selectedTab) {
            ServicesTab()
                .tabItem { Label("Services", systemImage: "server.rack") }
                .tag(ControlStore.Tab.services)
            StorageTab()
                .tabItem { Label("Storage", systemImage: "externaldrive.connected.to.line.below") }
                .tag(ControlStore.Tab.storage)
            ImageTab()
                .tabItem { Label("Worker image", systemImage: "shippingbox") }
                .tag(ControlStore.Tab.image)
            TimetableTab()
                .tabItem { Label("Timetable", systemImage: "calendar.badge.clock") }
                .tag(ControlStore.Tab.timetable)
            ConnectionTab()
                .tabItem { Label("Connection", systemImage: "network") }
                .tag(ControlStore.Tab.connection)
        }
        .frame(width: Self.contentSize.width, height: Self.contentSize.height)
        .sheet(isPresented: $control.showLog) {
            if let run = control.run {
                LogSheet(run: run)
            }
        }
        .onAppear {
            Log.info("settings window opened")
            control.watch()
            Task {
                await control.loadEnv()
                await control.loadTimetable()
            }
        }
        .onDisappear {
            Log.info("settings window closed")
            control.unwatch()
        }
    }
}

// MARK: - Connection

struct ConnectionTab: View {
    @Environment(Store.self) private var store
    @Environment(ControlStore.self) private var control
    @State private var draft = AppConfig()
    @State private var testResult: (ok: Bool, text: String)?
    @State private var saveError: String?
    @State private var scriptError: String?
    @State private var launchAtLogin = SMAppService.mainApp.status == .enabled
    @State private var loginMessage: String?

    private var isBundled: Bool { Bundle.main.bundleIdentifier != nil }

    var body: some View {
        Form {
            Section("Controller") {
                TextField("URL", text: $draft.url, prompt: Text(AppConfig.defaultURL))
                SecureField("API token", text: $draft.token)
                HStack {
                    Button("Test connection") { Task { await test() } }
                    if let testResult {
                        Image(systemName: testResult.ok ? "checkmark.circle.fill" : "xmark.octagon.fill")
                            .foregroundStyle(testResult.ok ? .green : .red)
                        Text(testResult.text).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
            }

            Section {
                LabeledContent("Script") {
                    if store.config.setupScript.isEmpty {
                        Text("Not chosen").foregroundStyle(.secondary)
                    } else {
                        Text(store.config.setupScript)
                            .font(.caption)
                            .textSelection(.enabled)
                            .lineLimit(2)
                            .truncationMode(.middle)
                    }
                }
                HStack {
                    Button("Choose…") { chooseScript() }
                    if !store.config.setupScript.isEmpty {
                        Button("Clear") { setScript("") }
                    }
                    Spacer()
                    if let script = control.script, !script.exists {
                        Label("File not found", systemImage: "exclamationmark.triangle.fill")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
                if let scriptError {
                    Text(scriptError).font(.caption).foregroundStyle(.red)
                }
            } header: {
                Text("Setup script")
            } footer: {
                Text("deploy/home-compute/macmini.sh in the wingfoil checkout. The Services, Storage, "
                     + "Worker image and Timetable tabs run it to set up and control this Mac.")
                    .font(.caption).foregroundStyle(.secondary)
            }

            Section("Notifications") {
                Text("Failed jobs always post a notification.").font(.caption).foregroundStyle(.secondary)
                Toggle("Also notify when a new forecast is published", isOn: $draft.notifyOnPublished)
                if !isBundled {
                    Text("Notifications need the .app bundle (build-app.sh); they are skipped for the bare binary.")
                        .font(.caption).foregroundStyle(.orange)
                }
            }

            Section("General") {
                Toggle("Launch at login", isOn: Binding(get: { launchAtLogin }, set: { setLaunchAtLogin($0) }))
                    .disabled(!isBundled)
                if let loginMessage {
                    Text(loginMessage).font(.caption).foregroundStyle(.orange)
                }
                LabeledContent("Config file") {
                    Text(ConfigFile.url.path).font(.caption).textSelection(.enabled)
                }
            }

            HStack {
                if let saveError {
                    Text(saveError).font(.caption).foregroundStyle(.red)
                }
                Spacer()
                Button("Revert") { load() }
                Button("Save") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(draft.normalized == store.config)
            }
        }
        .formStyle(.grouped)
        .onAppear(perform: load)
        .onChange(of: store.config) { old, new in
            // Another writer (token rotation, setup) changed the file: follow it unless edited.
            if draft.normalized == old { draft = new }
            draft.setupScript = new.setupScript
        }
    }

    private func load() {
        draft = ConfigFile.load()
        saveError = nil
        testResult = nil
        refreshLoginState()
    }

    private func save() {
        do {
            try store.updateConfig(draft)
            draft = store.config
            saveError = nil
        } catch {
            saveError = "Could not save: \(error.localizedDescription)"
        }
    }

    private func chooseScript() {
        scriptError = control.chooseScript()
    }

    private func setScript(_ path: String) {
        do {
            try control.setScriptPath(path)
            scriptError = nil
        } catch {
            scriptError = "Could not save: \(error.localizedDescription)"
        }
    }

    private func test() async {
        testResult = nil
        let client = APIClient(baseURL: draft.url, token: draft.token)
        do {
            try await client.health()
            let snapshot = try await client.snapshot(live: false)
            testResult = (true, "OK - \(snapshot.jobs.count) jobs")
        } catch {
            testResult = (false, error.localizedDescription)
        }
    }

    private func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
            loginMessage = nil
        } catch {
            loginMessage = "Launch at login failed: \(error.localizedDescription)"
        }
        refreshLoginState()
    }

    private func refreshLoginState() {
        let status = SMAppService.mainApp.status
        launchAtLogin = status == .enabled
        if !isBundled {
            loginMessage = "Launch at login is only available when running the .app bundle."
        } else if status == .requiresApproval {
            loginMessage = "Approve Home Compute Bar in System Settings › General › Login Items."
        }
    }
}
