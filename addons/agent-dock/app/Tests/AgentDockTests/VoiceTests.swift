import AVFoundation
import XCTest
@testable import AgentDock

final class VoiceTests: XCTestCase {
    func testScopedCommands() {
        XCTAssertEqual(VoiceCommand.allCases.compactMap(\.key), ["v", "m", "s"])
        XCTAssertEqual(VoiceCommand.modifiers, [.control, .option, .command])
        XCTAssertEqual(VoiceCommand.toggle.title(.idle), "Start Voice")
        XCTAssertEqual(VoiceCommand.toggle.title(.live), "Pause Voice")
        XCTAssertEqual(VoiceCommand.toggle.title(.paused), "Resume Voice")
        XCTAssertFalse(VoiceCommand.mute.enabled(.paused))
        XCTAssertFalse(VoiceCommand.stop.enabled(.idle))
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
