import Foundation

// The JSON that `agent-dock --json` prints. The CLI owns every rule; this app only draws it.

struct Roster: Codable {
    let vault: String
    let company: String
    let host: String
    let agents: [Agent]
    let runtimes: [Runtime]
    let terminal: String
}

struct Agent: Codable, Identifiable, Hashable {
    let name: String
    let role: String
    let team: String
    let team_name: String
    let is_lead: Bool
    let avatar: String?
    let runtime: String
    let model: String
    var id: String { name }
    var displayName: String { name.prefix(1).uppercased() + name.dropFirst() }
}

struct Runtime: Codable, Identifiable, Hashable {
    let id: String
    let label: String
    let installed: Bool
    let model: String
    var short: String { id.prefix(1).uppercased() + id.dropFirst() }
}

struct Run: Codable, Identifiable {
    let runId: String?
    let source: String?
    let agent: String?
    let role: String?
    let team: String?
    let harness: String?
    let provider: String?
    let model: String?
    let ticket: String?
    let mode: String?
    let cwd: String?
    let host: String?
    let pid: Int?
    let command: String?
    let started_at: String?
    let ended_at: String?
    let exit_code: Int?
    let seconds: Int?

    // Runs this tool did not start have no id of their own: the process and its start time name them.
    var id: String { runId ?? "\(pid ?? 0)-\(started_at ?? "")" }

    enum CodingKeys: String, CodingKey {
        case runId = "id"
        case source, agent, role, team, harness, provider, model, ticket, mode, cwd, host, pid, command
        case started_at, ended_at, exit_code, seconds
    }
    var agentLabel: String { (agent ?? "").isEmpty ? "(no persona)" : agent! }
    var folder: String { cwd.map { ($0 as NSString).lastPathComponent } ?? "" }
}

struct LocalModel: Codable, Identifiable {
    let provider: String
    let name: String
    let bytes: Int
    let expires_at: String
    var id: String { provider + "/" + name }
}

struct Snapshot: Codable {
    let host: String
    let at: String
    let runs: [Run]
    let models: [LocalModel]
}

struct History: Codable {
    let host: String
    let runs: [Run]
}

struct DockFailure: Codable { let error: String }

enum Stamp {
    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static let day: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d, HH:mm"
        return f
    }()
    static let relative: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f
    }()

    static func date(_ s: String?) -> Date? { s.flatMap { iso.date(from: $0) } }
    static func clock(_ s: String?) -> String { date(s).map { day.string(from: $0) } ?? "" }
    static func ago(_ s: String?) -> String { date(s).map { relative.localizedString(for: $0, relativeTo: Date()) } ?? "" }
    static func length(_ seconds: Int?) -> String {
        guard let s = seconds else { return "" }
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(s % 60)s" }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }
}
