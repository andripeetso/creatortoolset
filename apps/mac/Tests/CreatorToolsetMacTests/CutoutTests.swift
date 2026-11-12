import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CreatorToolsetMac

/// A picture drawn here: a shaded red ball with its shadow, on a plain light backdrop. No person in it.
private func ball(width: Int = 640, height: Int = 480) -> CGImage {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.setFillColor(CGColor(red: 0.92, green: 0.92, blue: 0.9, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let r = Double(min(width, height)) / 4, x = Double(width) / 2, y = Double(height) / 2
    ctx.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.18))
    ctx.fillEllipse(in: CGRect(x: x - r * 0.9, y: y - r * 1.25, width: r * 1.8, height: r / 3))
    let shade = CGGradient(colorsSpace: space, colors: [CGColor(red: 1, green: 0.55, blue: 0.5, alpha: 1), CGColor(red: 0.75, green: 0.05, blue: 0.05, alpha: 1)] as CFArray, locations: [0, 1])!
    ctx.addEllipse(in: CGRect(x: x - r, y: y - r, width: 2 * r, height: 2 * r))
    ctx.clip()
    ctx.drawRadialGradient(shade, startCenter: CGPoint(x: x - r / 3, y: y + r / 2.4), startRadius: 2, endCenter: CGPoint(x: x, y: y), endRadius: r * 1.08, options: [])
    return ctx.makeImage()!
}

/// `image` encoded as `type`, with these properties (an EXIF orientation, say).
private func encoded(_ image: CGImage, _ type: UTType, _ props: [CFString: Any] = [:]) -> Data? {
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    return CGImageDestinationFinalize(dest) ? out as Data : nil
}

/// A PNG's size and its pixels as RGBA (premultiplied).
private struct Pixels {
    let width: Int, height: Int
    private let bytes: [UInt8]
    init(png: Data) throws {
        let source = try XCTUnwrap(CGImageSourceCreateWithData(png as CFData, nil))
        XCTAssertEqual(CGImageSourceGetType(source) as String?, UTType.png.identifier)
        let image = try XCTUnwrap(CGImageSourceCreateImageAtIndex(source, 0, nil))
        width = image.width
        height = image.height
        var px = [UInt8](repeating: 0, count: width * height * 4)
        let ctx = CGContext(data: &px, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        bytes = px
    }
    /// (red, green, blue, alpha) at x, y from the top left
    func at(_ x: Int, _ y: Int) -> (Int, Int, Int, Int) {
        let i = (y * width + x) * 4
        return (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]), Int(bytes[i + 3]))
    }
}

final class CutoutTests: XCTestCase {
    func testADrawnBallIsCutOutOfItsBackgroundFromAPNGAJPEGAndAHEIC() throws {
        for type in [UTType.png, .jpeg, .heic] {
            let picture = try XCTUnwrap(encoded(ball(), type), "\(type) can't be written on this Mac")
            let cut = try Pixels(png: Cutout.png(picture))
            XCTAssertEqual([cut.width, cut.height], [640, 480], "\(type)")
            // the backdrop is see-through, corner to corner, and so is the shadow on it
            for (x, y) in [(2, 2), (637, 2), (2, 477), (637, 477), (320, 380)] { XCTAssertEqual(cut.at(x, y).3, 0, "\(type) at \(x),\(y)") }
            // the ball is kept whole and red
            for (x, y) in [(320, 240), (260, 200), (380, 290)] {
                let (r, g, b, a) = cut.at(x, y)
                XCTAssertEqual(a, 255, "\(type) at \(x),\(y)")
                XCTAssertGreaterThan(r, max(g, b) + 60, "\(type) at \(x),\(y)")
            }
        }
    }

    func testAPictureTheCameraHeldOnItsSideComesOutUpright() throws {
        // stored 640 × 480 and marked "turned a quarter" (EXIF 6): it is shown, and cut, 480 × 640
        let picture = try XCTUnwrap(encoded(ball(), .jpeg, [kCGImagePropertyOrientation: 6]))
        let cut = try Pixels(png: Cutout.png(picture))
        XCTAssertEqual([cut.width, cut.height], [480, 640])
        XCTAssertEqual(cut.at(2, 2).3, 0)
        XCTAssertEqual(cut.at(240, 320).3, 255)
    }

    func testAPictureWiderThanTheCapIsCutAtTheCap() throws {
        let cut = try Pixels(png: Cutout.png(XCTUnwrap(encoded(ball(width: Cutout.maxSide + 400, height: 1100), .png))))
        XCTAssertEqual(cut.width, Cutout.maxSide)
        XCTAssertEqual(cut.height, 1100 * Cutout.maxSide / (Cutout.maxSide + 400))
        XCTAssertEqual(cut.at(cut.width / 2, cut.height / 2).3, 255)
    }

