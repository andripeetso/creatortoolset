import XCTest
@testable import CreatorToolsetMac

/// The chat-mode wave's sound (WaveSound.swift), made as the wave makes it: a click is silent, a hold builds, the pop is
/// louder than the hold and never clips, and it is gone within half a second: a bubble's bop, never a boom.
final class WaveSynthTests: XCTestCase {
    private func play(held: Double, seconds: Double) -> [Float] {
        var synth = WaveSynth(rate: 48000)
        var out: [Float] = []
        let size = CGSize(width: 2880, height: 1800), o = CGPoint(x: 56, y: 56)
        var popped = false
        for frame in 0 ..< Int(seconds * 120) {
            let ms = Double(frame) / 120 * 1000
            let m = WaveClock.at(ms, held: held, release: max(held, 270), size: size, origin: o, scale: 2)
            if m.front < -1e5 {
                synth.held = m.pull
                synth.wild = m.wild
            } else if !popped {
                popped = true
                synth.held = 0
                synth.pop(drawnIn: WaveClock.pull(held, held: held), wild: WaveClock.wild(held))
            }
            for _ in 0 ..< 400 { out.append(synth.next()) }
        }
        return out
    }

    private func loudness(_ s: [Float], from: Double, to: Double) -> Float {
        let part = s[Int(from * 48000) ..< Int(to * 48000)]
        return sqrt(part.map { $0 * $0 }.reduce(0, +) / Float(part.count))
    }

    func testAClickIsSilent() {
        XCTAssertEqual(play(held: 90, seconds: 2).map(abs).max(), 0)
    }

    func testAHoldBuildsThenPopsLouderAndDiesAway() {
        let s = play(held: WaveClock.longest, seconds: 5)
        XCTAssertFalse(s.contains { $0.isNaN })
        let early = loudness(s, from: 0.3, to: 0.5), late = loudness(s, from: 1.7, to: 1.95), pop = loudness(s, from: 2.0, to: 2.2)
        XCTAssertGreaterThan(late, early * 3)
        XCTAssertGreaterThan(pop, late * 1.5)
        XCTAssertLessThan(s.map(abs).max()!, 0.9)
        XCTAssertLessThan(loudness(s, from: 2.5, to: 3), 0.003)
        // smooth: no sample jumps far from the one before (noise, a click)
        XCTAssertLessThan(zip(s, s.dropFirst()).map { abs($0 - $1) }.max()!, 0.08)
    }
}
