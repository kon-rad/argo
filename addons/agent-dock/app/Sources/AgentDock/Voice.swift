import AVFoundation
import SwiftUI

enum VoicePhase { case idle, preparing, live, muted, paused }

enum VoiceCommand: CaseIterable {
    case toggle, mute, silence, stop, end
    static let modifiers: EventModifiers = [.control, .option, .command]
    var key: Character? {
        switch self {
        case .toggle: return "v"
        case .mute: return "m"
        case .silence: return "s"
        default: return nil
        }
    }
    func title(_ state: VoicePhase) -> String {
        switch self {
        case .toggle:
            switch state {
            case .idle: return "Pause / Resume Voice"
            case .paused: return "Resume Voice"
            default: return "Pause Voice"
            }
        case .mute: return state == .muted ? "Unmute Mic" : "Mute Mic"
        case .silence: return "Silence Reply"
        case .stop: return "Stop Task"
        case .end: return "End Voice"
        }
    }
    func enabled(_ state: VoicePhase) -> Bool {
        switch self {
        case .toggle: return state != .idle && state != .preparing
        case .mute: return state == .live || state == .muted
        case .silence, .stop: return state != .idle && state != .preparing
        case .end: return state != .idle
        }
    }
}

struct VoiceModel: Decodable, Identifiable {
    struct Reference: Decodable {
        let variant, dataset, host, engine, release, speedUnit: String
        let error, cpu, vulkan: Double
    }
    let path, name, adapter: String
    let reference: Reference?
    var id: String { path }
}

final class PCMEncoder {
    let format: AVAudioFormat
    let converter: AVAudioConverter
    init(_ input: AVAudioFormat) throws {
        guard let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000,
                                         channels: 1, interleaved: false),
              let convert = AVAudioConverter(from: input, to: output) else {
            throw DockCLI.Failed(message: "Unsupported microphone format")
        }
        format = output
        converter = convert
    }
    func convert(_ input: AVAudioPCMBuffer) throws -> Data {
        let frames = ceil(Double(input.frameLength) * format.sampleRate / input.format.sampleRate)
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else {
            throw DockCLI.Failed(message: "Cannot allocate microphone buffer")
        }
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, result in
            result.pointee = supplied ? .noDataNow : .haveData
            if supplied { return nil }
            supplied = true
            return input
        }
        if let error { throw error }
        guard status != .error, let samples = out.int16ChannelData else {
            throw DockCLI.Failed(message: "Microphone conversion failed")
        }
        return Data(bytes: samples[0], count: Int(out.frameLength) * 2)
    }
}

