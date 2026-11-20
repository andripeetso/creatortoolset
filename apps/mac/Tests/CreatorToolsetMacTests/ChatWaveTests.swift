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
    func testThePictureComingAfterThePageDoesNotSendTheWaveOutAgain() {
        XCTAssertEqual(WaveClock.leaves(drawn: 55, picture: nil), 55)
        XCTAssertEqual(WaveClock.leaves(drawn: 55, picture: 275), 55)
        XCTAssertEqual(WaveClock.leaves(drawn: nil, picture: 275), 275)
        XCTAssertNil(WaveClock.leaves(drawn: nil, picture: nil))
    }

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
        // a 0.3 s hold whose new screen's picture is half a second late is still falling in when it comes
        let third = { (ms: Double) in WaveClock.pull(ms + self.frame, held: 300) - WaveClock.pull(ms, held: 300) }
        XCTAssertGreaterThan(third(300 + 400), third(300) / 4)
    }

    /// Held, the screen is on its way within a few frames and well in after a tenth of a second (owner, 11-14: "stronger
    /// right off the bat"), and goes on falling in, never resting, until it pops by itself; past `wildFrom` it goes wild.
    func testHeldTheScreenFallsInAtOnceAndNeverRests() {
        let held = WaveClock.longest
        XCTAssertGreaterThan(WaveClock.pull(WaveClock.holdFrom + 2 * frame, held: held), 0.005)
        XCTAssertGreaterThan(WaveClock.pull(WaveClock.holdFrom + 100, held: held), 0.3)
        let speed = { (ms: Double) in WaveClock.pull(ms + self.frame, held: held) - WaveClock.pull(ms, held: held) }
        let least = stride(from: WaveClock.holdFrom + 100, to: held, by: frame).map(speed).min()!
        XCTAssertGreaterThan(least, 0.02)
        XCTAssertGreaterThan(WaveClock.pull(held, held: held), 3)
        XCTAssertEqual(WaveClock.wild(WaveClock.wildFrom), 0)
        XCTAssertEqual(WaveClock.wild(held), 1)
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
        XCTAssertGreaterThan(pops[0].wave, 0.3 * pops[3].wave)
        // and the longest hold explodes: deeper ridges, more split colour, a longer wave
        XCTAssertEqual(pops[3].wild, 1)
        XCTAssertEqual(pops[1].wild, 0)
        XCTAssertGreaterThan(WaveClock.sweep(held: WaveClock.longest), WaveClock.sweep(held: 700) + 300)
    }

    /// The most any point of the screen moves in one frame around the pop, for a hold of `held` ms (points; the
    /// shader's own maths, along 45° from the button, its tremor and churn too).
    private func fastest(held: Double) -> CGFloat {
        func height(_ x: Float, _ w: Float) -> Float {
            exp(-1.6 * x * x) - 0.24 * (1 + 0.9 * w) * exp(-1.4 * (x + 1.6) * (x + 1.6)) + 0.09 * (1 + 1.4 * w) * exp(-1.4 * (x + 3.1) * (x + 3.1))
        }
        func smooth(_ a: Float, _ b: Float, _ v: Float) -> Float { let t = min(max((v - a) / (b - a), 0), 1); return t * t * (3 - 2 * t) }
        func point(_ m: WaveMoment, _ r: Float) -> CGPoint {
            let x = (r - m.front) / m.width, letgo = smooth(-m.back, 1.5, x), ang = Float.pi / 4
            let tremor = m.wild * m.wild * 3 * m.px * sin(m.seconds * 47 + ang * 3)
            let sucked = max(0.7 * m.pull * r + tremor, 0) * exp(-r / m.reach) * letgo
            let churn = m.wild * (0.3 + 0.12 * sin(r / (90 * m.px) + m.seconds * 10))
            let rs = max(r + sucked - m.wave * height(x, m.wild), 0)
            let a = ang + (m.swirl + churn) * m.pull * exp(-r / (0.6 * m.reach)) * letgo
            return CGPoint(x: CGFloat(cos(a) * rs / 2), y: CGFloat(sin(a) * rs / 2))
        }
        var worst: CGFloat = 0, last: [CGPoint]?
        for ms in stride(from: held - 200, to: held + WaveClock.sweep(held: held), by: frame) {
            let m = at(ms, held: held, release: held)
            let now = stride(from: Float(150), through: 1700, by: 10).map { point(m, $0) }
            if let last { worst = max(worst, zip(last, now).map { hypot($0.x - $1.x, $0.y - $1.y) }.max()!) }
            last = now
        }
        return worst
    }

    /// No point of the screen jumps as it is let go (owner, 11-13: "then suddenly over"): however long the button was
    /// held (the longest hold's explosion too), no point moves more than about 40 points in a frame.
    func testThePopIsNeverAJump() {
        for held in [100.0, 440, 800, 1100, 1500, WaveClock.longest] { XCTAssertLessThan(fastest(held: held), 45, "held \(held) ms") }
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
        for ms in stride(from: held + frame, through: held + WaveClock.sweep(held: held) - 1, by: frame) {
            let m = at(ms, held: held, release: held)
            steps.append(m.front - last)
            last = m.front
        }
        XCTAssertTrue(zip(steps, steps.dropFirst()).allSatisfy { $0 >= $1 && $1 > 0 })
        let end = at(held + WaveClock.sweep(held: held), held: held, release: held)
        XCTAssertTrue(end.done)
        let corner = Float(hypot(size.width - button.x, size.height - button.y))
        XCTAssertGreaterThan(end.front - 1.5 * end.width, corner - 1)
        let closing = at(held + WaveClock.sweep(held: held) - 17, held: held, release: held)
        XCTAssertLessThan(closing.wave, 0.01 * 2 * 26 * 1.5)
        XCTAssertLessThan(closing.left, 0.03)
    }

    @MainActor
    func testThePageGetsAnAnswerWhateverItAsks() {
        let host = ChatWaveHost(WKWebView())
        var answers: [Any?] = []
        host.handle("drawn") { v, _ in answers.append(v) }
        host.handle("stop") { v, _ in answers.append(v) }
        host.handle("ready") { v, _ in answers.append(v) }
        host.handle(["start": ["x": "nowhere"]]) { v, _ in answers.append(v) }
        XCTAssertEqual(answers.count, 4)
        XCTAssertEqual(answers[3] as? Bool, false)
    }

    /// A page in a window that is never put on screen: a picture can be taken of it, so a press makes a wave.
    @MainActor
    private func page() async throws -> (view: WKWebView, window: NSWindow) {
        let view = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 240))
        let window = NSWindow(contentRect: view.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        view.loadHTMLString("<body style='background:#345'>page</body>", baseURL: nil)
        for _ in 0 ..< 100 where view.isLoading { try await Task.sleep(for: .milliseconds(50)) }
        return (view, window)
    }

    /// Two presses, the second before the first one's picture of the screen has come: both pictures made a wave, the
    /// first to end answered for both, and "stop" reached only one of them.
    @MainActor
    func testAPressWhileTheLastOnesPictureIsTakenMakesNoSecondWave() async throws {
        let page = try await page()
        let host = ChatWaveHost(page.view)
        var up: [Bool] = []
        let answered = expectation(description: "both presses answered")
        answered.expectedFulfillmentCount = 2
        for _ in 0 ..< 2 {
            host.handle(["start": ["x": 20.0, "y": 20.0, "hold": false]]) { v, _ in
                up.append(v as? Bool ?? false)
                answered.fulfill()
            }
        }
        await fulfillment(of: [answered], timeout: 10)
        guard up.contains(true) else { throw XCTSkip("no picture of a page can be taken here") }
        let waves = { page.view.subviews.filter { $0 is ChatWaveView }.count }
        XCTAssertEqual(up, [false, true], "the first press's page changes with no wave")
        XCTAssertEqual(waves(), 1)
        host.handle("stop") { _, _ in }
        XCTAssertEqual(waves(), 0, "stop ends the wave that is up")
    }

    /// "stop" while the press's picture of the screen is still being taken: there was no wave to end, so the stop was
    /// forgotten, and the wave then started over a page that had moved on and would never say "drawn".
    @MainActor
    func testAStopBeforeTheWaveIsUpEndsThePress() async throws {
        let page = try await page()
        // (its sound plays nothing: the test only asks whether it is on)
        let host = ChatWaveHost(page.view, sound: WaveSound(plays: false))
        let waves = { page.view.subviews.filter { $0 is ChatWaveView }.count }
        func press(hold: Bool, then: () -> Void = {}) async -> Bool {
            var up = false
            let answered = expectation(description: "the press answered")
            host.handle(["start": ["x": 20.0, "y": 20.0, "hold": hold]]) { v, _ in
                up = v as? Bool ?? false
                answered.fulfill()
            }
            then()
            await fulfillment(of: [answered], timeout: 10)
            return up
        }
        // a press by itself makes a wave here: the one below would make one too, were its stop forgotten
        guard await press(hold: false) else { throw XCTSkip("no picture of a page can be taken here") }
        host.handle("stop") { _, _ in }
        XCTAssertEqual(waves(), 0)

        var stopped: Bool?
        let up = await press(hold: true) {
            XCTAssertTrue(host.sound.isOn, "a held press has its sound from the start")
            host.handle("stop") { v, _ in stopped = v as? Bool }
            XCTAssertEqual(stopped, true, "the stop is answered at once, as before")
            XCTAssertFalse(host.sound.isOn, "the press's sound ends with it")
        }
        XCTAssertFalse(up, "the press's picture came after its stop: the page changes with no wave")
        XCTAssertEqual(waves(), 0)

        // the next press is a press like any other
        guard await press(hold: false) else { return XCTFail("a press after a stopped one makes its wave") }
        XCTAssertEqual(waves(), 1)
        host.handle("stop") { _, _ in }
        XCTAssertEqual(waves(), 0)
    }

    /// "drawn" asked twice while one wave is up: the first answer was dropped for the second.
    @MainActor
    func testEveryDrawnIsAnsweredWhenTheWaveIsOver() async throws {
        let page = try await page()
        let host = ChatWaveHost(page.view)
        var up = false
        let started = expectation(description: "the press answered")
        host.handle(["start": ["x": 20.0, "y": 20.0, "hold": false]]) { v, _ in
            up = v as? Bool ?? false
            started.fulfill()
        }
        await fulfillment(of: [started], timeout: 10)
        guard up else { throw XCTSkip("no picture of a page can be taken here") }
        var answers = 0
        host.handle("drawn") { _, _ in answers += 1 }
        host.handle("drawn") { _, _ in answers += 1 }
        XCTAssertEqual(answers, 0, "not before the wave is over")
        host.handle("stop") { _, _ in }
        XCTAssertEqual(answers, 2)
    }
}
