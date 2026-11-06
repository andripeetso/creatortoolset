import Foundation
import XCTest
@testable import CreatorToolsetMac

final class LogicTests: XCTestCase {
    func testSiteAddressNeedsHttpOrHttps() {
        XCTAssertEqual(siteURL(from: " https://creatortoolset.com/ ")?.absoluteString, "https://creatortoolset.com")
        XCTAssertEqual(siteURL(from: "http://localhost:3000/x")?.absoluteString, "http://localhost:3000")
        XCTAssertNil(siteURL(from: "creatortoolset.com"))
        XCTAssertNil(siteURL(from: "file:///etc"))
        XCTAssertNil(siteURL(from: "http://creatortoolset.com"))   // the cookie goes by hand: never in clear
        XCTAssertNil(siteURL(from: "http://10.0.0.5:3000"))
    }

    func testCookiesOnlyGoToTheSiteAndItsSubdomains() {
        func cookie(_ domain: String) -> HTTPCookie {
            HTTPCookie(properties: [.domain: domain, .path: "/", .name: "cap_auth", .value: "x"])!
        }
        let kept = cookies(for: productionSite, in: [cookie(".creatortoolset.com"), cookie("api.creatortoolset.com")])
        XCTAssertEqual(kept.map(\.domain), [".creatortoolset.com"])
        XCTAssertEqual(cookies(for: productionSite, in: [cookie("example.com"), cookie("notcreatortoolset.com")]).count, 0)
    }

    func testUniqueURLNeverReplacesAFile() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data().write(to: folder.appendingPathComponent("clip.mp4"))
        XCTAssertEqual(uniqueURL(in: folder, named: "clip.mp4").lastPathComponent, "clip (2).mp4")
        XCTAssertEqual(uniqueURL(in: folder, named: "notes").lastPathComponent, "notes")
    }

    func testFirstRunShowsNothingThenOnlyNewUnreadNotes() {
        let old = note(id: "old")
        let read = note(id: "read", read: true)
        let new = note(id: "new")
        XCTAssertEqual(freshNotes([old, read, new], seen: nil).count, 0)
        XCTAssertEqual(freshNotes([old, read, new], seen: ["old"]).map(\.id), ["new"])
        XCTAssertEqual(rememberedIDs([new, old], seen: ["gone"]), ["new", "old", "gone"])
    }

    private func note(id: String, read: Bool? = nil) -> ReviewNote {
        ReviewNote(id: id, kind: "comment", by: "Ada", name: "Launch cut", text: nil, href: "/review/x", read: read)
    }
}
