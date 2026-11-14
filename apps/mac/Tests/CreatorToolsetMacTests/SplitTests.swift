import CoreGraphics
import CoreText
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CreatorToolsetMac

/// A slide drawn here: a navy ground with one white heading, and (when asked) a grey band that runs dark to light under it (rows 900 to 1150 from the top).
private func slide(_ words: String, banded: Bool = false) -> Data {
    let (w, h) = (1080, 1350)
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(red: 0x1d / 255, green: 0x2a / 255, blue: 0x5c / 255, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
    if banded {
        let band = CGGradient(colorsSpace: space, colors: [CGColor(gray: 0.1, alpha: 1), CGColor(gray: 0.9, alpha: 1)] as CFArray, locations: [0, 1])!
        ctx.saveGState()
        ctx.clip(to: CGRect(x: 0, y: 200, width: w, height: 250))
        ctx.drawLinearGradient(band, start: CGPoint(x: 0, y: 0), end: CGPoint(x: CGFloat(w), y: 0), options: [])
        ctx.restoreGState()
    }
    let font = CTFontCreateWithName("Helvetica-Bold" as CFString, 120, nil)
    let line = CTLineCreateWithAttributedString(NSAttributedString(string: words, attributes: [
        NSAttributedString.Key(kCTFontAttributeName as String): font, NSAttributedString.Key(kCTForegroundColorAttributeName as String): CGColor(gray: 1, alpha: 1),
    ]))
    // Core Graphics counts up from the bottom: a baseline 330 from the top
    ctx.textPosition = CGPoint(x: 90, y: CGFloat(h - 330))
    CTLineDraw(line, ctx)
    let out = NSMutableData()
    let dest = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
    CGImageDestinationFinalize(dest)
    return out as Data
}

private func pixels(_ png: Data) throws -> Bitmap {
    let source = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
    return Bitmap(try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil)))
}

final class SplitTests: XCTestCase {
    func testASlidesWordsAreReadWithTheirPlaceAndColourAndPaintedOver() throws {
        let picture = slide("Floor first.")
        let made = try Split.run(picture)
        XCTAssertEqual(made.lines.map(\.text), ["Floor first."])
        let line = try XCTUnwrap(made.lines.first)
        // where it was drawn: from 90 across, its letters over the baseline at 330
        XCTAssertEqual(line.box.minX, 90, accuracy: 12)
        XCTAssertLessThan(line.box.minY, 330 - 70)
        XCTAssertGreaterThan(line.box.maxY, 330)
        XCTAssertEqual(line.color, "#ffffff")
        XCTAssertGreaterThan(line.ink, 0.15)
        // a flat ground: nothing stands out, and where the letters were is the ground again
        XCTAssertTrue(made.pieces.isEmpty)
        let ground = try pixels(made.background)
        XCTAssertEqual([ground.width, ground.height], [1080, 1350])
        // away from the words the picture is as it was, colour for colour
        let (r0, g0, b0) = ground.rgb(1000, 1300)
        let was = try pixels(picture).rgb(1000, 1300)
        XCTAssertEqual([r0, g0, b0], [was.0, was.1, was.2])
        var off = 0
        for y in stride(from: Int(line.box.minY), to: Int(line.box.maxY), by: 7) {
            for x in stride(from: Int(line.box.minX), to: Int(line.box.maxX), by: 7) {
                let (r, g, b) = ground.rgb(x, y)
                if abs(r - r0) + abs(g - g0) + abs(b - b0) > 12 { off += 1 }
            }
        }
        XCTAssertEqual(off, 0, "pixels where the letters were that are not the ground")
        // the layout the server reads: fractions of the picture
        let layout = try XCTUnwrap(JSONSerialization.jsonObject(with: made.layout()) as? [String: Any])
        let sent = try XCTUnwrap((layout["lines"] as? [[String: Any]])?.first)
        XCTAssertEqual(sent["text"] as? String, "Floor first.")
        XCTAssertEqual(try XCTUnwrap(sent["x"] as? Double), 90 / 1080, accuracy: 0.012)
        XCTAssertEqual((layout["pieces"] as? [Any])?.count, 0)
    }

    func testPaintingOverFollowsAGroundThatRunsFromDarkToLight() throws {
        let made = try Split.run(slide("Floor first.", banded: true))
        let ground = try pixels(made.background)
        // a marked run across the band is blended between its ends: the middle comes out between dark and light
        var px = ground
        var mask = [Bool](repeating: false, count: px.width * px.height)
        for y in 980..<1060 { for x in 300..<700 { mask[y * px.width + x] = true } }
        px.paint(over: mask)
        let (left, middle, right) = (px.rgb(320, 1020).0, px.rgb(500, 1020).0, px.rgb(680, 1020).0)
        XCTAssertLessThan(left, middle)
        XCTAssertLessThan(middle, right)
        XCTAssertEqual(middle, ground.rgb(500, 1020).0, accuracy: 12)
    }

    func testAClaimedSplitIsReadAndSentAsItsLayoutBackgroundAndPieces() async throws {
        let picture = slide("Floor first.")
        let (claim, step) = ("POST /api/devices/relay/editor/claim", "/api/devices/relay/cutout/4")
        let site = FakeSite()
        site.answer = { $0.path.hasSuffix("/editor/claim") ? (200, #"{"job":{"id":4,"kind":"split","editId":"","variant":""}}"#) : (200, #"{"ok":true}"#) }
        site.bytes = { $0.method == "GET" && $0.path == step ? picture : nil }
        let dir = testFolder("split")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        let runner = RelayRunner(base: site.url, token: "ctd_test-token", work: dir.appendingPathComponent("relay"), home: dir, onStatus: { _ in }, onRevoked: {})
        let claimed = try XCTUnwrap(runner.claimStep(now: 1000))
        XCTAssertEqual(claimed, EditorJob(id: 4, kind: "split"))
        await withCheckedContinuation { c in DispatchQueue.global().async { runner.runSteps(claimed); c.resume() } }
        XCTAssertEqual(site.requests.map { "\($0.method) \($0.path)" }, [claim, "GET \(step)", "POST \(step)"])
        // the parts the server reads (api/devices.ts → lib/cutouts.ts cutoutSent): the layout as JSON, the background as a PNG
        let sent = site.requests[2].body
        XCTAssertNotNil(sent.range(of: Data("name=\"layout\"; filename=\"layout.json\"\r\nContent-Type: application/json".utf8)))
        XCTAssertNotNil(sent.range(of: Data("name=\"background\"; filename=\"background.png\"\r\nContent-Type: image/png".utf8)))
        XCTAssertNotNil(sent.range(of: Data("\"text\":\"Floor first.\"".utf8)))
        XCTAssertNil(sent.range(of: Data("name=\"piece0\"".utf8)), "a flat slide has no piece")
    }

    func testAPictureThatIsNoneIsRefusedInWords() {
        XCTAssertThrowsError(try Split.run(Data("not a picture".utf8))) { XCTAssertEqual(($0 as? Cutout.Refused)?.why, "That is not a PNG, JPEG or HEIC picture.") }
    }
}
