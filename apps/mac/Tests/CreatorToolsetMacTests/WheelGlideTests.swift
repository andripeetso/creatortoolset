import AppKit
import WebKit
import XCTest
@testable import CreatorToolsetMac

final class WheelGlideTests: XCTestCase {
    /// Runs the glide at 120 frames a second until it rests; the points sent per frame.
    private func run(_ glide: inout WheelGlide, frames limit: Int = 600) -> [Int] {
        var sent: [Int] = []
        while !glide.resting, sent.count < limit { sent.append(glide.frame(1.0 / 120).y) }
        return sent
    }

    func testAWheelStepArrivesWholeEasedAndSoon() {
        var glide = WheelGlide()
        glide.add(x: 0, y: -120)
        let sent = run(&glide)
        XCTAssertEqual(sent.reduce(0, +), -120)                       // the page ends where the jump used to
        XCTAssertTrue(sent.allSatisfy { $0 <= 0 })                     // never back and forth
        XCTAssertLessThan(abs(sent[0]), 24)                            // no jump: the first frame is a small part
        XCTAssertGreaterThanOrEqual(abs(sent[0]), abs(sent[sent.count / 2]))   // it eases out
        XCTAssertLessThan(Double(sent.count) / 120, 0.6)               // and is over in about half a second
    }

    func testStepsAddUpWhileItGlidesAndAFractionIsNotLost() {
        var glide = WheelGlide()
        glide.add(x: 0, y: 4.000244140625 * 3)                         // three slow notches, as the system reports them
        var total = (0..<10).reduce(0) { sum, _ in sum + glide.frame(1.0 / 120).y }
        glide.add(x: 0, y: 40)
        total += run(&glide).reduce(0, +)
        XCTAssertEqual(total, 52)
    }

    func testAStepTheOtherWayStartsFromRest() {
        var glide = WheelGlide()
        glide.add(x: 0, y: -400)
        _ = glide.frame(1.0 / 120)
        glide.add(x: 0, y: 40)
        let sent = run(&glide)
        XCTAssertTrue(sent.allSatisfy { $0 >= 0 })
        XCTAssertEqual(sent.reduce(0, +), 40)
    }

    /// A wheel step as the system sends it for a plain mouse: whole lines, not precise.
    private func wheelStep(lines: Int32, in window: NSWindow? = nil) -> NSEvent {
        let cg = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1, wheel1: lines, wheel2: 0, wheel3: 0)!
        if let window {
            // the middle of the window, in the display's coordinates (top-left origin)
            let screen = NSScreen.screens[0].frame
            cg.location = CGPoint(x: window.frame.midX, y: screen.maxY - window.frame.midY)
            cg.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window.windowNumber))
            cg.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(window.windowNumber))
        }
        return NSEvent(cgEvent: cg)!
    }

    func testAFrameIsAPreciseScrollOfThosePoints() {
        let step = wheelStep(lines: -3)
        XCTAssertFalse(step.hasPreciseScrollingDeltas)
        XCTAssertEqual(step.deltaY, -3)
        let frame = WheelGlide.event(from: step.cgEvent, x: 2, y: -17)!
        XCTAssertTrue(frame.hasPreciseScrollingDeltas)
        XCTAssertEqual(frame.scrollingDeltaY, -17)
        XCTAssertEqual(frame.scrollingDeltaX, 2)
        XCTAssertTrue(frame.phase.isEmpty)
        XCTAssertNil(WheelGlide.event(from: nil, x: 0, y: 1))
    }

    /// The whole path in a real web view: one wheel step moves the page by the same distance as before, over several
    /// frames instead of one.
    @MainActor func testAWheelStepGlidesAPageInTheWebView() async throws {
        let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 600, height: 400), styleMask: [.borderless], backing: .buffered, defer: false)
        let web = AppWebView()
        window.contentView = web
        window.alphaValue = 0
        window.ignoresMouseEvents = true
        window.orderFrontRegardless()
        defer { window.close() }
        web.loadHTMLString("<body style='margin:0'><div style='height:6000px'></div>", baseURL: nil)
        func scrollY() async throws -> Int { Int((try await web.evaluateJavaScript("Math.round(scrollY)") as? Double) ?? -1) }
        for _ in 0..<100 where (try? await web.evaluateJavaScript("document.body.scrollHeight") as? Double) ?? 0 < 6000 {
            try await Task.sleep(for: .milliseconds(50))
        }
        // one wheel step, glided frame by frame; the page's place after each frame
        func glideOnce() async throws -> [Int] {
            web.scrollWheel(with: wheelStep(lines: -3, in: window))
            var seen: [Int] = []
            for _ in 0..<90 {
                web.glideFrame(1.0 / 120)
                try await Task.sleep(for: .milliseconds(8))
                seen.append(try await scrollY())
            }
            return seen
        }
        let first = try await glideOnce()
        guard let warm = first.last, warm > 0 else {
            throw XCTSkip("the web view did not take scroll events here (no display to show a window on)")
        }
        // measured on the second step: the first scroll after a page loads can lose its first frame while the page settles
        let seen = try await glideOnce()
        print("wheel glide in the web view: first step \(warm) points, second step \((seen.last ?? 0) - warm) points, frames \(Set(seen).count)")
        XCTAssertEqual((seen.last ?? 0) - warm, 120)                                // three lines, as a jump would have gone
        XCTAssertGreaterThan(Set(seen).count, 8)                                    // in many small moves
        XCTAssertEqual(seen, seen.sorted())                                         // always the same way
    }
}
