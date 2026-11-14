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

    /// The screen falls toward the button faster and faster before the wave is let go.
    func testTheScreenFallsInBeforeTheWaveLeaves() {
        let early = WaveClock.at(WaveClock.gather / 2, size: size, origin: button, scale: 2)
        let late = WaveClock.at(WaveClock.gather - 1, size: size, origin: button, scale: 2)
        XCTAssertLessThan(late.front, 0)
        XCTAssertLessThan(early.pull, 0.5 * late.pull)
        XCTAssertGreaterThan(late.pull, 0.95)
        XCTAssertFalse(late.done)
    }

    /// One front, out from the button only, fastest as it is let go, past the far corner (with all of its wave and the
    /// most it wavers) when it is done.
    func testTheFrontGoesOutOnceAndLeavesTheWindow() {
        var last: Float = 0
        var steps: [Float] = []
        for ms in stride(from: WaveClock.gather, through: WaveClock.gather + WaveClock.sweep - 1, by: 1000.0 / 60) {
            let m = WaveClock.at(ms, size: size, origin: button, scale: 2)
            XCTAssertGreaterThanOrEqual(m.front, last)
            steps.append(m.front - last)
            last = m.front
        }
        XCTAssertGreaterThan(steps[1], steps.last! * 1.5)
        let end = WaveClock.at(WaveClock.gather + WaveClock.sweep, size: size, origin: button, scale: 2)
        XCTAssertTrue(end.done)
        let corner = Float(hypot(size.width - button.x, size.height - button.y))
        // nothing of the wave is left on the window
        XCTAssertGreaterThan(end.front - (3.2 + 0.28) * end.width, corner - 1)
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
