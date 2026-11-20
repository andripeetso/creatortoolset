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

    // 2026-11-20: a burst of notes (cuts filed at once, an inbox seen again) posted a banner each
    func testSeveralFreshNotesAreOneNotification() {
        XCTAssertNil(macNote([]))
        XCTAssertEqual(macNote([note(id: "a")])?.ids, ["a"])
        let cuts = (1...28).map { note(id: "c\($0)", kind: "ready", name: $0 < 3 ? "Reel" : "Cut \($0)", href: "/review/\($0)") }
        let one = macNote(cuts)
        XCTAssertEqual(one?.title, "28 videos wait for your review")
        XCTAssertEqual(one?.body, "Reel, Cut 3, Cut 4 and 24 more")
        XCTAssertEqual(one?.href, "/review")
        XCTAssertEqual(one?.ids.count, 28)
        XCTAssertEqual(macNote([note(id: "a"), note(id: "b")])?.title, "2 new notifications")
        XCTAssertEqual(macNote([note(id: "a", kind: "ready", name: "Reel")])?.title, "Reel: a new cut to review")
    }

    private func note(id: String, read: Bool? = nil, kind: String = "comment", name: String = "Launch cut", href: String = "/review/x") -> ReviewNote {
        ReviewNote(id: id, kind: kind, by: "Ada", name: name, text: nil, href: href, read: read)
    }

    func testSmallWindowGrowsToMostOfTheScreenOnce() {
        let laptop = CGRect(x: 0, y: 25, width: 1512, height: 920)
        let grown = grownWindowFrame(current: CGRect(x: 100, y: 100, width: 960, height: 640), screen: laptop)!
        XCTAssertEqual(grown.width, 1285)
        XCTAssertEqual(grown.height, 782)
        XCTAssertEqual(grown.midX, laptop.midX, accuracy: 1)
        XCTAssertNil(grownWindowFrame(current: CGRect(x: 0, y: 0, width: 1300, height: 800), screen: laptop)) // their own size stays
        let big = roomyWindowFrame(screen: CGRect(x: 0, y: 0, width: 3000, height: 1800))
        XCTAssertEqual(big.size, CGSize(width: 1440, height: 920))
    }

    func testScreenshotFitsInTwoThousandPixels() {
        XCTAssertTrue(fittedSize(width: 3024, height: 1964) == (2000, 1299))
        XCTAssertTrue(fittedSize(width: 1000, height: 4000) == (500, 2000))
        XCTAssertTrue(fittedSize(width: 1440, height: 900) == (1440, 900))   // small enough: as it is
    }
}
