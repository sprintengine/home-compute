import SwiftUI

/// R2 bucket settings in deploy/home-compute/.env, the connection test and the API token.
struct StorageTab: View {
    @Environment(ControlStore.self) private var control
    @State private var values: [String: String] = [:]
    @State private var secrets: [String: String] = [:]
    @State private var saving = false
    @State private var saveError: String?
    @State private var saved = false
    @State private var confirmRotate = false
    @State private var rotating = false
    @State private var tokenMessage: (ok: Bool, text: String)?

    private static let fields: [(name: String, label: String, prompt: String)] = [
        ("S3_BUCKET", "Bucket", "force5-forecast"),
        ("S3_ENDPOINT_URL", "Endpoint", "https://<account>.r2.cloudflarestorage.com"),
        ("S3_PREFIX", "Prefix", "none"),
        ("AWS_REGION", "Region", "auto"),
    ]

    var body: some View {
        if control.script == nil {
            ScriptMissingView()
        } else {
            Form {
                if control.restartPending {
                    Section { RestartBanner() }
                }
                bucketSection
                credentialsSection
                saveSection
                testSection
                tokenSection
            }
            .formStyle(.grouped)
            .onAppear(perform: reset)
            .onChange(of: control.env) { old, new in
                // Follow the stored values for fields the user hasn't edited.
                for name in EnvInfo.editableValues where (values[name] ?? "") == (old?.values[name] ?? "") {
                    values[name] = new?.values[name] ?? ""
                }
            }
            .confirmationDialog("Rotate the API token?", isPresented: $confirmRotate) {
                Button("Rotate token", role: .destructive) { Task { await rotate() } }
            } message: {
                Text("A new HOME_COMPUTE_API_TOKEN is written to .env and to this app's config. "
                     + "Other clients using the old token stop working, and the scheduler needs a restart to use it.")
            }
        }
    }

    // MARK: Sections

