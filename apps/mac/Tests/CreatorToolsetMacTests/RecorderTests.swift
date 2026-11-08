import CoreGraphics
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
    }
}
