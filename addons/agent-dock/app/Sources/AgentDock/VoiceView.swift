import AVFoundation
import SwiftUI

struct VoiceActions: View {
    @ObservedObject var voice: VoiceController
    let vault: String
    var shortcuts = true

    var body: some View {
        ForEach(VoiceCommand.allCases, id: \.self) { command in
            let button = Button(command.title(voice.phase)) { voice.perform(command, vault: vault) }
                .disabled(!command.enabled(voice.phase))
            if shortcuts, let key = command.key {
                button.keyboardShortcut(KeyEquivalent(key), modifiers: VoiceCommand.modifiers)
            } else { button }
        }
    }
}

struct VoiceSetup: View {
    @EnvironmentObject var store: Store
    @ObservedObject var voice: VoiceController

    private func folder(_ title: String, update: (String) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.prompt = title
        if panel.runModal() == .OK, let path = panel.url?.path { update(path) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Start Voice").font(.title2)
            Picker("Codex persona", selection: $voice.agent) {
                Text("Choose a persona").tag("")
                ForEach(store.roster?.agents.filter { $0.runtime == "codex" } ?? []) { agent in
                    Text(agent.displayName).tag(agent.name)
                }
            }
            HStack {
                Button("Choose worktree…") { folder("Use worktree") { voice.workspace = $0 } }
                Text(voice.workspace).lineLimit(1).truncationMode(.middle)
            }
            HStack {
                Text("Recognition").font(.headline)
                Spacer()
                Button("Scan model folder…") {
                    folder("Scan folder") { voice.folder = $0; voice.loadModels() }
                }
            }
            if voice.models.isEmpty { Text("No cached recognizers found.").foregroundStyle(.secondary) }
            ScrollView {
                ForEach(voice.models) { row in
                    VStack(alignment: .leading, spacing: 4) {
                        Button {
                            voice.model = row.path
                        } label: {
                            Label(row.name, systemImage: voice.model == row.path ? "largecircle.fill.circle" : "circle")
                        }.buttonStyle(.plain)
                        if let r = row.reference {
                            Text("Speed  \(r.cpu.formatted())× CPU · \(r.vulkan.formatted())× Vulkan")
                            ProgressView(value: r.cpu / max(r.cpu, r.vulkan))
                            Text("Accuracy  \(r.error.formatted())% error · \(r.dataset)")
                            ProgressView(value: 1 - r.error / 100)
                            Text("\(r.release) · \(r.engine) · \(r.variant) · \(r.host) · \(r.speedUnit)")
                                .font(.caption)
                        } else { Text("Speed  Unrated   ·   Accuracy  Unrated") }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 4)
                    Divider()
                }
            }.frame(height: 160)
            Picker("Speech output", selection: $voice.voiceID) {
                Text("System default voice").tag("")
                ForEach(AVSpeechSynthesisVoice.speechVoices(), id: \.identifier) { v in
                    Text("\(v.name) (\(v.language))").tag(v.identifier)
                }
            }
            Text("Synthesis speed  Unmeasured   ·   Intelligibility  Unmeasured").font(.caption)
            Text("Audio stays on this Mac. Final transcripts and workspace context go to your configured Codex provider.")
                .font(.callout)
            if !voice.problem.isEmpty { Text(voice.problem).foregroundStyle(.orange) }
            HStack {
                Spacer()
                Button("Cancel") { voice.settingsShown = false }
                Button("Start Voice") { voice.start(vault: store.vault) }
                    .disabled(voice.workspace.isEmpty || voice.model.isEmpty || voice.agent.isEmpty)
            }
        }.padding(20).frame(width: 550)
    }
}
