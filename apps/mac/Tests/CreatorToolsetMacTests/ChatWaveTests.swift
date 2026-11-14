import WebKit
import XCTest
@testable import CreatorToolsetMac

final class ChatWaveTests: XCTestCase {
    private let size = CGSize(width: 2880, height: 1800)
    private let button = CGPoint(x: 56, y: 56)

    /// The shader is compiled when the app runs: a mistake in it would leave the switch with no wave at all.
    func testTheShaderCompiles() throws {
        XCTAssertNoThrow(try WaveRenderer())
    }

    func testTheLightAtTheButtonAnswersThePressAtOnce() {
        XCTAssertGreaterThan(WaveClock.at(50, size: size, origin: button, scale: 2).bloom, 0.45)
    }

    /// The screen starts falling toward the button at once and eases into its fullest before the wave is let go: no
    /// stretch where nothing happens and then everything at once (owner, 11-13).
    func testTheScreenFallsInSmoothlyBeforeTheWaveLeaves() {
        let first = WaveClock.at(WaveClock.gather / 10, size: size, origin: button, scale: 2)
        let half = WaveClock.at(WaveClock.gather / 2, size: size, origin: button, scale: 2)
        let late = WaveClock.at(WaveClock.gather - 1, size: size, origin: button, scale: 2)
        XCTAssertGreaterThan(first.pull, 0.02)
        XCTAssertEqual(half.pull, 0.5, accuracy: 0.05)
        XCTAssertGreaterThan(late.pull, 0.99)
        XCTAssertLessThan(late.front, 0)
        XCTAssertFalse(late.done)
    }

    /// One front, out from the button only, easing in, then slowing for the rest of the way; past the far corner by its
    /// crest and first ridge when it is done, and the wave died away and faded out by then.
    func testTheFrontGoesOutOnceAndLeavesTheWindow() {
        var last: Float = 0
        var steps: [Float] = []
        for ms in stride(from: WaveClock.gather, through: WaveClock.gather + WaveClock.sweep - 1, by: 1000.0 / 60) {
            let m = WaveClock.at(ms, size: size, origin: button, scale: 2)
            XCTAssertGreaterThanOrEqual(m.front, last)
            steps.append(m.front - last)
            last = m.front
        }
        XCTAssertLessThan(steps[1], steps.max()!)
        XCTAssertGreaterThan(steps.max()!, steps.last! * 3)
        let end = WaveClock.at(WaveClock.gather + WaveClock.sweep, size: size, origin: button, scale: 2)
        XCTAssertTrue(end.done)
        let corner = Float(hypot(size.width - button.x, size.height - button.y))
        XCTAssertGreaterThan(end.front - 1.5 * end.width, corner - 1)
        let closing = WaveClock.at(WaveClock.gather + WaveClock.sweep - 17, size: size, origin: button, scale: 2)
        XCTAssertLessThan(closing.wave, 0.01 * 2 * 26)
        XCTAssertLessThan(closing.left, 0.03)
    }

    @MainActor
    func testThePageGetsAnAnswerWhateverItAsks() {
        let host = ChatWaveHost(WKWebView())
        var answers: [Any?] = []
        host.handle("drawn") { v, _ in answers.append(v) }
        host.handle("stop") { v, _ in answers.append(v) }
        host.handle(["start": ["x": "nowhere"]]) { v, _ in answers.append(v) }
        XCTAssertEqual(answers.count, 3)
        XCTAssertEqual(answers[2] as? Bool, false)
    }
}
