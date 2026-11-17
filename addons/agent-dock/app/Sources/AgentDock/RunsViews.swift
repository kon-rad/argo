import SwiftUI

struct RunningView: View {
    @EnvironmentObject var store: Store

    var body: some View {
        let runs = store.snapshot?.runs ?? []
        let models = store.snapshot?.models ?? []
        VStack(alignment: .leading, spacing: 0) {
            if runs.isEmpty {
                Text("No agent is running on this machine.")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                Table(runs) {
                    TableColumn("Agent") { r in
                        Text(r.agentLabel).foregroundStyle((r.agent ?? "").isEmpty ? .secondary : .primary)
                    }
                    TableColumn("Harness") { r in Text(r.harness ?? "") }.width(min: 60, ideal: 80)
                    TableColumn("Mode") { r in Text(r.mode ?? "") }.width(min: 70, ideal: 90)
                    TableColumn("Provider") { r in Text(r.provider ?? "") }.width(min: 70, ideal: 90)
                    TableColumn("Model") { r in Text(r.model ?? "") }
                    TableColumn("Ticket") { r in Text(r.ticket ?? "").monospaced() }.width(min: 80, ideal: 100)
                    TableColumn("Folder") { r in Text(r.folder).help(r.cwd ?? "") }
                    TableColumn("Started") { r in Text(Stamp.ago(r.started_at)).help(Stamp.clock(r.started_at)) }
                        .width(min: 80, ideal: 110)
                    TableColumn("PID") { r in Text(r.pid.map(String.init) ?? "").monospaced() }.width(min: 50, ideal: 64)
                }
            }
            Divider()
            HStack(spacing: 10) {
                Text("LOCAL MODELS IN MEMORY").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                if models.isEmpty {
                    Text("none").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(models) { m in
                    Text("\(m.name)  \(ByteCountFormatter.string(fromByteCount: Int64(m.bytes), countStyle: .memory))")
                        .font(.caption.monospaced())
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(Capsule().fill(Color.green.opacity(0.18)))
                        .help("\(m.provider), loaded until \(Stamp.clock(m.expires_at))")
                }
                Spacer()
                Text(store.snapshot.map { "updated \(Stamp.clock($0.at))" } ?? "")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 16).padding(.vertical, 9)
        }
    }
}

struct HistoryView: View {
    @EnvironmentObject var store: Store
    let search: String

    private var rows: [Run] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return store.history }
        return store.history.filter { r in
            [r.agent, r.harness, r.provider, r.model, r.ticket, r.cwd].contains { ($0 ?? "").lowercased().contains(q) }
        }
    }

    var body: some View {
        if store.history.isEmpty {
            Text("No runs recorded yet. Runs opened here, and runs seen while this window is open, are kept.")
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            Table(rows) {
                TableColumn("Started") { r in Text(Stamp.clock(r.started_at)) }.width(min: 100, ideal: 120)
                TableColumn("Agent") { r in
                    Text(r.agentLabel).foregroundStyle((r.agent ?? "").isEmpty ? .secondary : .primary)
                }
                TableColumn("Harness") { r in Text(r.harness ?? "") }.width(min: 60, ideal: 80)
                TableColumn("Mode") { r in Text(r.mode ?? "") }.width(min: 70, ideal: 90)
                TableColumn("Provider") { r in Text(r.provider ?? "") }.width(min: 70, ideal: 90)
                TableColumn("Model") { r in Text(r.model ?? "") }
                TableColumn("Ticket") { r in Text(r.ticket ?? "").monospaced() }.width(min: 80, ideal: 100)
                TableColumn("Folder") { r in Text(r.folder).help(r.cwd ?? "") }
                TableColumn("Length") { r in
                    if r.ended_at == nil {
                        Text("running").foregroundStyle(.green)
                    } else {
                        Text(Stamp.length(r.seconds))
                    }
                }.width(min: 60, ideal: 80)
                TableColumn("Started by") { r in Text(r.source == "dock" ? "Agent Dock" : "elsewhere") }
                    .width(min: 70, ideal: 90)
            }
        }
    }
}
