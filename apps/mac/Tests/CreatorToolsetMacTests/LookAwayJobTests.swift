import XCTest
@testable import CreatorToolsetMac

final class LookAwayJobTests: XCTestCase {
    func testThePupilsPlaceAcrossTheEye() {
        let eye = [CGPoint(x: 0.2, y: 0.5), CGPoint(x: 0.4, y: 0.55), CGPoint(x: 0.6, y: 0.5), CGPoint(x: 0.4, y: 0.45)]
        XCTAssertEqual(LookAwayJob.across(eye: eye, pupil: CGPoint(x: 0.4, y: 0.5))!, 0.5, accuracy: 1e-9)
        XCTAssertEqual(LookAwayJob.across(eye: eye, pupil: CGPoint(x: 0.5, y: 0.52))!, 0.75, accuracy: 1e-9)
        XCTAssertNil(LookAwayJob.across(eye: [], pupil: .zero))
        XCTAssertNil(LookAwayJob.across(eye: [CGPoint(x: 0.3, y: 0.3)], pupil: .zero))
    }

    func testAClaimCarriesTheTakesToMeasure() {
        let claim = Data(#"{"job":{"id":7,"kind":"lookaway","editId":"e","variant":"v1","footage":[{"id":"ver_a","path":"/Volumes/Footage/a.mov"},{"id":"ver_b","copy":"proxy"},{"path":"/no/id"}]}}"#.utf8)
        let job = EditorJob(claim: claim)
        XCTAssertEqual(job?.kind, lookAwayKind)
        XCTAssertEqual(job?.footage, [.init(id: "ver_a", path: "/Volumes/Footage/a.mov"), .init(id: "ver_b", path: nil)])
    }

    func testNoFaceInAPictureIsNoSample() throws {
        let ctx = CGContext(data: nil, width: 64, height: 64, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.9, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        XCTAssertNil(try LookAwayJob.sample(ctx.makeImage()!))
    }
}
