import WebKit
import XCTest
@testable import CreatorToolsetMac

final class ChatWaveTests: XCTestCase {
    private let size = CGSize(width: 2880, height: 1800)
    private let button = CGPoint(x: 56, y: 56)
    private let frame = 1000.0 / 60

    private func at(_ ms: Double, held: Double, release: Double?) -> WaveMoment {
        WaveClock.at(ms, held: held, release: release, size: size, origin: button, scale: 2)
    }

    /// The shader is compiled when the app runs: a mistake in it would leave the switch with no wave at all.
    func testTheShaderCompiles() throws {
        XCTAssertNoThrow(try WaveRenderer())
    }

    func testTheLightAtTheButtonAnswersThePressAtOnce() {
        XCTAssertGreaterThan(at(50, held: 0, release: nil).bloom, 0.45)
    }

    /// A click draws nothing in: the screen is as it was until the wave pops, and stays so where the front has not been.
    func testAClickOnlyPops() {
        let click = 100.0, release = 180.0
        for ms in stride(from: 0, through: release + 400, by: frame) {
            XCTAssertEqual(at(ms, held: click, release: release).pull, 0)
        }
        XCTAssertGreaterThan(at(release + 3 * frame, held: click, release: release).front, 56 * 2)
        // a slow click, a little past `holdFrom`, draws in next to nothing, even while its picture is late
        let slow = WaveClock.holdFrom + 40
        XCTAssertLessThan(at(slow + 200, held: slow, release: nil).pull, 0.25)
        // and a short hold goes on at the speed it had as the mouse comes up: no stop before the wave
        let short = 230.0
        let speed = { (ms: Double) in WaveClock.pull(ms + self.frame, held: short) - WaveClock.pull(ms, held: short) }
        XCTAssertGreaterThan(speed(short), speed(short - frame) * 0.7)
    }

    /// Held, the screen is on its way within a few frames and well in after a tenth of a second (owner, 11-14: "stronger
    /// right off the bat"), and goes on falling in, never resting, until it pops by itself.
    func testHeldTheScreenFallsInAtOnceAndNeverRests() {
        let held = WaveClock.longest
        XCTAssertGreaterThan(WaveClock.pull(WaveClock.holdFrom + 2 * frame, held: held), 0.005)
        XCTAssertGreaterThan(WaveClock.pull(WaveClock.holdFrom + 100, held: held), 0.3)
        let speed = { (ms: Double) in WaveClock.pull(ms + self.frame, held: held) - WaveClock.pull(ms, held: held) }
        let least = stride(from: WaveClock.holdFrom + 100, to: held, by: frame).map(speed).min()!
        XCTAssertGreaterThan(least, 0.02)
        XCTAssertGreaterThan(WaveClock.pull(held, held: held), 2)
        XCTAssertLessThan(at(held - 1, held: held, release: held).front, 0)
    }

    /// Let go, what the front has not reached yet goes on falling in at a speed that falls only slowly (no stop before
    /// the wave, 11-14), and the front is out past the bar within three frames.
    func testLetGoNothingStopsBeforeTheWave() {
        let held = 600.0
        let speed = { (ms: Double) in WaveClock.pull(ms + self.frame, held: held) - WaveClock.pull(ms, held: held) }
        XCTAssertGreaterThan(speed(held), speed(held - frame) * 0.9)
        XCTAssertGreaterThan(speed(held + 300), speed(held) / 3)
        XCTAssertGreaterThan(at(held + 3 * frame, held: held, release: held).front, 56 * 2)
    }

    /// The longer the button was held, the harder it pops; a click still pops.
    func testTheLongerItIsHeldTheHarderItPops() {
        let pops = [100.0, 300, 700, WaveClock.longest].map { held in at(held + 100, held: held, release: held) }
        XCTAssertTrue(zip(pops, pops.dropFirst()).allSatisfy { $0.wave < $1.wave && $0.flash <= $1.flash })
        XCTAssertGreaterThan(pops[0].wave, 0.4 * pops[3].wave)
    }

    /// However long the button was held, no point of the screen moves more than about 40 points in a frame as it is let
    /// go (the shader's own maths, along 45° from the button): the pop is quick, never a jump (owner, 11-13: "then
    /// suddenly over").
    func testThePopIsNeverAJump() {
        func height(_ x: Float) -> Float { exp(-1.6 * x * x) - 0.24 * exp(-1.4 * (x + 1.6) * (x + 1.6)) + 0.09 * exp(-1.4 * (x + 3.1) * (x + 3.1)) }
        func smooth(_ a: Float, _ b: Float, _ v: Float) -> Float { let t = min(max((v - a) / (b - a), 0), 1); return t * t * (3 - 2 * t) }
        func point(_ m: WaveMoment, _ r: Float) -> CGPoint {
            let x = (r - m.front) / m.width, letgo = smooth(-m.back, 1.5, x)
            let rs = max(r + 0.7 * m.pull * r * exp(-r / m.reach) * letgo - m.wave * height(x), 0)
            let a = Float.pi / 4 + m.swirl * m.pull * exp(-r / (0.6 * m.reach)) * letgo
            return CGPoint(x: CGFloat(cos(a) * rs / 2), y: CGFloat(sin(a) * rs / 2))
        }
        for held in [100.0, 440, 800, WaveClock.longest] {
            var last: [CGPoint]?
            for ms in stride(from: held - 200, to: held + WaveClock.sweep, by: frame) {
                let m = at(ms, held: held, release: held)
                let now = stride(from: Float(150), through: 1700, by: 10).map { point(m, $0) }
                if let last { XCTAssertLessThan(zip(last, now).map { hypot($0.x - $1.x, $0.y - $1.y) }.max()!, 42) }
                last = now
            }
        }
    }

    /// The picture of the new screen came late: the screen is still falling in, never held, and the front leaves when
    /// it comes, not before.
    func testALatePictureHoldsNothing() {
        let held = 600.0, release = held + 300
        let waiting = at(release - 1, held: held, release: nil)
        XCTAssertGreaterThan(waiting.pull, at(release - 60, held: held, release: nil).pull)
        XCTAssertLessThan(waiting.front, 0)
        XCTAssertGreaterThan(at(release + 100, held: held, release: release).front, 0)
    }

    /// One front, out from just behind the button only, quickest as it leaves and slowing for the rest of the way; past
    /// the far corner by its crest and first ridge when it is done, and the wave died away and faded out by then.
    func testTheFrontGoesOutOnceAndLeavesTheWindow() {
        let held = 600.0
        let first = at(held, held: held, release: held)
        XCTAssertLessThanOrEqual(first.front, -WaveClock.behind * first.width + 1)
        var last = first.front
        var steps: [Float] = []
        for ms in stride(from: held + frame, through: held + WaveClock.sweep - 1, by: frame) {
            let m = at(ms, held: held, release: held)
            steps.append(m.front - last)
            last = m.front
        }
        XCTAssertTrue(zip(steps, steps.dropFirst()).allSatisfy { $0 >= $1 && $1 > 0 })
        let end = at(held + WaveClock.sweep, held: held, release: held)
        XCTAssertTrue(end.done)
        let corner = Float(hypot(size.width - button.x, size.height - button.y))
        XCTAssertGreaterThan(end.front - 1.5 * end.width, corner - 1)
        let closing = at(held + WaveClock.sweep - 17, held: held, release: held)
        XCTAssertLessThan(closing.wave, 0.01 * 2 * 26 * 1.5)
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
