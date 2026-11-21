import AVFoundation
import XCTest
@testable import AgentDock

final class VoiceTests: XCTestCase {
    func testScopedCommands() {
        XCTAssertEqual(VoiceCommand.allCases.compactMap(\.key), ["v", "m", "s"])
        XCTAssertEqual(VoiceCommand.modifiers, [.control, .option, .command])
        XCTAssertEqual(VoiceCommand.toggle.title(.idle), "Pause / Resume Voice")
        XCTAssertEqual(VoiceCommand.toggle.title(.live), "Pause Voice")
        XCTAssertEqual(VoiceCommand.toggle.title(.paused), "Resume Voice")
        XCTAssertFalse(VoiceCommand.mute.enabled(.paused))
        XCTAssertFalse(VoiceCommand.stop.enabled(.idle))
    }

    @MainActor func testPauseRestoresMutedCaptureAndKeepsTask() {
        let controller = VoiceController()
        controller.phase = .live
        controller.taskLabel = "Running tests"
        controller.perform(.mute, vault: "")
        XCTAssertEqual(controller.phase, .muted)
        controller.perform(.toggle, vault: "")
        XCTAssertEqual(controller.phase, .paused)
        controller.perform(.toggle, vault: "")
        XCTAssertEqual(controller.phase, .muted)
        controller.perform(.silence, vault: "")
        XCTAssertEqual(controller.taskLabel, "Running tests")
        controller.perform(.end, vault: "")
        XCTAssertEqual(controller.phase, .idle)
    }

    func testReplayAllFixtureAudioThroughCaptureEncoder() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<4 { root.deleteLastPathComponent() }
        let bench = root.appendingPathComponent("voice/bench")
        let wavs = try FileManager.default.contentsOfDirectory(at: bench, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "wav" }
        XCTAssertEqual(wavs.count, 12)
        for wav in wavs {
            let file = try AVAudioFile(forReading: wav)
            let encoder = try PCMEncoder(file.processingFormat)
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 2048))
            var byteCount = 0
            while file.framePosition < file.length {
                try file.read(into: buffer)
                byteCount += try encoder.convert(buffer).count
            }
            XCTAssertEqual(byteCount, Int(file.length) * 2, wav.lastPathComponent)
        }
    }

    func testMicrophoneConverterWithSyntheticStereo() throws {
        let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
        let input = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
        input.frameLength = 4800
        for ch in 0..<2 {
            for i in 0..<4800 { input.floatChannelData![ch][i] = Float(sin(Double(i) * 0.1)) * 0.3 }
        }
        let converter = try PCMEncoder(format)
        let data = try converter.convert(input)
        XCTAssertGreaterThan(data.count, 0)
        XCTAssertLessThanOrEqual(data.count, 3200) // The resampler primes on its first buffer.
        XCTAssertEqual(try converter.convert(input).count, 3200)
        XCTAssertTrue(data.contains { $0 != 0 })
    }
}
