import Foundation
import Testing
@testable import HomeComputeBar

/// Decodes the real setup script's read-only commands through the app's runner. Opt-in, and it
/// never runs a mutating command:
///
///     HCB_REAL_SCRIPT=/path/to/wingfoil/deploy/home-compute/macmini.sh swift test --filter RealScriptTests
@Suite(.enabled(if: ProcessInfo.processInfo.environment["HCB_REAL_SCRIPT"] != nil))
struct RealScriptTests {
    let script = SetupScript(configured: ProcessInfo.processInfo.environment["HCB_REAL_SCRIPT"] ?? "")

    @Test func state() async throws {
        let state = try await #require(script).json(SetupState.self, ["state", "--json"])
        print("state: setup=\(String(describing: state.setup?.complete)) missing=\(state.setup?.missingTools ?? [])",
              "colima=\(state.services?.colima?.state ?? "-") bacalhau=\(state.services?.bacalhau?.state ?? "-")",
              "controller=\(state.services?.controller?.state ?? "-") image=\(state.image?.freshness.description ?? "-")",
              "paths=\(state.paths != nil)")
        #expect(state.setup != nil)
        #expect(state.services != nil)
        #expect(state.paths != nil)
        #expect(state.image != nil)
    }

    @Test func env() async throws {
        let env = try await #require(script).json(EnvInfo.self, ["env", "--json"])
        print("env: exists=\(env.exists) values=\(env.values.keys.sorted()) secrets=\(env.secrets.mapValues(\.set))")
        for name in EnvInfo.editableSecrets + ["HOME_COMPUTE_API_TOKEN"] {
            #expect(env.values[name] == nil, "secret \(name) must not be in values")
        }
    }

    @Test func jobs() async throws {
        let timetable = try await #require(script).json(Timetable.self, ["jobs", "--json"])
        for job in timetable.jobs {
            print("job \(job.id): enabled=\(job.enabled) \(Fmt.times(hours: job.hours, minutes: job.minutes))",
                  "memory=\(job.memory ?? "-") editable=\(job.scheduleEditable)")
        }
        #expect(!timetable.jobs.isEmpty)
        #expect(!timetable.memoryChoices.isEmpty)
    }
}
