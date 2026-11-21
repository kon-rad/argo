import SwiftUI

@main
struct AgentDockApp: App {
    @StateObject private var voice = VoiceController()
    @StateObject private var store = Store()

    var body: some Scene {
        WindowGroup("Agent Dock") {
            ContentView()
                .environmentObject(store)
                .environmentObject(voice)
                .sheet(isPresented: $voice.settingsShown) { VoiceSetup(voice: voice).environmentObject(store) }
                .onOpenURL { url in
                    guard url.scheme == "agent-dock", url.host == "voice", voice.phase == .idle,
                          let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return }
                    if let path = items.first(where: { $0.name == "workspace" })?.value { voice.workspace = path }
                    voice.configure(items.first(where: { $0.name == "agent" })?.value ?? "")
                    NSApp.activate(ignoringOtherApps: true)
                }
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in voice.end() }
                .frame(minWidth: 760, minHeight: 520)
                .onAppear {
                    store.start()
                    SelfCheck.runIfAsked(store)
                }
        }
        .defaultSize(width: 1040, height: 760)
        .commands {
            CommandMenu("Voice") { VoiceActions(voice: voice, vault: store.vault) }
            CommandGroup(after: .newItem) {
                Button("Choose Vault...") { store.chooseVault() }.keyboardShortcut("o")
                Button("Reload") { store.loadRoster(); store.refresh() }.keyboardShortcut("r")
            }
        }
        MenuBarExtra(isInserted: Binding(get: { voice.phase != .idle || !voice.problem.isEmpty }, set: { _ in })) {
            Text(voice.micLabel + " · " + voice.taskLabel)
            Text(voice.playing.isEmpty ? "Playback quiet" : "Speaking: " + voice.playing)
            if !voice.draft.isEmpty { Text(voice.draft) }
            if !voice.problem.isEmpty {
                Text(voice.problem)
                Button("Dismiss Error") { voice.problem = "" }
            }
            Divider()
            VoiceActions(voice: voice, vault: store.vault, shortcuts: false)
        } label: {
            Label(voice.micLabel, systemImage: voice.phase == .live ? "mic.fill" : "mic.slash")
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
    @EnvironmentObject var voice: VoiceController
    @State private var search = ""

    var body: some View {
        VStack(spacing: 0) {
            if !voice.problem.isEmpty { Banner(text: voice.problem, tint: .orange) { Button("Dismiss") { voice.problem = "" } } }
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
