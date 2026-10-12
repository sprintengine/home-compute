import Foundation
import Testing
@testable import HomeComputeBar

/// Decoding of the setup script's JSON contract, line splitting, schedule drafts and formatting.
/// None of these run a process or touch the environment.
struct ControlModelTests {
    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    @Test func decodesState() throws {
        let state = try decode(SetupState.self, """
        {"paths": {"wingfoil": "/w", "homeCompute": "/h", "envFile": "/w/.env", "jobsFile": "/w/deploy/local/jobs.toml",
                   "logs": "~/Library/Logs/home-compute", "controllerLog": "/l/controller.log", "bacalhauLog": "/l/bacalhau.log"},
         "setup": {"complete": false, "envFile": true, "r2Configured": true, "agents": false, "homeComputeDeps": true, "configCurrent": true,
                   "tools": {"colima": true, "docker": true, "node": false, "bacalhau": false}},
         "services": {"colima": {"state": "running", "cpus": 4, "memoryGiB": 6, "autostart": false},
                      "bacalhau": {"state": "stopped", "loaded": false, "nodes": 0},
                      "controller": {"state": "starting", "loaded": true, "answering": false}},
         "image": {"name": "wingfoil-forecast:local", "present": true, "builtAt": "2026-10-08T21:05:00Z",
                   "sourceHash": "abc", "currentHash": "abc", "stale": false, "sizeBytes": 531000000}}
        """)
        #expect(state.paths?.jobsFile == "/w/deploy/local/jobs.toml")
        #expect(state.setup?.complete == false)
        #expect(state.isSetUp == false)
        #expect(state.setup?.missingTools == ["bacalhau", "node"])
        #expect(state.services?.colima?.cpus == 4)
        #expect(state.services?.colima?.memoryGiB == 6)
        #expect(state.services?.bacalhau?.nodes == 0)
        #expect(state.services?.controller?.answering == false)
        #expect(state.isStopped)
        #expect(state.isStarting)
        #expect(state.image?.builtAt == ISODate.parse("2026-10-08T21:05:00Z"))
        #expect(state.image?.sizeBytes == 531_000_000)
        #expect(state.image?.freshness == .upToDate)
    }

