import AVFoundation
import SwiftUI

struct VoiceActions: View {
    @ObservedObject var voice: VoiceController
    let vault: String
    var shortcuts = true

    var body: some View {
        ForEach(VoiceCommand.allCases, id: \.self) { command in
            let hint = shortcuts ? "" : (command.key.map { "  ⌃⌥⌘" + String($0).uppercased() } ?? "")
            let button = Button(command.title(voice.phase) + hint) { voice.perform(command, vault: vault) }
                .disabled(!command.enabled(voice.phase))
            if shortcuts, let key = command.key {
                button.keyboardShortcut(KeyEquivalent(key), modifiers: VoiceCommand.modifiers)
            } else { button }
        }
    }
}

struct VoiceShortcutInfo: View {
    var body: some View {
        Menu {
            ForEach(VoiceCommand.allCases, id: \.self) { command in
                Text(command.title(.live) + (command.key.map { "  ⌃⌥⌘" + String($0).uppercased() } ?? "  ·  menu"))
            }
        } label: { Image(systemName: "info.circle") }
        .help("Voice shortcuts")
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
            HStack { Text("Start Voice").font(.title2); VoiceShortcutInfo() }
            Picker("Codex persona", selection: $voice.agent) {
                Text("Choose a persona").tag("")
                ForEach(store.roster?.agents.filter { $0.runtime == "codex" } ?? []) { agent in
                    Text(agent.displayName).tag(agent.name)
                }
            }
            HStack {
                Button("Choose alternate folder…") { folder("Use folder") { voice.workspace = $0 } }
                Button("Use vault") { voice.workspace = "" }
                Text(voice.workspace.isEmpty ? store.vault : voice.workspace).lineLimit(1).truncationMode(.middle)
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
                            ProgressView(value: r.cpu / max(r.cpu, r.vulkan)).accessibilityLabel("Reference CPU speed relative to Vulkan")
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
                Text("System default · \(AVSpeechSynthesisVoice(language: AVSpeechSynthesisVoice.currentLanguageCode())?.name ?? "System voice")").tag("")
                if KokoroOutput.interpreter != nil { Text("Kokoro · Bella (local MLX)").tag("kokoro:af_bella") }
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
                    .disabled(voice.model.isEmpty || voice.agent.isEmpty)
            }
        }.padding(20).frame(width: 550)
    }
}

struct VoiceInputMonitor: View {
    @ObservedObject var voice: VoiceController
    var body: some View {
        HStack {
            Canvas { context, size in
                let step = size.width / CGFloat(voice.levels.count)
                for (index, level) in voice.levels.enumerated() {
                    let height = max(1, size.height * level)
                    let rect = CGRect(x: CGFloat(index) * step, y: (size.height - height) / 2,
                                      width: max(1, step - 1), height: height)
                    context.fill(Path(rect), with: .color(.accentColor))
                }
            }.frame(width: 96, height: 25).accessibilityLabel("Microphone level")
            Text(voice.phase == .live ? voice.captureStatus : voice.micLabel)
            Button("Sound input…") {
                if let url = URL(string: "x-apple.systempreferences:com.apple.Sound-Settings.extension") {
                    NSWorkspace.shared.open(url)
                }
            }
            VoiceShortcutInfo()
        }.padding(8)
    }
}
