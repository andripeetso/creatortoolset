import AppKit
import XCTest
@testable import CreatorToolsetMac

final class RecorderTests: XCTestCase {
    func testPointerOnTheMainDisplay() {
        // main display 1512×982 points: bottom-left origin in, top-left 0–1 out
        let main = CGRect(x: 0, y: 0, width: 1512, height: 982)
        XCTAssertEqual(normalizedPointer(CGPoint(x: 0, y: 982), display: main, mainHeight: 982).x, 0)
        XCTAssertEqual(normalizedPointer(CGPoint(x: 0, y: 982), display: main, mainHeight: 982).y, 0)
        let corner = normalizedPointer(CGPoint(x: 1512, y: 0), display: main, mainHeight: 982)
        XCTAssertEqual(corner.x, 1)
        XCTAssertEqual(corner.y, 1)
    }

    func testPointerOnASecondDisplayAboveAndRight() {
        // a 3008×1692 display whose top left sits at (1512, -1692) in global top-left coordinates
        let second = CGRect(x: 1512, y: -1692, width: 3008, height: 1692)
        let middle = normalizedPointer(CGPoint(x: 1512 + 1504, y: 982 + 846), display: second, mainHeight: 982)
        XCTAssertEqual(middle.x, 0.5)
        XCTAssertEqual(middle.y, 0.5)
        // still on the main display: outside 0–1, Review hides it
        XCTAssertLessThan(normalizedPointer(CGPoint(x: 10, y: 10), display: second, mainHeight: 982).x, 0)
    }

    func testCaptureSizeCapsAt4K() {
        XCTAssertTrue(captureSize(points: CGSize(width: 3008, height: 1692), scale: 2) == (3840, 2160))
        XCTAssertTrue(captureSize(points: CGSize(width: 1512, height: 982), scale: 2) == (3024, 1964))
        XCTAssertTrue(captureSize(points: CGSize(width: 1921, height: 1081), scale: 1) == (1920, 1080))   // even
        let tall = captureSize(points: CGSize(width: 1504, height: 1565), scale: 2)   // a tall window: 4K's pixels at most
        XCTAssertTrue(tall.width * tall.height <= 3840 * 2160 && tall.width > 2800, "\(tall)")
    }

    // Placement, in AppKit's global points (y grows upwards). A 3008×1692 screen above and right of a 1512×982 main
    // display, so its origin is not zero: the menu bar is off the top and a 70 pt Dock off the bottom.
    private let visible = CGRect(x: 1512, y: 982 + 70, width: 3008, height: 1692 - 70 - 25)
    private let bar = CGSize(width: 250, height: 44)

    func testBarSitsUnderTheRecordedWindow() {
        let window = CGRect(x: 2400, y: 1600, width: 1157, height: 563)
        XCTAssertEqual(barOrigin(recorded: window, visible: visible, size: bar), CGPoint(x: 2400 + 578.5 - 125, y: 1600 - 10 - 44))
    }

    func testBarGoesAboveWhenThereIsNoRoomBelow() {
        let window = CGRect(x: 2400, y: visible.minY + 20, width: 1157, height: 563)   // 20 pt over the Dock
        XCTAssertEqual(barOrigin(recorded: window, visible: visible, size: bar).y, window.maxY + 10)
    }

    func testBarGoesInsideAWindowAsTallAsTheScreen() {
        let window = CGRect(x: 2400, y: visible.minY, width: 1157, height: visible.height)
        XCTAssertEqual(barOrigin(recorded: window, visible: visible, size: bar).y, window.minY + 16)
    }

    func testBarStaysOnTheScreen() {
        // a window hanging off the left and bottom edges: the bar is pulled fully inside
        let off = barOrigin(recorded: CGRect(x: 1300, y: 900, width: 300, height: 400), visible: visible, size: bar)
        XCTAssertEqual(off.x, visible.minX)
        XCTAssertTrue(visible.contains(CGRect(origin: off, size: bar)))
        let right = barOrigin(recorded: CGRect(x: 4400, y: 1600, width: 300, height: 400), visible: visible, size: bar)
        XCTAssertEqual(right.x, visible.maxX - 250)
    }

    func testBarKeepsTheTopCentreForAWholeDisplay() {
        XCTAssertEqual(barOrigin(recorded: nil, visible: visible, size: bar), CGPoint(x: visible.midX - 125, y: visible.maxY - 44 - 12))
    }

    func testPreviewOpensAtTheRecordedCorner() {
        let size = CGSize(width: 340, height: 210)
        let window = CGRect(x: 2400, y: 1600, width: 1157, height: 563)
        XCTAssertEqual(previewOrigin(recorded: window, visible: visible, size: size), CGPoint(x: window.maxX - 340 - 16, y: 1616))
        // a whole display: the screen's bottom right, as before
        XCTAssertEqual(previewOrigin(recorded: nil, visible: visible, size: size), CGPoint(x: visible.maxX - 356, y: visible.minY + 16))
        // a window off the right and bottom edges: still fully on the screen
        let off = previewOrigin(recorded: CGRect(x: 4300, y: 900, width: 600, height: 400), visible: visible, size: size)
        XCTAssertEqual(off, CGPoint(x: visible.maxX - 340, y: visible.minY))
    }

    @MainActor
    func testAPressOnTheAppsOwnFloatingWindowIsNotAClick() {
        let bar = NSWindow(), main = NSWindow()
        XCTAssertTrue(logsClick(.leftMouseDown, on: nil, own: [bar]))          // another app's window
        XCTAssertTrue(logsClick(.rightMouseDown, on: main, own: [bar]))        // the app's main window can be what is recorded
        XCTAssertFalse(logsClick(.leftMouseDown, on: bar, own: [bar]))         // Stop on the bar
        XCTAssertFalse(logsClick(.mouseMoved, on: nil, own: [bar]))
        XCTAssertFalse(logsClick(.leftMouseDragged, on: main, own: []))
        // a release is logged by the same rule, and never as a click
        XCTAssertTrue(logsRelease(.leftMouseUp, on: nil, own: [bar]))
        XCTAssertTrue(logsRelease(.rightMouseUp, on: main, own: [bar]))
        XCTAssertFalse(logsRelease(.leftMouseUp, on: bar, own: [bar]))
        XCTAssertFalse(logsRelease(.leftMouseDown, on: nil, own: [bar]))
        XCTAssertFalse(logsClick(.leftMouseUp, on: nil, own: [bar]))
    }

    func testClockText() {
        XCTAssertEqual(clockText(42.9), "0:42")
        XCTAssertEqual(clockText(3725), "1:02:05")
    }
}
