import Foundation
import XCTest
@testable import CreatorToolsetMac

final class LinkTests: XCTestCase {
    private let site = URL(string: "http://127.0.0.1:43128")!

    func testTheAppSchemeOpensThatPage() {
        XCTAssertEqual(appHref(from: URL(string: "creatortoolset://review/abc-1?v=2")!, site: site), "/review/abc-1?v=2")
        XCTAssertEqual(appHref(from: URL(string: "creatortoolset://")!, site: site), "/")
        XCTAssertEqual(appHref(from: URL(string: "creatortoolset://workshop/sessions/s1#chat")!, site: site), "/workshop/sessions/s1#chat")
    }

    func testTheSitesOwnLinksOpenTooAndNothingElse() {
        XCTAssertEqual(appHref(from: URL(string: "http://127.0.0.1:43128/review/abc?v=2")!, site: site), "/review/abc?v=2")
        XCTAssertEqual(appHref(from: URL(string: "http://127.0.0.1:43128")!, site: site), "/")
        XCTAssertNil(appHref(from: URL(string: "https://example.com/review/abc")!, site: site))
        XCTAssertNil(appHref(from: URL(string: "file:///etc/passwd")!, site: site))
    }
}
