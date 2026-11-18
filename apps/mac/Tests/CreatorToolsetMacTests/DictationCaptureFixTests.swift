import AVFoundation
import XCTest
@testable import CreatorToolsetMac

final class DictationCaptureFixTests: XCTestCase {
    /// 10 ms of a 440 Hz sine at 48 kHz, stereo, with `left`/`right` amplitudes.
    private func stereo(left: Float, right: Float, frames: Int = 480, offset: Int = 0) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48_000, channels: 2, interleaved: false)!
        let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames))!
        pcm.frameLength = AVAudioFrameCount(frames)
        for i in 0..<frames {
            let s = sin(2 * Float.pi * 440 * Float(i + offset) / 48_000)
            pcm.floatChannelData![0][i] = left * s
            pcm.floatChannelData![1][i] = right * s
        }
        return pcm
    }

    /// Converts 1 s of 10 ms buffers and returns the 16 kHz mono result.
    private func convert(left: Float, right: Float) -> [Float] {
        let cache = ConverterCache(targetFormat: AudioCapture.targetFormat)
        var out: [Float] = []
        for b in 0..<100 {
            XCTAssertTrue(cache.convert(stereo(left: left, right: right, offset: b * 480)) { out.append(contentsOf: $0) })
        }
        return out
    }

    func testAMicOnTheSecondInputIsNotSilent() {
        let rms = computeRMS(convert(left: 0, right: 0.5))
        XCTAssertGreaterThan(rms, 0.1, "the second channel is mixed in, not dropped")
    }

    func testTheSameSignalOnBothChannelsKeepsItsLevel() {
        let rms = computeRMS(convert(left: 0.5, right: 0.5))
        // a 0.5 sine has RMS ≈ 0.354; the mix must neither halve nor clip it
        XCTAssertEqual(rms, 0.354, accuracy: 0.01)
    }

    func testTheLevelIsReportedAboutEvery33Milliseconds() {
        let buffer = CaptureBuffer()
        buffer.reset(startedAt: 0)
        var levels: [Float] = []
        let handler = AudioCapture.inputHandler(
            buffer: buffer, converters: ConverterCache(targetFormat: AudioCapture.targetFormat)
        ) { levels.append($0) }
        for b in 0..<100 { handler(stereo(left: 0.5, right: 0.5, offset: b * 480), 0, 0) }
        // reports land on whole converter chunks, so every 33-40 ms
        XCTAssertTrue((22...31).contains(levels.count), "\(levels.count) reports for 1 s, not one per 10 ms buffer")
        XCTAssertEqual(levels.last ?? 0, 0.354, accuracy: 0.06)
        XCTAssertEqual(try buffer.finish().count, 16_000, accuracy: 200)
    }

    func testARepeatingKeyNeverStartsAPressWhenAModifierIsTapped() {
        let set = KeycodeSet()
        set.set([keyCombo(49, carbonModifiers(.maskAlternate))])
        // Space held alone types spaces; tapping ⌥ while it repeats must not capture it
        XCTAssertFalse(set.press(49, modifiers: 0))
        XCTAssertFalse(set.press(49, modifiers: carbonModifiers(.maskAlternate), autorepeat: true))
        XCTAssertFalse(set.release(49), "the other app gets Space's key-up")

        // ⌥Space pressed: its repeats stay swallowed, even after ⌥ is let go
        XCTAssertTrue(set.press(49, modifiers: carbonModifiers(.maskAlternate)))
        XCTAssertTrue(set.press(49, modifiers: 0, autorepeat: true))
        XCTAssertTrue(set.release(49))
    }
}
