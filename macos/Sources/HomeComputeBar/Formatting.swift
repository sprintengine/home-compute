import Foundation
import SwiftUI

enum Fmt {
    /// "in 12 min", "3 min ago", "in 2 h 5 min", "just now".
    static func relative(_ date: Date?, now: Date = .now) -> String {
        guard let date else { return "-" }
        let delta = date.timeIntervalSince(now)
        let future = delta > 0
        let seconds = abs(delta)
        if seconds < 45 { return future ? "in <1 min" : "just now" }
        let text: String
        switch seconds {
        case ..<3600:
            text = "\(Int((seconds / 60).rounded())) min"
        case ..<(6 * 3600):
            let minutes = Int((seconds / 60).rounded())
            text = minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
        case ..<(48 * 3600):
            text = "\(Int((seconds / 3600).rounded())) h"
        default:
            text = "\(Int((seconds / 86400).rounded())) d"
        }
        return future ? "in \(text)" : "\(text) ago"
    }

    /// Elapsed time: "42s", "4m 05s", "1h 03m".
    static func duration(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return String(format: "%dm %02ds", s / 60, s % 60) }
        return String(format: "%dh %02dm", s / 3600, (s % 3600) / 60)
    }

    /// A size in MB from a report's `…Mb` field: "912 MB", "1.8 GB".
    static func megabytes(_ value: Double) -> String {
        value >= 1024 ? String(format: "%.1f GB", value / 1024) : "\(Int(value.rounded())) MB"
    }

    static func clock(_ date: Date) -> String {
        date.formatted(date: .omitted, time: .standard)
    }

    /// "Hourly at :45 UTC", "03:30, 09:30, 15:30, 21:30 UTC", "Every 1h".
    static func schedule(_ schedule: Schedule?) -> String {
        guard let schedule else { return "Manual" }
        let zone = timezoneLabel(schedule.timezone)
        if let at = schedule.at {
            return times(hours: at.hours, minutes: at.minutes ?? [], zone: zone)
        }
        if let every = schedule.every { return "Every \(every)" }
        if let cron = schedule.cron { return "Cron \(cron) \(zone)" }
        return "Manual"
    }

    /// Times of day for an hours × minutes schedule: "03:30, 09:30, 15:30, 21:30 UTC",
    /// "Hourly at :00, :30 UTC" (hours nil or all 24), or for long lists
    /// "At :15 past 00, 02, 04, … 22 h UTC".
    static func times(hours: [Int]?, minutes: [Int], zone: String = "UTC") -> String {
        let minutes = (minutes.isEmpty ? [0] : minutes).sorted()
        let pastHour = minutes.map { String(format: ":%02d", $0) }.joined(separator: ", ")
        guard let hours = hours?.sorted(), !hours.isEmpty, Set(hours).count < 24 else {
            return "Hourly at \(pastHour) \(zone)"
        }
        if hours.count * minutes.count > 8 {
            return "At \(pastHour) past " + hours.map { String(format: "%02d", $0) }.joined(separator: ", ") + " h \(zone)"
        }
        let times = hours.flatMap { h in minutes.map { String(format: "%02d:%02d", h, $0) } }
        return times.joined(separator: ", ") + " " + zone
    }

    /// "531 MB"
    static func bytes(_ count: Int64) -> String {
        ByteCountFormatter.string(fromByteCount: count, countStyle: .file)
    }

    /// "55 min", "1 h 30 min"
    static func minutes(_ seconds: Int) -> String {
        let minutes = (seconds + 59) / 60
        if minutes < 60 { return "\(minutes) min" }
        return minutes % 60 == 0 ? "\(minutes / 60) h" : "\(minutes / 60) h \(minutes % 60) min"
    }

    static func timezoneLabel(_ id: String?) -> String {
        guard let id, !["UTC", "Etc/UTC", "GMT", "Z"].contains(id) else { return "UTC" }
        return id
    }

    private static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

    /// Model run id `YYYYMMDDHH` -> "08 Oct 18Z"; anything else is shown as-is.
    static func modelRun(_ run: String?) -> String {
        guard let run else { return "-" }
        let digits = Array(run)
        guard digits.count >= 8, digits.allSatisfy(\.isNumber),
              let month = Int(String(digits[4..<6])), (1...12).contains(month) else { return run }
        let day = String(digits[6..<8])
        let date = "\(day) \(months[month - 1])"
        return digits.count >= 10 ? "\(date) \(String(digits[8..<10]))Z" : date
    }

    static func modelName(_ id: String) -> String { id.uppercased() }
}

struct OutcomeStyle {
    var label: String
    var color: Color

    init(job: Job) {
        if job.pendingSubmissionError != nil {
            self.init(label: "Submission failed", color: .red)
            return
        }
        self.init(outcome: job.outcome)
    }

    /// A history run's outcome, else its Bacalhau state.
    init(outcome: String?, state: String?) {
        if outcome == nil, let state, ["failed", "error"].contains(state.lowercased()) {
            self.init(outcome: "failed")
        } else {
            self.init(outcome: outcome?.lowercased() ?? state?.lowercased())
        }
    }

    private init(outcome: String?) {
        switch outcome {
        case "published": self.init(label: "Published", color: .green)
        case "unchanged": self.init(label: "No new run", color: .secondary)
        case "failed": self.init(label: "Failed", color: .red)
        case "completed": self.init(label: "Completed", color: .green)
        case "stopped": self.init(label: "Stopped", color: .orange)
        case let other?: self.init(label: other.capitalized, color: .secondary)
        case nil: self.init(label: "Not run yet", color: .secondary)
        }
    }

    private init(label: String, color: Color) {
        self.label = label
        self.color = color
    }
}