    private var bucketSection: some View {
        Section {
            ForEach(Self.fields, id: \.name) { field in
                TextField(field.label, text: binding(field.name), prompt: Text(field.prompt))
                    .disableAutocorrection(true)
            }
            TextField("ECMWF source", text: binding("ECMWF_SOURCE"), prompt: Text("ecmwf"))
                .disableAutocorrection(true)
        } header: {
            Text("R2 bucket")
        } footer: {
            VStack(alignment: .leading, spacing: 2) {
                if let path = control.state?.paths?.envFile {
                    Text("Saved in \(path)").font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if control.env?.exists == false {
                    Text("There is no .env yet; Set up writes one, or saving here creates it.")
                        .font(.caption).foregroundStyle(.orange)
                }
                ErrorLine(text: control.envError)
            }
        }
    }

    private var credentialsSection: some View {
        Section {
            secretField("AWS_ACCESS_KEY_ID", label: "Access key ID")
            secretField("AWS_SECRET_ACCESS_KEY", label: "Secret access key")
        } header: {
            Text("Credentials")
        } footer: {
            Text("Stored keys are never shown. Leave a field empty to keep the stored key; type a new one to replace it.")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private var saveSection: some View {
        HStack {
            if saving {
                ProgressView().controlSize(.small)
            } else if let saveError {
                ErrorLine(text: saveError)
            } else if saved {
                Label("Saved", systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
            }
            Spacer()
            Button("Revert") { reset() }
                .disabled(changes.isEmpty || saving)
            Button("Save") { Task { await save() } }
                .keyboardShortcut(.defaultAction)
                .disabled(changes.isEmpty || saving || control.env == nil)
        }
    }

    private var testSection: some View {
        Section {
            HStack {
                Button("Test connection") { Task { await control.testR2() } }
                    .disabled(control.isTestingR2 || !changes.isEmpty)
                if control.isTestingR2 { ProgressView().controlSize(.small) }
                if !changes.isEmpty {
                    Text("Save first; the test uses the saved settings.").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
            }
            ErrorLine(text: control.r2Error)
            if let result = control.r2Result {
                R2ResultView(result: result)
            }
        } header: {
            Text("Connection test")
        }
    }

    private var tokenSection: some View {
        Section {
            HStack {
                Text(tokenStatus).font(.callout)
                Spacer()
                if rotating { ProgressView().controlSize(.small) }
                Button("Rotate API token…") { confirmRotate = true }
                    .disabled(rotating || control.env == nil)
            }
            if let tokenMessage {
                if tokenMessage.ok {
                    Label(tokenMessage.text, systemImage: "checkmark.circle.fill").font(.caption).foregroundStyle(.green)
                } else {
                    ErrorLine(text: tokenMessage.text)
                }
            }
        } header: {
            Text("API token")
        } footer: {
            Text("The scheduler and this app share HOME_COMPUTE_API_TOKEN.").font(.caption).foregroundStyle(.secondary)
        }
    }

    private var tokenStatus: String {
        guard let secret = control.env?.secrets["HOME_COMPUTE_API_TOKEN"] else { return "Unknown" }
        guard secret.set else { return "Not set" }
        return secret.hint.map { "Set (\($0))" } ?? "Set"
    }

    private func secretField(_ name: String, label: String) -> some View {
        let secret = control.env?.secrets[name]
        let prompt = secret?.set == true ? "Set" + (secret?.hint.map { " (\($0))" } ?? "") + " — unchanged" : "Not set"
        return LabeledContent {
            HStack {
                SecureField(label, text: secretBinding(name), prompt: Text(prompt))
                    .labelsHidden()
                Image(systemName: secret?.set == true ? "key.fill" : "key")
                    .foregroundStyle(secret?.set == true ? .green : .secondary)
                    .help(secret?.set == true ? "A key is stored" : "No key stored")
            }
        } label: {
            Text(label)
        }
    }

    // MARK: Drafts

    private func binding(_ name: String) -> Binding<String> {
        Binding(get: { values[name] ?? "" }, set: { values[name] = $0; saved = false })
    }

    private func secretBinding(_ name: String) -> Binding<String> {
        Binding(get: { secrets[name] ?? "" }, set: { secrets[name] = $0; saved = false })
    }

    /// Changed values (trimmed), then new secrets; empty secret fields mean "keep".
    private var changes: [(name: String, value: String)] {
        let stored = control.env?.values ?? [:]
        var result: [(name: String, value: String)] = []
        for name in EnvInfo.editableValues {
            let value = (values[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if value != (stored[name] ?? "") { result.append((name, value)) }
        }
        for name in EnvInfo.editableSecrets {
            let value = (secrets[name] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if !value.isEmpty { result.append((name, value)) }
        }
        return result
    }

    private func reset() {
        values = control.env?.values ?? [:]
        secrets = [:]
        saveError = nil
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let result = await control.saveEnv(changes)
        for name in result.saved { secrets[name] = nil }
        saveError = result.error
        saved = result.error == nil
    }

    private func rotate() async {
        rotating = true
        defer { rotating = false }
        if let error = await control.rotateToken() {
            tokenMessage = (false, error)
        } else {
            tokenMessage = (true, "New token saved to .env and this app's config")
            await control.loadEnv()
        }
    }
}

struct R2ResultView: View {
    let result: R2TestResult

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if result.ok {
                Label("Reached \(result.bucket ?? "the bucket")" + (result.objectsSeen.map { " · \($0) objects seen" } ?? ""),
                      systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Label(result.error ?? "Could not reach the bucket", systemImage: "xmark.octagon.fill")
                    .foregroundStyle(.red)
                    .textSelection(.enabled)
            }
            if let endpoint = result.endpoint {
                Text(endpoint).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            if !result.manifests.isEmpty {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    Grid(alignment: .leading, horizontalSpacing: 14, verticalSpacing: 4) {
                        GridRow {
                            Text("Model")
                            Text("Run published")
                            Text("Updated")
                            Text("Manifest")
                        }
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        Divider()
                        ForEach(result.manifests) { manifest in
                            GridRow {
                                Text(Fmt.modelName(manifest.model)).fontWeight(.medium)
                                if manifest.missing {
                                    Text("Missing").foregroundStyle(.red)
                                    Text("-").foregroundStyle(.secondary)
                                } else {
                                    Text(Fmt.modelRun(manifest.run)).monospacedDigit()
                                    Text(Fmt.relative(manifest.lastModified, now: context.date))
                                        .help(manifest.lastModified?.formatted(date: .abbreviated, time: .standard) ?? "")
                                }
                                Text(manifest.key ?? "").font(.caption.monospaced()).foregroundStyle(.secondary)
                            }
                            .font(.callout)
                        }
                    }
                }
            }
        }
    }
}
