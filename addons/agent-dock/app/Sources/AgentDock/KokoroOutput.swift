import AVFoundation
import Foundation

/// Session-owned offline renderer. Only one clause is in flight at a time.
@MainActor
final class KokoroOutput: NSObject, AVAudioPlayerDelegate {
    static var interpreter: URL? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return ["Library/Application Support/AgentDockVoice/kokoro/bin/python",
                ".local/share/uv/tools/mlx-audio/bin/python"].map { home.appendingPathComponent($0) }
            .first { FileManager.default.isExecutableFile(atPath: $0.path) }
    }

    private var process: Process?
    private var input: FileHandle?
    private var player: AVAudioPlayer?
    private var queue: [String] = []
    private var epoch = 0
    private var busy = false
    var report: ((String) -> Void)?
    var speaking: ((String) -> Void)?

    func start(script: URL) throws {
        guard let python = Self.interpreter else { throw DockCLI.Failed(message: "Install the MLX Audio runtime first.") }
        let child = Process(), output = Pipe(), stdin = Pipe()
        child.executableURL = python
        child.arguments = [script.path]
        child.standardInput = stdin
        child.standardOutput = output
        try child.run()
        process = child
        input = stdin.fileHandleForWriting
        Task {
            do {
                for try await line in output.fileHandleForReading.bytes.lines {
                    guard process === child else { break }
                    let result = try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
                    if let error = result?["error"] as? String { throw DockCLI.Failed(message: error) }
                    guard result?["epoch"] as? Int == epoch else { busy = false; advance(); continue }
                    guard let wav = result?["wav"] as? String, let data = Data(base64Encoded: wav) else {
                        throw DockCLI.Failed(message: "Invalid Kokoro audio")
                    }
                    let audio = try AVAudioPlayer(data: data)
                    player = audio
                    audio.delegate = self
                    guard audio.play() else { throw DockCLI.Failed(message: "Kokoro playback failed") }
                    speaking?(result?["text"] as? String ?? "")
                }
                if process === child { report?("Kokoro worker exited") }
            } catch { if process === child { report?(error.localizedDescription) } }
        }
    }

    func speak(_ text: String) { queue.append(text); advance() }
    private func advance() {
        guard !busy, !queue.isEmpty, let input else { return }
        do {
            var data = try JSONSerialization.data(withJSONObject: ["text":queue.removeFirst(), "epoch":epoch])
            data.append(10)
            busy = true
            try input.write(contentsOf: data)
        } catch { report?(error.localizedDescription) }
    }
    func silence() {
        epoch += 1
        queue.removeAll()
        if let player { player.stop(); self.player = nil; busy = false }
    }
    func end() {
        silence()
        try? input?.close()
        if let process, process.isRunning { process.terminate() }
        input = nil; process = nil; busy = false
    }
    nonisolated func audioPlayerDidFinishPlaying(_ audio: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            guard player === audio else { return }
            player = nil
            busy = false
            speaking?("")
            advance()
        }
    }
}
