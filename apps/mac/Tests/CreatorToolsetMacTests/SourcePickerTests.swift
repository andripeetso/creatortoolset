import AppKit
import SwiftUI
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

    // The look, drawn into pictures (SourcePicker.picture is in debug builds only).
    #if DEBUG
    /// A 1157×563 pt window on a 3008×1692 pt screen (top-left coordinates, like the picker's own).
    private let bigScreen = CGSize(width: 3008, height: 1692)
    private let pickedFrame = CGRect(x: 900, y: 520, width: 1157, height: 563)

    @MainActor
    func testThePickedWindowIsWashedInsideABorderAndTheRestDimmed() throws {
        let window = PickableWindow(id: 7, frame: pickedFrame, appName: "Tiny Acrobatics")
        let rep = try XCTUnwrap(SourcePicker.picture(.window, screen: bigScreen, scale: 1, picked: window))
        // a pixel's opacity (the colour is the person's accent colour, so only how solid it is gets checked)
        let alpha = { (x: CGFloat, y: CGFloat) in rep.colorAt(x: Int(x), y: Int(y))?.alphaComponent ?? -1 }
        XCTAssertEqual(alpha(100, 100), 0.45, accuracy: 0.03)                                    // the dimmed screen
        XCTAssertEqual(alpha(pickedFrame.minX + 60, pickedFrame.minY + 60), 0.28, accuracy: 0.03)   // the wash
        XCTAssertGreaterThan(alpha(pickedFrame.midX, pickedFrame.minY + 1), 0.95)                // the border, solid
        XCTAssertGreaterThan(alpha(pickedFrame.minX + 1, pickedFrame.midY), 0.95)
        XCTAssertEqual(alpha(pickedFrame.minX + 1, pickedFrame.minY + 1), 0.45, accuracy: 0.03)  // the corner is cut round
    }

    /// Pictures of the picker and the count-in for a person to look at: CT_PROOF_DIR=<folder> swift test --filter Look
    @MainActor
    func testLookPictures() throws {
        guard let dir = ProcessInfo.processInfo.environment["CT_PROOF_DIR"].map({ URL(fileURLWithPath: $0, isDirectory: true) }) else {
            throw XCTSkip("set CT_PROOF_DIR to a folder for the pictures")
        }
        let scale: CGFloat = 2
        // a made-up app icon: the system's stand-in icons differ from run to run
        let icon = NSImage(size: NSSize(width: 128, height: 128), flipped: false) { rect in
            let tile = NSBezierPath(roundedRect: rect.insetBy(dx: 10, dy: 10), xRadius: 26, yRadius: 26)
            NSGradient(starting: NSColor(red: 0.98, green: 0.62, blue: 0.20, alpha: 1), ending: NSColor(red: 0.93, green: 0.30, blue: 0.36, alpha: 1))?.draw(in: tile, angle: 90)
            NSColor.white.setFill()
            NSBezierPath(ovalIn: rect.insetBy(dx: 44, dy: 44)).fill()
            return true
        }
        let window = PickableWindow(id: 7, frame: pickedFrame, appName: "Tiny Acrobatics", icon: icon)
        let inView = PickerGeometry.flipped(pickedFrame, height: bigScreen.height)   // bottom-left origin, as drawn
        let desk = { (overlay: NSBitmapImageRep?, dark: Bool) in
            self.canvas(self.bigScreen, scale: scale) {
                self.desktop(self.bigScreen, window: inView, dark: dark)
                overlay?.draw(in: CGRect(origin: .zero, size: self.bigScreen), from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
            }
        }
        let overlay = try XCTUnwrap(SourcePicker.picture(.window, screen: bigScreen, scale: scale, picked: window))
        let picker = desk(overlay, false)
        try write(picker, to: dir.appendingPathComponent("picker-window.png"))
        // the window with a margin, at full sharpness (the whole screen is shrunk when looked at)
        try write(crop(picker, to: inView.insetBy(dx: -90, dy: -70), scale: scale), to: dir.appendingPathComponent("picker-window-crop.png"))
        try write(crop(picker, to: CGRect(x: inView.minX - 40, y: inView.maxY - 110, width: 300, height: 150), scale: scale),
                  to: dir.appendingPathComponent("picker-window-corner.png"))
        // the same over a dark window, where a wash shows least
        try write(crop(desk(overlay, true), to: inView.insetBy(dx: -90, dy: -70), scale: scale), to: dir.appendingPathComponent("picker-window-dark-crop.png"))
        let area = desk(try XCTUnwrap(SourcePicker.picture(.area, screen: bigScreen, scale: scale, selection: inView)), false)
        try write(crop(area, to: inView.insetBy(dx: -90, dy: -70), scale: scale), to: dir.appendingPathComponent("picker-area-crop.png"))

        // the count-in number over the same window, before anything is dimmed
        let digit = ImageRenderer(content: CountInView(n: 3))
        digit.scale = scale
        let number = try XCTUnwrap(digit.cgImage)
        let counting = canvas(bigScreen, scale: scale) {
            self.desktop(self.bigScreen, window: inView, dark: false)
            let size = CountIn.size
            NSGraphicsContext.current?.cgContext.draw(number, in: CGRect(x: inView.midX - size.width / 2, y: inView.midY - size.height / 2, width: size.width, height: size.height))
        }
        try write(crop(counting, to: inView.insetBy(dx: -90, dy: -70), scale: scale), to: dir.appendingPathComponent("countin.png"))
        try write(crop(counting, to: CGRect(x: inView.midX - 150, y: inView.midY - 150, width: 300, height: 300), scale: scale),
                  to: dir.appendingPathComponent("countin-close.png"))
    }

    /// A picture `size` points large; `draw` runs with it as the current context (points, bottom-left origin).
    @MainActor
    private func canvas(_ size: CGSize, scale: CGFloat, _ draw: () -> Void) -> NSBitmapImageRep {
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale),
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        draw()
        NSGraphicsContext.restoreGraphicsState()
        return rep
    }

    @MainActor
    private func crop(_ rep: NSBitmapImageRep, to rect: CGRect, scale: CGFloat) -> NSBitmapImageRep {
        canvas(rect.size, scale: scale) {
            rep.draw(in: CGRect(origin: .zero, size: rect.size), from: rect, operation: .copy, fraction: 1, respectFlipped: false, hints: nil)
        }
    }

    private func write(_ rep: NSBitmapImageRep, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: url)
    }

    /// A made-up desktop under the overlay, so the wash is judged against a window and not against nothing: a
    /// wallpaper, a darker window behind, and the picked window as a light page with a title bar, a sidebar and lines.
    @MainActor
    private func desktop(_ screen: CGSize, window: CGRect, dark: Bool) {
        let grey = { (light: CGFloat, night: CGFloat) in NSColor(white: dark ? night : light, alpha: 1) }
        NSGradient(starting: NSColor(red: 0.16, green: 0.36, blue: 0.42, alpha: 1), ending: NSColor(red: 0.62, green: 0.50, blue: 0.36, alpha: 1))?
            .draw(in: CGRect(origin: .zero, size: screen), angle: 60)
        NSColor(white: 0.22, alpha: 1).setFill()
        NSBezierPath(roundedRect: window.offsetBy(dx: -420, dy: 180), xRadius: 10, yRadius: 10).fill()
        let page = NSBezierPath(roundedRect: window, xRadius: 10, yRadius: 10)
        grey(0.96, 0.13).setFill()
        page.fill()
        NSGraphicsContext.saveGraphicsState()
        page.addClip()
        grey(0.88, 0.19).setFill()
        CGRect(x: window.minX, y: window.maxY - 52, width: window.width, height: 52).fill()
        grey(0.92, 0.16).setFill()
        CGRect(x: window.minX, y: window.minY, width: 220, height: window.height - 52).fill()
        grey(0.55, 0.62).setFill()
        for row in 0..<14 {
            let width: CGFloat = [620, 540, 700, 380][row % 4]
            CGRect(x: window.minX + 260, y: window.maxY - 100 - CGFloat(row) * 32, width: width, height: 10).fill()
        }
        NSGraphicsContext.restoreGraphicsState()
    }
    #endif
}
