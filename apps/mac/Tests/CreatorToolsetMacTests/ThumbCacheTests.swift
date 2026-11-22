import Foundation
import XCTest
@testable import CreatorToolsetMac

// The Media Library thumb cache (ThumbCache.swift): only a server's thumb or sprite path reaches the server, and a kept
// file belongs to one server, one account and one path with its query.
final class ThumbCacheTests: XCTestCase {
    private let thumb = "/api/library/media/v1-abc/thumb?t=7&v=4096"

    func testAThumbAddressRoundTripsItsPathAndQuery() throws {
        let url = ThumbCache.url(target: thumb)
        XCTAssertEqual(url.scheme, "ctlocal")
        XCTAssertEqual(url.host, "thumb")
        XCTAssertEqual(ThumbCache.target(from: url), thumb)
        XCTAssertNil(ThumbCache.target(from: URL(string: "ctlocal://media/\(String(url.path.dropFirst()))")!))
    }

    func testOnlyAMediaLibraryThumbOrSpriteIsAccepted() {
        XCTAssertTrue(ThumbCache.accepts("/api/library/media/v1-abc/sprite"))
        XCTAssertTrue(ThumbCache.accepts(thumb))
        XCTAssertTrue(ThumbCache.accepts("/api/review/assets/3f2a-b_c/v/12/thumb?c=1763840000000"))
        for bad in [
            "/api/review/assets/a1/v/1/play",
            "/api/review/assets/a1/v/x/thumb",
            "/api/review/assets/a1/v/1/thumb/extra",
            "/api/review/trash/a1/v/1/thumb",
            "/api/review/assets/../v/1/thumb",
            "/api/library/media/v1/play",
            "/api/library/media/v1/source",
            "/api/library/media//thumb",
            "/api/library/media/v1/thumb/extra",
            "/api/library/media/v1/thumb/../../admin",
            "/api/users/v1/thumb",
            "https://evil.example/api/library/media/v1/thumb",
            "/api/library/media/v1/thumb?x=<script>",
            "/api/library/media/v1/thumb?a=b#frag",
        ] {
            XCTAssertFalse(ThumbCache.accepts(bad), bad)
        }
    }

    func testAReviewThumbIsKeptOnlyWhenTheServerSaysItNeverChanges() {
        let review = "/api/review/assets/a1/v/1/thumb?c=1"
        XCTAssertTrue(ThumbCache.keeps(target: review, status: 200, cacheControl: "private, max-age=31536000, immutable"))
        XCTAssertFalse(ThumbCache.keeps(target: review, status: 200, cacheControl: "private, max-age=3600"))
        XCTAssertFalse(ThumbCache.keeps(target: review, status: 200, cacheControl: nil))
        XCTAssertTrue(ThumbCache.keeps(target: thumb, status: 200, cacheControl: nil))
        XCTAssertFalse(ThumbCache.keeps(target: thumb, status: 404, cacheControl: nil))
    }

    func testTheSameServerAccountAndPathShareOneFile() throws {
        let dir = URL(fileURLWithPath: "/tmp/thumbs-test")
        let server = URL(string: "https://studio.example.com/library?x=1")!
        let origin = try XCTUnwrap(ThumbCache.origin(server))
        XCTAssertEqual(origin.absoluteString, "https://studio.example.com")
        let a = ThumbCache.file(in: dir, origin: origin, account: "tinyacrobatics", target: thumb)
        XCTAssertEqual(a, ThumbCache.file(in: dir, origin: origin, account: "tinyacrobatics", target: thumb))
        XCTAssertNotEqual(a, ThumbCache.file(in: dir, origin: origin, account: "otheraccount", target: thumb))
        XCTAssertNotEqual(a, ThumbCache.file(in: dir, origin: origin, account: "tinyacrobatics", target: "/api/library/media/v1-abc/thumb?t=7&v=5000"))
        XCTAssertNotEqual(a, ThumbCache.file(in: dir, origin: URL(string: "https://other.example.com")!, account: "tinyacrobatics", target: thumb))
        XCTAssertEqual(a.deletingLastPathComponent().path, dir.path)
    }

    func testARedirectOffTheServerGoesWithoutTheCookies() {
        let server = URL(string: "https://studio.example.com/api/library/media/v1/thumb")!
        var next = URLRequest(url: URL(string: "https://bucket.example.net/signed?x=1")!)
        next.setValue("session=secret", forHTTPHeaderField: "Cookie")
        XCTAssertNil(ThumbCache.followed(next, from: server).value(forHTTPHeaderField: "Cookie"))
        next.url = URL(string: "https://studio.example.com:8443/elsewhere")!
        XCTAssertNil(ThumbCache.followed(next, from: server).value(forHTTPHeaderField: "Cookie"))
        next.url = URL(string: "https://studio.example.com/api/library/media/v1/thumb?v=2")!
        XCTAssertEqual(ThumbCache.followed(next, from: server).value(forHTTPHeaderField: "Cookie"), "session=secret")
    }
}
