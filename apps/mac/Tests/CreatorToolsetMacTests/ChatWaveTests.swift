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

    /// The screen starts falling toward the button at once and goes faster and faster until the wave is let go: no
    /// stretch where nothing happens and then everything at once (owner, 11-13), and no stop before the wave (11-14).
    func testTheScreenFallsInFasterAndFasterUntilTheWaveLeaves() {
        let frame = 1000.0 / 60
        let speed = { (ms: Double) in WaveClock.pull(ms + frame) - WaveClock.pull(ms) }
        XCTAssertGreaterThan(WaveClock.at(2 * frame, size: size, origin: button, scale: 2).pull, 0.005)
        var last: Float = 0
        for ms in stride(from: 0, to: WaveClock.gather, by: frame) {
            XCTAssertGreaterThan(speed(ms), last)
            last = speed(ms)
        }
        let late = WaveClock.at(WaveClock.gather - 1, size: size, origin: button, scale: 2)
        XCTAssertEqual(late.pull, 1, accuracy: 0.01)
        XCTAssertLessThan(late.front, 0)
        XCTAssertFalse(late.done)
        // what the front has not reached yet goes on falling in, at a speed that falls only slowly
        XCTAssertGreaterThan(speed(WaveClock.gather + 300), speed(WaveClock.gather) / 3)
    }

    /// The picture of the new screen came late: the screen is still falling in, never held, and the front leaves when
    /// it comes, not before.
    func testALatePictureHoldsNothing() {
        let release = WaveClock.gather + 300
        let waiting = WaveClock.at(release - 1, release: nil, size: size, origin: button, scale: 2)
        XCTAssertGreaterThan(waiting.pull, WaveClock.at(release - 60, release: nil, size: size, origin: button, scale: 2).pull)
        XCTAssertLessThan(waiting.front, 0)
        XCTAssertGreaterThan(WaveClock.at(release + 100, release: release, size: size, origin: button, scale: 2).front, 0)
    }

    /// One front, out from just behind the button only (out past the bar within three frames), quickest as it
    /// leaves and slowing for the rest of the way; past the far corner by its crest and first ridge when it is done, and
    /// the wave died away and faded out by then.
    func testTheFrontGoesOutOnceAndLeavesTheWindow() {
        let first = WaveClock.at(WaveClock.gather, size: size, origin: button, scale: 2)
        XCTAssertLessThanOrEqual(first.front, -WaveClock.behind * first.width + 1)
        var last = first.front
        var steps: [Float] = []
        for ms in stride(from: WaveClock.gather + 1000.0 / 60, through: WaveClock.gather + WaveClock.sweep - 1, by: 1000.0 / 60) {
            let m = WaveClock.at(ms, size: size, origin: button, scale: 2)
            steps.append(m.front - last)
            last = m.front
        }
        XCTAssertTrue(zip(steps, steps.dropFirst()).allSatisfy { $0 >= $1 && $1 > 0 })
        // no pause after the pull: out past the bar (56 points) within three frames of leaving
        XCTAssertGreaterThan(WaveClock.at(WaveClock.gather + 3 * 1000.0 / 60, size: size, origin: button, scale: 2).front, 56 * 2)
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
