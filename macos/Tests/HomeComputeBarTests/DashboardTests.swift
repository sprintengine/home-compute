import Foundation
import Testing
@testable import HomeComputeBar

/// Run history in the snapshot, the dashboard's addresses and the reload answer.
struct DashboardTests {
    private func snapshot(_ json: String) throws -> Snapshot {
        try JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))
    }

    @Test func decodesRecentRunsAndMergesThemNewestFirst() throws {
        let snapshot = try snapshot("""
        {"controller": {"status": "online", "features": ["history", "logs", "reload"]},
         "jobs": [
           {"id": "gfs", "recentRuns": [
             {"id": "j-3", "job": "gfs", "state": "Running", "submittedAt": "2026-10-11T16:00:00Z"},
             {"id": "j-2", "job": "gfs", "state": "Failed", "outcome": "failed", "exitCode": 1, "error": "HTTP 503",
              "finishedAt": "2026-10-11T15:00:00.5Z", "durationSeconds": 64, "metrics": {"peakMemoryMb": 912, "cpuSeconds": 48}}]},
           {"id": "icon-eu", "recentRuns": [
             {"id": "j-1", "state": "Completed", "outcome": "published", "finishedAt": "2026-10-11T15:30:00Z", "durationSeconds": "197"},
             {"id": "", "outcome": "published"},
             {"id": "j-0", "outcome": "unchanged", "finishedAt": "2026-10-10T15:30:00Z"}]},
           {"id": "old-controller"}]}
        """)
        #expect(snapshot.hasDashboard)
        let gfs = try #require(snapshot.jobs.first?.recentRuns)
        #expect(gfs.count == 2)
        #expect(gfs[1].peakMemoryMb == 912)
        #expect(gfs[1].isFailed)
        #expect(gfs[1].exitCode == 1)
        #expect(gfs[1].finishedAt == ISODate.parse("2026-10-11T15:00:00.5Z"))
        #expect(snapshot.jobs[1].recentRuns?.count == 2, "a run without an id is dropped")
        #expect(snapshot.jobs[2].recentRuns == nil)

        let recent = snapshot.recentRuns(limit: 2)
        #expect(recent.map(\.id) == ["j-1", "j-2"], "finished runs only, newest first")
        #expect(recent[0].job == "icon-eu", "a run without its job takes it from the job")
        #expect(recent[0].durationSeconds == 197)
    }

    @Test func olderControllersHaveNoDashboard() throws {
        let snapshot = try snapshot(#"{"controller": {"status": "online"}, "jobs": [{"id": "a"}]}"#)
        #expect(!snapshot.hasDashboard)
        #expect(snapshot.recentRuns().isEmpty)
    }

    @Test func dashboardAddresses() {
        #expect(DashboardURL.base("http://127.0.0.1:4786")?.absoluteString == "http://127.0.0.1:4786/")
        #expect(DashboardURL.base(" https://mac.tail.ts.net:8443/v1?x=1 ")?.absoluteString == "https://mac.tail.ts.net:8443/")
        #expect(DashboardURL.base("ftp://x") == nil)
        #expect(DashboardURL.route(job: "gfs-wave") == "#/job/gfs-wave")
        #expect(DashboardURL.route(job: "gfs-wave", run: "j-1a2b") == "#/job/gfs-wave/run/j-1a2b")

        let link = "http://127.0.0.1:4786/login?code=abc_DEF-1"
        #expect(DashboardURL.withPage(link, page: nil)?.absoluteString == link)
        let landing = DashboardURL.withPage(link, page: "#/job/gfs/run/j-1")
        let next = URLComponents(url: try! #require(landing), resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "next" }?.value
        #expect(next == "#/job/gfs/run/j-1")
        #expect(DashboardURL.withPage(link, page: "https://evil.example")?.absoluteString == link, "only dashboard routes")
    }

    @Test func reloadAnswer() throws {
        let applied = try JSONDecoder().decode(ReloadResult.self, from: Data(#"""
        {"event": "config_reloaded", "added": [], "removed": [], "changed": ["gfs"], "restartRequired": []}
        """#.utf8))
        #expect(applied.changed == ["gfs"])
        #expect(applied.appliedWithoutRestart)
        let partial = try JSONDecoder().decode(ReloadResult.self, from: Data(#"{"restartRequired": ["api"]}"#.utf8))
        #expect(!partial.appliedWithoutRestart)
    }

    @Test func runOutcomeStyle() {
        #expect(OutcomeStyle(outcome: nil, state: "Failed").label == "Failed")
        #expect(OutcomeStyle(outcome: "unchanged", state: "Completed").label == "No new run")
        #expect(OutcomeStyle(outcome: "published", state: nil).label == "Published")
        #expect(Fmt.megabytes(912) == "912 MB")
        #expect(Fmt.megabytes(1843) == "1.8 GB")
    }
}
