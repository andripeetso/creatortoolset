import Foundation
import XCTest
@testable import CreatorToolsetMac

final class LogicTests: XCTestCase {
    func testSiteAddressNeedsHttpOrHttps() {
        XCTAssertEqual(siteURL(from: " https://tools.example.com/ ")?.absoluteString, "https://tools.example.com")
        XCTAssertEqual(siteURL(from: "http://localhost:3000/x")?.absoluteString, "http://localhost:3000")
        XCTAssertNil(siteURL(from: "tools.example.com"))
        XCTAssertNil(siteURL(from: "file:///etc"))
        XCTAssertNil(siteURL(from: "http://tools.example.com"))   // the cookie goes by hand: never in clear
        XCTAssertNil(siteURL(from: "http://10.0.0.5:3000"))
    }

    func testCookiesOnlyGoToTheSiteAndItsSubdomains() {
        func cookie(_ domain: String) -> HTTPCookie {
            HTTPCookie(properties: [.domain: domain, .path: "/", .name: "cap_auth", .value: "x"])!
        }
        let site = URL(string: "https://example.com")!
        let kept = cookies(for: site, in: [cookie(".example.com"), cookie("api.example.com")])
        XCTAssertEqual(kept.map(\.domain), [".example.com"])
        XCTAssertEqual(cookies(for: site, in: [cookie("example.org"), cookie("notexample.com")]).count, 0)
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
