import CoreGraphics
import XCTest
@testable import CreatorToolsetMac

final class SourcePickerTests: XCTestCase {
    func testScreenFramesConvertToTopLeftGlobal() {
        // main 1512×982 at the origin, and a 3008×1692 screen stacked above it (AppKit: bottom-left origin)
        XCTAssertEqual(PickerGeometry.topLeftFrame(CGRect(x: 0, y: 0, width: 1512, height: 982), mainHeight: 982),
                       CGRect(x: 0, y: 0, width: 1512, height: 982))
        XCTAssertEqual(PickerGeometry.topLeftFrame(CGRect(x: 1512, y: 982, width: 3008, height: 1692), mainHeight: 982),
                       CGRect(x: 1512, y: -1692, width: 3008, height: 1692))
    }

    func testWindowFrameMapsIntoScreenViewCoordinates() {
        // screen top-left (1512, -1692); window 100 pt in and 50 pt down from its top-left corner, 400×300
        let screen = CGRect(x: 1512, y: -1692, width: 3008, height: 1692)
        let window = CGRect(x: 1612, y: -1642, width: 400, height: 300)
        XCTAssertEqual(PickerGeometry.viewRect(window, screenTopLeft: screen), CGRect(x: 100, y: 1342, width: 400, height: 300))
    }

    func testDragInAnyDirectionNormalises() {
        let a = CGPoint(x: 300, y: 200), b = CGPoint(x: 100, y: 50)
        XCTAssertEqual(PickerGeometry.normalised(a, b), CGRect(x: 100, y: 50, width: 200, height: 150))
        XCTAssertEqual(PickerGeometry.normalised(b, a), PickerGeometry.normalised(a, b))
    }

    func testClampMovesInsideBoundsAndSnapsToEvenPixels() {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 800)
        XCTAssertEqual(PickerGeometry.clamped(CGRect(x: 900, y: 700, width: 200, height: 200), to: bounds, scale: 1),
                       CGRect(x: 800, y: 600, width: 200, height: 200))
        // at 2x: 101.1 pt = 202.2 px → 202 px (101 pt); 51.7 pt = 103.4 px → 102 px (51 pt)
        let snapped = PickerGeometry.clamped(CGRect(x: 10, y: 10, width: 101.1, height: 51.7), to: bounds, scale: 2)
        XCTAssertEqual(snapped.width, 101)
        XCTAssertEqual(snapped.height, 51)
    }

    func testPixelSizeText() {
        XCTAssertEqual(PickerGeometry.pixelText(CGSize(width: 1512, height: 982), scale: 2), "3024 x 1964")
    }

    func testResizeKeepsTheOppositeEdges() {
        let r = CGRect(x: 100, y: 100, width: 200, height: 100)
        XCTAssertEqual(PickerGeometry.resized(r, handle: .e, to: CGPoint(x: 400, y: 150)), CGRect(x: 100, y: 100, width: 300, height: 100))
        XCTAssertEqual(PickerGeometry.resized(r, handle: .nw, to: CGPoint(x: 50, y: 300)), CGRect(x: 50, y: 100, width: 250, height: 200))
        // dragging past the opposite edge flips the rect instead of making it negative
        XCTAssertEqual(PickerGeometry.resized(r, handle: .e, to: CGPoint(x: 50, y: 150)).width, 50)
    }

    func testHandleHitTest() {
        let r = CGRect(x: 0, y: 0, width: 100, height: 100)
        XCTAssertEqual(PickerGeometry.handle(at: CGPoint(x: 0, y: 0), in: r), .sw)
        XCTAssertEqual(PickerGeometry.handle(at: CGPoint(x: 50, y: 0), in: r), .s)
        XCTAssertEqual(PickerGeometry.handle(at: CGPoint(x: 100, y: 100), in: r), .ne)
        XCTAssertNil(PickerGeometry.handle(at: CGPoint(x: 50, y: 50), in: r))
    }

    func testOnlyOtherAppsNormalWindowsAreOffered() {
        let big = CGRect(x: 0, y: 0, width: 800, height: 600)
        XCTAssertTrue(PickerGeometry.isPickable(layer: 0, ownerBundleID: "app.other", ownBundleID: "app.ours", frame: big))
        XCTAssertFalse(PickerGeometry.isPickable(layer: 0, ownerBundleID: "app.ours", ownBundleID: "app.ours", frame: big))
        XCTAssertFalse(PickerGeometry.isPickable(layer: 25, ownerBundleID: "app.other", ownBundleID: "app.ours", frame: big))
        XCTAssertFalse(PickerGeometry.isPickable(layer: 0, ownerBundleID: "app.other", ownBundleID: "app.ours",
                                                 frame: CGRect(x: 0, y: 0, width: 80, height: 300)))
        XCTAssertFalse(PickerGeometry.isPickable(layer: 0, ownerBundleID: nil, ownBundleID: "app.ours", frame: big))
    }

    func testFrontmostWindowUnderThePointWins() {
        let windows = [
            PickableWindow(id: 1, frame: CGRect(x: 0, y: 0, width: 100, height: 100), appName: "A"),
            PickableWindow(id: 2, frame: CGRect(x: 50, y: 50, width: 100, height: 100), appName: "B"),
        ]
        XCTAssertEqual(PickerGeometry.frontmost(at: CGPoint(x: 60, y: 60), in: windows)?.id, 1)
        XCTAssertEqual(PickerGeometry.frontmost(at: CGPoint(x: 120, y: 120), in: windows)?.id, 2)
        XCTAssertNil(PickerGeometry.frontmost(at: CGPoint(x: 500, y: 500), in: windows))
    }
}