@MainActor
final class VoiceController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var phase: VoicePhase = .idle
    @Published var settingsShown = false
    @Published var agent = ""
    private var backendReady = false
    var runtime = "codex", agentModel = "", provider = "", baseURL = ""
    @Published var workspace = ""
    @Published var model = UserDefaults.standard.string(forKey: "voiceModel") ?? ""
    @Published var folder = UserDefaults.standard.string(forKey: "voiceModelFolder") ?? ""
    @Published var voiceID = UserDefaults.standard.string(forKey: "voiceOutput") ?? ""
    @Published var models = [VoiceModel]()
    @Published var taskLabel = "Idle"
    @Published var playing = ""
    @Published var draft = ""
    @Published var problem = ""
    @Published var captureStatus = "Waiting for microphone"
    @Published var inputLevel: Double = 0
    @Published var levels = Array(repeating: 0.0, count: 32)
    private var captureTimer: Timer?
    private var lastFrameTime: TimeInterval = 0
    private var lastLoudTime: TimeInterval = 0
    private var lastStatus = ""
    private var process: Process?
    private var input: FileHandle?
    private var capture: AVAudioEngine?
    private var captureID = UUID()
    private var sessionID = UUID()
    private var generation = 0
    private var mutedBeforePause = false
    private let kokoro = KokoroOutput()
    private let synth = AVSpeechSynthesizer()
    private var utterances = Set<ObjectIdentifier>()

    override init() {
        super.init()
        synth.delegate = self
        kokoro.report = { [weak self] in self?.fail($0) }
        kokoro.speaking = { [weak self] in self?.playing = $0 }
    }
    nonisolated static var worker: URL {
        URL(fileURLWithPath: DockCLI.path).deletingLastPathComponent().appendingPathComponent("voice/worker.py")
    }
    var micLabel: String {
        switch phase {
        case .idle: return "Voice off"
        case .preparing: return "Preparing voice"
        case .paused: return "Voice paused"
        case .live: return "Mic live"
        case .muted: return "Mic muted"
        }
    }
    func loadModels() {
        let selected = folder
        Task {
            do {
                let rows = try await Task.detached {
                    let p = Process(), out = Pipe()
                    p.executableURL = Self.worker
                    p.arguments = ["models", "--folder", selected]
                    p.standardOutput = out
                    try p.run()
                    let data = out.fileHandleForReading.readDataToEndOfFile()
                    p.waitUntilExit()
                    guard p.terminationStatus == 0 else { throw DockCLI.Failed(message: "Model discovery failed") }
                    return try JSONDecoder().decode([VoiceModel].self, from: data)
                }.value
                guard folder == selected else { return }
                models = rows
                if !rows.contains(where: { $0.path == model }) { model = rows.first?.path ?? "" }
            } catch { problem = error.localizedDescription }
        }
    }
    func configure(_ name: String) {
        guard phase == .idle else { return }
        problem = ""
        agent = name
        settingsShown = true
        loadModels()
    }
    func perform(_ command: VoiceCommand, vault: String) {
        guard command.enabled(phase) else { return }
        switch command {
        case .toggle:
            switch phase {
            case .idle:
                if !agent.isEmpty && !model.isEmpty { start(vault: vault) }
                else { configure(agent) }
            case .paused: mutedBeforePause ? (phase = .muted) : listen()
            case .live, .muted:
                mutedBeforePause = phase == .muted
                stopMic()
                silence()
                phase = .paused
            case .preparing: break
            }
        case .mute:
            if phase == .muted { listen() } else { stopMic(); phase = .muted }
        case .silence: silence()
        case .stop: send(["kind":"stop"])
        case .end: end()
        }
    }

    func start(vault: String) {
        guard phase == .idle, !agent.isEmpty, !model.isEmpty else { return }
        if voiceID != "kokoro:af_bella" && !voiceID.isEmpty && AVSpeechSynthesisVoice(identifier: voiceID) == nil {
            problem = "The selected system voice is unavailable."
            return
        }
        problem = ""
        backendReady = false
        taskLabel = "Connecting to " + runtime
        phase = .preparing
        settingsShown = false
        let id = UUID()
        sessionID = id
        Task {
            guard await AVCaptureDevice.requestAccess(for: .audio) else {
                if sessionID == id { fail("Microphone permission denied") }
                return
            }
            guard sessionID == id else { return }
            let p = Process(), out = Pipe(), stdin = Pipe()
            p.executableURL = Self.worker
            p.arguments = ["session", "--agent", agent, "--vault", vault, "--workspace", workspace.isEmpty ? vault : workspace,
                           "--model", model, "--folder", folder, "--runtime", runtime, "--agent-model", agentModel, "--provider", provider, "--base-url", baseURL]
            p.standardInput = stdin
            p.standardOutput = out
            do {
                if voiceID == "kokoro:af_bella" {
                    try kokoro.start(script: Self.worker.deletingLastPathComponent().appendingPathComponent("kokoro_output.py"))
                }
                try p.run()
                process = p
                input = stdin.fileHandleForWriting
                listen()
                guard capture != nil, sessionID == id else { return }
                Task {
                    try? await Task.sleep(nanoseconds: 90_000_000_000)
                    if sessionID == id && !backendReady { fail("The selected voice harness did not become ready. Check Ghostty and the model settings.") }
                }
                let handle = out.fileHandleForReading
                let lines = AsyncStream<String> { continuation in
                    DispatchQueue.global(qos: .userInitiated).async {
                        var pending = Data()
                        while true {
                            let chunk = handle.availableData
                            if chunk.isEmpty { break }
                            pending.append(chunk)
                            while let end = pending.firstIndex(of: 10) {
                                continuation.yield(String(decoding: pending[..<end], as: UTF8.self))
                                pending.removeSubrange(...end)
                            }
                        }
                        continuation.finish()
                    }
                }
                for await line in lines {
                    guard sessionID == id else { break }
                    guard let msg = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any],
                          let kind = msg["kind"] as? String, let text = msg["text"] as? String else { continue }
                    receive(kind, text, epoch: msg["epoch"] as? Int ?? 0)
                }
                if sessionID == id { fail(problem.isEmpty ? "Voice worker disconnected" : problem) }
            } catch { if sessionID == id { fail(error.localizedDescription) } }
        }
    }
    func saveSelection() {
        for (value, key) in [(model,"voiceModel"), (folder,"voiceModelFolder"), (voiceID,"voiceOutput")] {
            UserDefaults.standard.set(value, forKey: key)
        }
    }
    private func stamp(_ stage: String) {
        send(["kind":"timing", "seconds":ProcessInfo.processInfo.systemUptime, "stage":stage])
    }
    private func receive(_ kind: String, _ text: String, epoch: Int) {
        if ["endpoint", "final", "clause"].contains(kind) { stamp(kind) }
        switch kind {
        case "ready":
            backendReady = true
            lastStatus = ""
            taskLabel = "Idle"
            if phase == .live { saveSelection() }
        case "draft", "final": if phase == .live { draft = text }
        case "task": taskLabel = text
        case "approval": taskLabel = "Waiting for approval in Ghostty"
        case "error": problem = text
        case "disconnect": fail(problem.isEmpty ? text : problem)
        case "silence": stopPlayback(); stamp("stop playback requested")
        case "clause":
            guard (phase == .live || phase == .muted), epoch == generation else { return }
            if voiceID == "kokoro:af_bella" { kokoro.speak(text); return }
            let utterance = AVSpeechUtterance(string: text)
            if !voiceID.isEmpty { utterance.voice = AVSpeechSynthesisVoice(identifier: voiceID) }
            utterances.insert(ObjectIdentifier(utterance))
            synth.speak(utterance)
        default: break
        }
    }
    private func listen() {
        let engine = AVAudioEngine()
        let id = UUID()
        captureID = id
        do {
            let node = engine.inputNode
            try node.setVoiceProcessingEnabled(true)
            let format = node.outputFormat(forBus: 0)
            guard format.sampleRate > 0, format.channelCount > 0 else {
                throw DockCLI.Failed(message: "No usable microphone input. Choose an input in macOS Sound settings and start voice again.")
            }
            let encoder = try PCMEncoder(format)
            let device = AVCaptureDevice.default(for: .audio)
            let route = device?.localizedName ?? "System input"
            captureStatus = "Waiting for microphone frames · \(route)"
            lastStatus = ""
            lastFrameTime = 0
            lastLoudTime = ProcessInfo.processInfo.systemUptime
            captureTimer?.invalidate()
            captureTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.captureID == id, self.phase == .live else { return }
                    if let selected = AVCaptureDevice.default(for: .audio), selected.uniqueID != device?.uniqueID {
                        self.stopMic()
                        self.listen()
                    } else {
                        self.updateCaptureStatus(route: route)
                    }
                }
            }
            node.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
                do {
                    let data = try encoder.convert(buffer)
                    DispatchQueue.main.async {
                        guard let self, self.captureID == id, self.phase == .live else { return }
                        guard !data.isEmpty else { return }
                        self.lastFrameTime = ProcessInfo.processInfo.systemUptime
                        let level = data.withUnsafeBytes { bytes -> Double in
                            let samples = bytes.bindMemory(to: Int16.self)
                            guard !samples.isEmpty else { return 0 }
                            return sqrt(samples.reduce(0.0) { $0 + pow(Double($1) / 32768, 2) } / Double(samples.count))
                        }
                        self.inputLevel = level
                        self.levels.removeFirst()
                        self.levels.append(min(1, sqrt(level * 3)))
                        if level > 0.005 { self.lastLoudTime = self.lastFrameTime }
                        self.updateCaptureStatus(route: route)
                        guard self.backendReady else { return }
                        for offset in stride(from: 0, to: data.count, by: 8192) {
                            let chunk = data.subdata(in: offset..<min(offset + 8192, data.count))
                            self.send(["kind":"pcm", "data":chunk.base64EncodedString()])
                        }
                    }
                } catch {
                    Task { @MainActor in if self?.captureID == id { self?.fail(error.localizedDescription) } }
                }
            }
            capture = engine
            try engine.start()
            phase = .live
        } catch { fail(error.localizedDescription) }
    }
    private func updateCaptureStatus(route: String) {
        guard phase == .live else { return }
        let now = ProcessInfo.processInfo.systemUptime
        let status: String
        if lastFrameTime == 0 || now - lastFrameTime > 5 {
            status = "No microphone frames · \(route). Check input device and microphone permission."
        } else if now - lastLoudTime > 3 {
            status = "Microphone quiet · \(route). Check mute and input volume."
        } else {
            status = "Listening · \(route)"
        }
        if lastFrameTime == 0 || now - lastFrameTime > 2 {
            inputLevel = 0
            levels = Array(repeating: 0, count: 32)
        }
        captureStatus = status
        if status != lastStatus {
            lastStatus = status
            send(["kind":"captureStatus", "text":status])
        }
    }
    private func stopMic() {
        captureTimer?.invalidate()
        captureTimer = nil
        inputLevel = 0
        levels = Array(repeating: 0, count: 32)
        captureID = UUID()
        capture?.stop()
        capture?.inputNode.removeTap(onBus: 0)
        capture = nil
        draft = ""
        send(["kind":"captureOff"])
        send(["kind":"captureStatus", "text":"Microphone capture paused or muted"])
    }
    private func stopPlayback() {
        kokoro.silence()
        utterances.removeAll()
        synth.stopSpeaking(at: .immediate)
        playing = ""
    }
    private func silence() {
        generation += 1
        stopPlayback()
        send(["kind":"silence", "epoch":generation])
    }
    private func send(_ message: [String: Any]) {
        guard let input else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: message)
            data.append(10)
            try input.write(contentsOf: data)
        } catch {
            self.input = nil
            fail("Voice worker pipe closed")
        }
    }
    private func fail(_ message: String) { end(); problem = message }
    func end() {
        kokoro.end()
        sessionID = UUID()
        stopMic()
        stopPlayback()
        send(["kind":"end"])
        try? input?.close()
        input = nil
        process = nil
        generation = 0
        phase = .idle
        taskLabel = "Idle"
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didStart utterance: AVSpeechUtterance) {
        Task { @MainActor in
            if utterances.contains(ObjectIdentifier(utterance)) {
                playing = utterance.speechString
                stamp("synthesizer started")
            }
        }
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor in
            if utterances.remove(ObjectIdentifier(utterance)) != nil { playing = "" }
        }
    }
}