    func testWhatIsNotAPictureOrIsOverACapIsRefusedInWords() throws {
        let notOne = "That is not a PNG, JPEG or HEIC picture."
        let gif = try XCTUnwrap(encoded(ball(), .gif))
        for data in [Data("Tiny Acrobatics".utf8), Data(), gif] {
            XCTAssertThrowsError(try Cutout.png(data)) { XCTAssertEqual($0 as? Cutout.Refused, Cutout.Refused(why: notOne)) }
        }
        // the bytes: refused before anything is read
        var big = try XCTUnwrap(encoded(ball(), .png))
        big.append(Data(count: Cutout.maxBytes + 1 - big.count))
        XCTAssertThrowsError(try Cutout.png(big)) { XCTAssertEqual($0 as? Cutout.Refused, Cutout.Refused(why: "The picture is over 25 MB.")) }
        // the pixels, read from the file's header before it is decoded: up to 50 million, not one more
        XCTAssertTrue(Cutout.fits(width: 10_000, height: 5_000))
        XCTAssertFalse(Cutout.fits(width: 10_001, height: 5_000))
        XCTAssertFalse(Cutout.fits(width: 0, height: 5_000))
        // a picture with nothing on it has nothing to cut out
        let plain = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        plain.setFillColor(CGColor(gray: 0.9, alpha: 1))
        plain.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        XCTAssertThrowsError(try Cutout.png(XCTUnwrap(encoded(plain.makeImage()!, .png)))) {
            XCTAssertEqual($0 as? Cutout.Refused, Cutout.Refused(why: "Nothing in this picture stands out from its background."))
        }
    }

    // MARK: the step, against a stand-in server

    private let claim = "POST /api/devices/relay/editor/claim"
    private let step = "/api/devices/relay/cutout/3"

    private func runner(_ site: FakeSite, statuses: @escaping (AIStatus) -> Void = { _ in }) -> RelayRunner {
        let dir = testFolder("cutout")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return RelayRunner(base: site.url, token: "ctd_test-token", work: dir.appendingPathComponent("relay"), home: dir, onStatus: statuses, onRevoked: {})
    }

    private func offMain(_ work: @escaping () -> Void) async {
        await withCheckedContinuation { c in DispatchQueue.global().async { work(); c.resume() } }
    }

    func testAClaimedCutOutIsReadCutAndSentAndIsNotDrawingCards() async throws {
        let picture = try XCTUnwrap(encoded(ball(), .jpeg))
        let site = FakeSite()
        let step = step
        site.answer = { $0.path.hasSuffix("/editor/claim") ? (200, #"{"job":{"id":3,"kind":"cutout","editId":"","variant":""}}"#) : (200, #"{"ok":true}"#) }
        site.bytes = { $0.method == "GET" && $0.path == step ? picture : nil }
        let seen = NSMutableArray()
        let runner = runner(site) { status in seen.add(status.drawing) }
        let claimed = try XCTUnwrap(runner.claimStep(now: 1000))
        XCTAssertEqual(claimed, EditorJob(id: 3, kind: "cutout"))
        XCTAssertNil(runner.editorKinds(now: 100_000), "one step at a time")
        await offMain { runner.runSteps(claimed) }
        XCTAssertEqual(site.requests.map { "\($0.method) \($0.path)" }, [claim, "GET \(step)", "POST \(step)"])
        XCTAssertEqual(String(decoding: site.requests[0].body, as: UTF8.self), #"{"kinds":["cards-draw","cutout"]}"#)
        // what was sent is the cut-out, as a PNG file named `cutout`
        let sent = site.requests[2]
        XCTAssertTrue(sent.headers["content-type"]?.hasPrefix("multipart/form-data; boundary=") == true)
        XCTAssertNotNil(sent.body.range(of: Data("name=\"cutout\"; filename=\"cutout.png\"\r\nContent-Type: image/png".utf8)))
        XCTAssertNotNil(sent.body.range(of: Data([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
        XCTAssertEqual(seen.count, 0, "nothing in the menu changes: it is not Drawing cards, and no AI request")
        XCTAssertEqual(runner.editorKinds(now: 1001), ["cards-draw", "cutout"])
    }

    func testACutOutThatCannotBeMadeIsFailedWithTheReason() async throws {
        for (status, body, why) in [(200, "Tiny Acrobatics", "That is not a PNG, JPEG or HEIC picture."),
                                    (404, #"{"error":"Not found"}"#, "The picture could not be read from the server (HTTP 404).")] {
            let site = FakeSite()
            site.answer = { request in
                if request.path.hasSuffix("/editor/claim") { return (200, #"{"job":{"id":3,"kind":"cutout","editId":"","variant":""}}"#) }
                return request.method == "GET" ? (status, body) : (200, #"{"ok":true}"#)
            }
            let runner = runner(site)
            let claimed = try XCTUnwrap(runner.claimStep(now: 1000))
            await offMain { runner.runSteps(claimed) }
            XCTAssertEqual(site.requests.map { "\($0.method) \($0.path)" }, [claim, "GET \(step)", "POST \(step)/fail"])
            XCTAssertEqual((try? JSONSerialization.jsonObject(with: site.requests[2].body)) as? NSDictionary, ["error": why])
        }
    }
}
