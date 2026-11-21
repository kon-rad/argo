import SwiftUI

struct AgentsView: View {
    @EnvironmentObject var store: Store
    let search: String

    private var teams: [(name: String, agents: [Agent])] {
        guard let roster = store.roster else { return [] }
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        let shown = roster.agents.filter { a in
            q.isEmpty || [a.name, a.role, a.team_name].contains { $0.lowercased().contains(q) }
        }
        var order: [String] = []
        var groups: [String: [Agent]] = [:]
        for a in shown {
            if groups[a.team_name] == nil { order.append(a.team_name) }
            groups[a.team_name, default: []].append(a)
        }
        return order.map { name in
            (name, groups[name]!.sorted { ($0.is_lead ? 0 : 1, $0.name) < ($1.is_lead ? 0 : 1, $1.name) })
        }
    }

    var body: some View {
        if let roster = store.roster {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    ForEach(teams, id: \.name) { team in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(team.name.uppercased())
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .kerning(0.8)
                            LazyVGrid(columns: [GridItem(.adaptive(minimum: 232, maximum: 280), spacing: 14)],
                                      alignment: .leading, spacing: 14) {
                                ForEach(team.agents) { agent in
                                    AgentCard(agent: agent, runtimes: roster.runtimes)
                                }
                            }
                        }
                    }
                    if teams.isEmpty {
                        Text("No agent matches \"\(search)\".").foregroundStyle(.secondary)
                    }
                }
                .padding(20)
            }
        } else {
            VStack(spacing: 12) {
                Text("No roster loaded").font(.title3)
                Text(store.vault.isEmpty ? "Choose the vault that holds your agents." : store.vault)
                    .foregroundStyle(.secondary)
                Button("Choose Vault...") { store.chooseVault() }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct AgentCard: View {
    @EnvironmentObject var store: Store
    @EnvironmentObject var voice: VoiceController
    let agent: Agent
    let runtimes: [Runtime]
    @State private var hovering = false

    private var running: Int {
        store.snapshot?.runs.filter { $0.agent == agent.name }.count ?? 0
    }

    var body: some View {
        VStack(spacing: 8) {
            ZStack(alignment: .topTrailing) {
                portrait
                    .frame(width: 104, height: 104)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                if running > 0 {
                    Circle().fill(.green).frame(width: 12, height: 12)
                        .overlay(Circle().stroke(Color(nsColor: .windowBackgroundColor), lineWidth: 2))
                        .offset(x: 4, y: -4)
                        .help("\(running) running on this machine")
                }
            }
            .onTapGesture { launchDefault() }
            .help("Open \(agent.displayName) on \(defaultRuntime?.label ?? "the first runtime")")

            VStack(spacing: 2) {
                Text(agent.displayName).font(.headline)
                Text(agent.role)
                    .font(.caption)
                    .multilineTextAlignment(.center)
                    .lineLimit(2, reservesSpace: true)
                Text(agent.team_name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            }

            if agent.runtime == "codex" {
                Button("Start Voice…") { voice.configure(agent.name) }
                    .controlSize(.small).disabled(voice.phase != .idle)
            }
            HStack(spacing: 4) {
                ForEach(runtimes) { rt in
                    Group {
                        if rt.choices.isEmpty {
                            Button(rt.short) { store.launch(agent, rt) }
                        } else {
                            // Click starts the default; the arrow lists every provider and model.
                            Menu(rt.short) {
                                ForEach(rt.groups, id: \.name) { group in
                                    Section(group.name) {
                                        ForEach(group.choices) { choice in
                                            Button(choice.menuTitle) { store.launch(agent, rt, choice) }
                                        }
                                    }
                                }
                            } primaryAction: {
                                store.launch(agent, rt)
                            }
                            .fixedSize()
                        }
                    }
                    .controlSize(.small)
                    .fixedSize()
                    .disabled(!rt.installed)
                    .help(help(rt))
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color(nsColor: .controlBackgroundColor).opacity(hovering ? 1 : 0.6)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(Color.secondary.opacity(hovering ? 0.45 : 0.18)))
        .onHover { hovering = $0 }
    }

    private func help(_ rt: Runtime) -> String {
        guard rt.installed else { return "\(rt.label) is not installed on this machine" }
        let with = rt.model.isEmpty ? "" : " with \(rt.model)"
        return "Open \(agent.displayName) in a terminal on \(rt.label)\(with)"
    }

    private var defaultRuntime: Runtime? { runtimes.first { $0.installed } }

    private func launchDefault() {
        if let rt = defaultRuntime { store.launch(agent, rt) }
    }

    @ViewBuilder private var portrait: some View {
        if let image = Avatars.image(agent.avatar) {
            Image(nsImage: image).resizable().scaledToFill()
        } else {
            ZStack {
                Color.secondary.opacity(0.18)
                Text(agent.displayName.prefix(1)).font(.system(size: 42, weight: .semibold)).foregroundStyle(.secondary)
            }
        }
    }
}
