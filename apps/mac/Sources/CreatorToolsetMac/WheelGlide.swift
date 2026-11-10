// A wheel mouse sends a scroll in whole steps, and the web view moves the page by each step at once, so the page
// jumps. (A trackpad's scroll already arrives as a smooth stream.) Here each step is handed to the page a little per
// frame, easing out, the way apps built on Chromium glide a wheel. A trackpad, a Magic Mouse and a mouse whose own
// driver already smooths send "precise" scrolls: those pass through untouched, as does every scroll while Reduce
// Motion is on (AppWebView.scrollWheel, TitleBar.swift).
import AppKit

/// The arithmetic of the glide, apart from the events (WheelGlideTests).
struct WheelGlide {
    /// What the web view scrolls for one wheel line (WebKit's own step), so a glide ends where the jump used to.
    static let pointsPerLine: CGFloat = 40
    /// About two thirds of what is left goes within this many seconds, nearly all of it within four times that.
    static let ease = 0.065

    /// Points still to hand to the page.
    private(set) var left = CGPoint.zero
    /// The part of a point not sent yet (an event carries whole points).
    private var carry = CGPoint.zero

    var resting: Bool { left == .zero && carry == .zero }

    /// A wheel step. One against the way the page is still gliding starts from rest: it never fights what is left.
    mutating func add(x: CGFloat, y: CGFloat) {
        if x * left.x < 0 { left.x = 0; carry.x = 0 }
        if y * left.y < 0 { left.y = 0; carry.y = 0 }
        left.x += x
        left.y += y
    }

    /// The whole points to send for a frame `dt` seconds long.
    mutating func frame(_ dt: Double) -> (x: Int, y: Int) {
        let share = CGFloat(1 - exp(-max(dt, 0) / Self.ease))
        func take(_ left: inout CGFloat, _ carry: inout CGFloat) -> Int {
            guard left != 0 else {
                // the fraction that remains, so the page ends where the wheel said
                let last = carry.rounded()
                carry = 0
                return Int(last)
            }
            var move = left * share
            // near the end a frame's share stays under a point for a long time: finish in whole points
            if abs(move) < 1 { move = abs(left) < 1 ? left : (left < 0 ? -1 : 1) }
            left -= move
            carry += move
            let whole = carry.rounded(.towardZero)
            carry -= whole
            return Int(whole)
        }
        return (take(&left.x, &carry.x), take(&left.y, &carry.y))
    }

    mutating func stop() {
        left = .zero
        carry = .zero
    }

    /// A precise scroll of whole points made from a wheel step, so it lands at the same place, in the same window and
    /// with the same keys held. Nil when the step has no event behind it.
    static func event(from step: CGEvent?, x: Int, y: Int) -> NSEvent? {
        guard let cg = step?.copy() else { return nil }
        cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        cg.setIntegerValueField(.scrollWheelEventDeltaAxis1, value: 0)
        cg.setIntegerValueField(.scrollWheelEventDeltaAxis2, value: 0)
        cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Double(y) / 10)
        cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Double(x) / 10)
        cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis1, value: Int64(y))
        cg.setIntegerValueField(.scrollWheelEventPointDeltaAxis2, value: Int64(x))
        cg.timestamp = clock_gettime_nsec_np(CLOCK_UPTIME_RAW)
        return NSEvent(cgEvent: cg)
    }
}