    @Test func imageFreshness() throws {
        func freshness(_ fields: String) throws -> SetupState.Image.Freshness {
            try decode(SetupState.self, #"{"image": {"present": true, \#(fields)}}"#).image!.freshness
        }
        #expect(try freshness(#""sourceHash": null, "currentHash": "abc", "stale": null"#) == .untracked)
        #expect(try freshness(#""sourceHash": "abc", "currentHash": "def", "stale": true"#) == .stale)
        #expect(try freshness(#""sourceHash": "abc", "currentHash": "def""#) == .stale)
        #expect(try freshness(#""sourceHash": "abc", "currentHash": "abc""#) == .upToDate)
        let missing = try decode(SetupState.self, #"{"image": {"present": false}}"#)
        #expect(missing.image?.freshness == .missing)
    }

    @Test func stateIsLenient() throws {
        // Odd types and missing sections never fail the whole state.
        let state = try decode(SetupState.self, """
        {"setup": {"complete": "true", "tools": "oops"},
         "services": {"colima": {"state": "running", "cpus": "4", "memoryGiB": 5.5, "autostart": 1},
                      "bacalhau": "garbage"},
         "image": {"present": true, "sizeBytes": 1.5e9}}
        """)
        #expect(state.setup?.complete == true)
        #expect(state.setup?.tools == [:])
        #expect(state.services?.colima?.cpus == 4)
        #expect(state.services?.colima?.memoryGiB == 5.5)
        #expect(state.services?.colima?.autostart == true)
        #expect(state.services?.bacalhau == nil)
        #expect(state.services?.controller == nil)
        #expect(state.image?.sizeBytes == 1_500_000_000)
        #expect(state.paths == nil)
        #expect(try decode(SetupState.self, "{}").isSetUp)
    }

    @Test func decodesEnv() throws {
        let env = try decode(EnvInfo.self, """
        {"exists": true,
         "values": {"S3_BUCKET": "force5-forecast", "S3_ENDPOINT_URL": "https://x.r2.cloudflarestorage.com", "S3_PREFIX": "",
                    "AWS_REGION": "auto", "ECMWF_SOURCE": "ecmwf", "WINGFOIL_IMAGE": "wingfoil-forecast:local", "FORCE5_SIDECARS": "0"},
         "secrets": {"AWS_ACCESS_KEY_ID": {"set": true, "hint": "…ab12"}, "AWS_SECRET_ACCESS_KEY": {"set": true, "hint": null},
                     "HOME_COMPUTE_API_TOKEN": {"set": false, "hint": null}}}
        """)
        #expect(env.exists)
        #expect(env.values["S3_BUCKET"] == "force5-forecast")
        #expect(env.values["S3_PREFIX"] == "")
        #expect(env.secrets["AWS_ACCESS_KEY_ID"] == EnvInfo.Secret(set: true, hint: "…ab12"))
        #expect(env.secrets["AWS_SECRET_ACCESS_KEY"] == EnvInfo.Secret(set: true, hint: nil))
        #expect(env.secrets["HOME_COMPUTE_API_TOKEN"]?.set == false)

        let nulls = try decode(EnvInfo.self, #"{"exists": false, "values": {"S3_PREFIX": null, "S3_BUCKET": "b"}}"#)
        #expect(nulls.values == ["S3_PREFIX": "", "S3_BUCKET": "b"])
        #expect(nulls.secrets.isEmpty)
    }

    @Test func decodesR2Test() throws {
        let result = try decode(R2TestResult.self, """
        {"ok": true, "bucket": "force5-forecast", "endpoint": "https://e", "objectsSeen": 1,
         "manifests": [{"model": "harmonie", "key": "weather/harmonie.json", "run": "2026100818", "lastModified": "2026-10-08T19:02:00Z", "missing": false},
                       {"model": "gfs", "key": "weather/gfs.json", "run": null, "lastModified": null, "missing": true}],
         "error": null}
        """)
        #expect(result.ok)
        #expect(result.objectsSeen == 1)
        #expect(result.manifests.map(\.model) == ["harmonie", "gfs"])
        #expect(result.manifests[0].lastModified == ISODate.parse("2026-10-08T19:02:00Z"))
        #expect(!result.manifests[0].missing)
        #expect(result.manifests[1].missing)

        let failed = try decode(R2TestResult.self, #"{"ok": false, "error": "AccessDenied", "manifests": []}"#)
        #expect(!failed.ok)
        #expect(failed.error == "AccessDenied")
    }

    @Test func decodesTimetable() throws {
        let timetable = try decode(Timetable.self, """
        {"cronStepMinutes": 5, "memoryChoices": ["512Mb", "1Gb", "2Gb", "3Gb", "4Gb", "5Gb"],
         "jobs": [{"id": "harmonie", "description": "HARMONIE-AROME (Met Éireann), hourly DINI cycle", "models": ["harmonie"], "command": "worker",
                   "enabled": true, "hours": null, "minutes": [45], "memory": "4Gb", "defaultMemory": "4Gb", "timeoutSeconds": 3300, "scheduleEditable": true},
                  {"id": "gfs", "models": ["gfs", "gfswave"], "enabled": false, "hours": [21, 3, 15, 9], "minutes": [30, 0]},
                  {"id": "prune", "command": "prune", "hours": [4], "minutes": [10], "scheduleEditable": false},
                  {"description": "no id, dropped"}]}
        """)
        #expect(timetable.minuteChoices == Array(stride(from: 0, through: 55, by: 5)))
        #expect(timetable.memoryChoices.count == 6)
        #expect(timetable.jobs.map(\.id) == ["harmonie", "gfs", "prune"])
        let harmonie = timetable.jobs[0]
        #expect(harmonie.hours == nil)
        #expect(harmonie.minutes == [45])
        #expect(harmonie.timeoutSeconds == 3300)
        let gfs = timetable.jobs[1]
        #expect(!gfs.enabled)
        #expect(gfs.hours == [3, 9, 15, 21])
        #expect(gfs.minutes == [0, 30])
        #expect(gfs.scheduleEditable)
        #expect(!timetable.jobs[2].scheduleEditable)
    }

    @Test func decodesReplies() throws {
        let ok = try decode(ScriptReply.self, #"{"ok": true, "restartRequired": true}"#)
        #expect(ok.ok == true && ok.restartRequired == true && ok.error == nil)
        let bad = try decode(ScriptReply.self, #"{"ok": false, "error": "minutes must be multiples of 5"}"#)
        #expect(bad.ok == false && bad.error == "minutes must be multiples of 5")
    }

    // MARK: Output

    @Test func splitsLinesAcrossChunks() {
        var splitter = LineSplitter()
        #expect(splitter.feed(Data("one\ntw".utf8)) == ["one"])
        #expect(splitter.feed(Data("o\n\nthree".utf8)) == ["two", ""])
        #expect(splitter.flush() == ["three"])
        #expect(splitter.flush() == [])

        // A multi-byte character split between chunks.
        let bytes = Array("Éireann\n".utf8)
        #expect(splitter.feed(Data(bytes[0..<1])) == [])
        #expect(splitter.feed(Data(bytes[1...])) == ["Éireann"])
    }

    @Test func stripsEscapesAndCarriageReturns() {
        #expect(LineSplitter.clean("\u{1B}[1mStarting Colima\u{1B}[0m") == "Starting Colima")
        #expect(LineSplitter.clean("\u{1B}[32mINFO\u{1B}[0m[0001] starting") == "INFO[0001] starting")
        #expect(LineSplitter.clean("\u{1B}[2K\u{1B}[1Gdone") == "done")
        #expect(LineSplitter.clean("\u{1B}]0;title\u{07}text") == "text")
        #expect(LineSplitter.clean("progress 10%\rprogress 60%\rprogress 100%") == "progress 100%")
        #expect(LineSplitter.clean("windows line\r") == "windows line")
        #expect(LineSplitter.clean("tab\tkept\u{08}") == "tab\tkept")
        #expect(LineSplitter.clean("plain") == "plain")
    }

    @Test func findsJSONBody() {
        let body = SetupScript.jsonBody(Data("warning: something\n{\"ok\": true}\n".utf8))
        #expect(String(decoding: body, as: UTF8.self) == "{\"ok\": true}")
    }

    // MARK: Timetable drafts

    private func job(_ json: String) throws -> TimetableJob { try decode(TimetableJob.self, json) }

    @Test func draftSendsOnlyChanges() throws {
        let harmonie = try job(#"{"id": "harmonie", "enabled": true, "hours": null, "minutes": [45], "memory": "4Gb", "defaultMemory": "4Gb"}"#)
        var draft = JobDraft(harmonie)
        #expect(draft.arguments(from: harmonie).isEmpty)
        #expect(draft.summary == "Hourly at :45 UTC")

        draft.everyHour = false
        draft.hours = [21, 3, 9, 15]
        draft.minutes = [30]
        #expect(draft.arguments(from: harmonie) == ["--hours", "3,9,15,21", "--minutes", "30"])
        #expect(draft.summary == "03:30, 09:30, 15:30, 21:30 UTC")

        draft = JobDraft(harmonie)
        draft.enabled = false
        draft.memory = "2Gb"
        #expect(draft.arguments(from: harmonie) == ["--enabled", "false", "--memory", "2Gb"])

        let gfs = try job(#"{"id": "gfs", "hours": [3, 9], "minutes": [0, 30], "memory": "3Gb"}"#)
        draft = JobDraft(gfs)
        draft.everyHour = true
        #expect(draft.arguments(from: gfs) == ["--hours", "every"])
    }

    @Test func draftValidation() throws {
        let gfs = try job(#"{"id": "gfs", "hours": [3], "minutes": [30]}"#)
        var draft = JobDraft(gfs)
        draft.minutes = []
        #expect(draft.validationError(for: gfs) != nil)
        draft.minutes = [0]
        draft.hours = []
        #expect(draft.validationError(for: gfs) != nil)
        draft.everyHour = true
        #expect(draft.validationError(for: gfs) == nil)
    }

    @Test func fixedScheduleSendsNoSchedule() throws {
        let prune = try job(#"{"id": "prune", "hours": [4], "minutes": [10], "memory": "512Mb", "scheduleEditable": false}"#)
        var draft = JobDraft(prune)
        draft.hours = [5]
        draft.minutes = []
        draft.enabled = false
        #expect(draft.validationError(for: prune) == nil)
        #expect(draft.arguments(from: prune) == ["--enabled", "false"])
    }

    @Test func formatsTimes() {
        #expect(Fmt.times(hours: nil, minutes: [0, 30]) == "Hourly at :00, :30 UTC")
        #expect(Fmt.times(hours: Array(0..<24), minutes: [15]) == "Hourly at :15 UTC")
        #expect(Fmt.times(hours: [9, 3], minutes: []) == "03:00, 09:00 UTC")
        #expect(Fmt.times(hours: Array(stride(from: 0, to: 24, by: 2)), minutes: [15])
                == "At :15 past 00, 02, 04, 06, 08, 10, 12, 14, 16, 18, 20, 22 h UTC")
        #expect(Fmt.minutes(3300) == "55 min")
        #expect(Fmt.minutes(5400) == "1 h 30 min")
    }

    @Test func schedulerBannerSaysStoppedOnlyWhenLaunchdSaysSo() throws {
        func state(_ controller: String, _ bacalhau: String, _ colima: String = "running") throws -> SetupState {
            try decode(SetupState.self, #"{"services": {"controller": {"state": "\#(controller)"}, "bacalhau": {"state": "\#(bacalhau)"}, "colima": {"state": "\#(colima)"}}}"#)
        }
        // A busy Mac: the app cannot reach the controller, and the state script's checks timed out.
        if case .notAnswering = SchedulerBanner.decide(state: try state("unknown", "unknown", "unknown"), unreachable: true) {} else {
            Issue.record("unknown services must not read as stopped")
        }
        if case .notAnswering = SchedulerBanner.decide(state: nil, unreachable: true) {} else {
            Issue.record("no state yet must not read as stopped")
        }
        if case .notAnswering = SchedulerBanner.decide(state: try state("running", "running"), unreachable: true) {} else {
            Issue.record("running but unreachable from the app is not answering")
        }
        #expect(SchedulerBanner.decide(state: try state("stopped", "running"), unreachable: true) == .stopped("Not running: scheduler"))
        #expect(SchedulerBanner.decide(state: try state("running", "missing"), unreachable: false) == .stopped("Not running: Bacalhau"))
        #expect(SchedulerBanner.decide(state: try state("running", "running"), unreachable: false) == nil)
        #expect(SchedulerBanner.decide(state: nil, unreachable: false) == nil)
    }
}
