import SwiftUI

@main
struct AgentDockApp: App {
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup("Agent Dock") {
            ContentView()
                .environmentObject(store)
                .frame(minWidth: 760, minHeight: 520)
                .onAppear {
                    store.start()
                    SelfCheck.runIfAsked(store)
                }
        }
        .defaultSize(width: 1040, height: 760)
        .commands {
            CommandGroup(after: .newItem) {
                Button("Choose Vault...") { store.chooseVault() }.keyboardShortcut("o")
                Button("Reload") { store.loadRoster(); store.refresh() }.keyboardShortcut("r")
            }
        }
    }
}

enum Pane: String, CaseIterable, Identifiable {
    case agents = "Agents"
    case running = "Running"
    case history = "History"
    var id: String { rawValue }
}

struct ContentView: View {
    @EnvironmentObject var store: Store
    @State private var search = ""

    var body: some View {
        VStack(spacing: 0) {
            if let problem = store.problem {
                Banner(text: problem, tint: .orange) {
                    Button("Choose Vault...") { store.chooseVault() }
                }
            }
            if let notice = store.notice {
                Banner(text: notice, tint: .accentColor) { EmptyView() }
            }
            switch store.pane {
            case .agents: AgentsView(search: search)
            case .running: RunningView()
            case .history: HistoryView(search: search)
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Picker("View", selection: $store.pane) {
                    ForEach(Pane.allCases) { p in
                        Text(label(p)).tag(p)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 330)
            }
        }
        .searchable(text: $search, prompt: store.pane == .history ? "Agent, model, ticket" : "Agent, role, team")
        .navigationTitle(store.roster.map { $0.company.isEmpty ? "Agent Dock" : "\($0.company) agents" } ?? "Agent Dock")
        .navigationSubtitle(store.snapshot.map { "on \($0.host)" } ?? "")
    }

    private func label(_ p: Pane) -> String {
        if p == .running, let n = store.snapshot?.runs.count, n > 0 { return "Running (\(n))" }
        return p.rawValue
    }
}

struct Banner<Trailing: View>: View {
    let text: String
    let tint: Color
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        HStack {
            Text(text).font(.callout).lineLimit(2)
            Spacer()
            trailing()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(tint.opacity(0.16))
    }
}

/// `AgentDock --snapshot <dir>` draws each pane of its own window to a PNG and quits.
/// It lets a build be checked on a machine where nothing may record the screen.
enum SelfCheck {
    @MainActor static func runIfAsked(_ store: Store) {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count else { return }
        let dir = URL(fileURLWithPath: args[i + 1])
        Task { @MainActor in
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            for pane in Pane.allCases {
                store.pane = pane
                try? await Task.sleep(nanoseconds: 4_000_000_000)
                guard let view = NSApp.windows.first(where: { $0.isVisible })?.contentView,
                      let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
                view.cacheDisplay(in: view.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?
                    .write(to: dir.appendingPathComponent("\(pane.rawValue.lowercased()).png"))
            }
            NSApp.terminate(nil)
        }
    }
}
