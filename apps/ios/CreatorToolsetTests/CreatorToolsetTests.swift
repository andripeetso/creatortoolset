import XCTest
@testable import CreatorToolset

final class RulesTests: XCTestCase {
    private let id = UUID()
    private func after(_ kind: TransferStep.Kind, _ status: Int, offset: Int64? = nil, etag: String? = nil,
                       body: String = "", part: Int = 0, network: Bool = false) -> NextAction {
        Rules.after(TransferStep(itemId: id, kind: kind, part: part), status: status, uploadOffset: offset, etag: etag,
                    size: 100, body: Data(body.utf8), networkError: network)
    }

    func testChunks() {
        XCTAssertEqual(after(.patch, 204, offset: 40), .send(from: 40))
        XCTAssertEqual(after(.patch, 204, offset: 100), .finish)
        XCTAssertEqual(after(.patch, 409, body: #"{"error":"Wrong offset","offset":64}"#), .send(from: 64))
        XCTAssertEqual(after(.patch, 404), .startOver("The server dropped the upload: sending it again"))
        XCTAssertEqual(after(.patch, 0, network: true), .retryLater("Waiting for a connection"))
        XCTAssertEqual(after(.patch, 401), .signedOut)
        XCTAssertEqual(after(.patch, 503), .retryLater("The server answered 503"))
    }

    func testBucketParts() {
        XCTAssertEqual(after(.part, 200, etag: "\"abc\"", part: 2), .partDone(2, etag: "\"abc\""))
        XCTAssertEqual(after(.part, 403, part: 2), .startOver("The upload link expired: sending it again"))
        // a part with no ETag is not done
        XCTAssertEqual(after(.part, 200, part: 1), .failed("The server answered 200"))
    }

    func testFinish() {
        XCTAssertEqual(after(.finish, 200, body: #"{"assetId":"a","versionId":"v"}"#), .done(duplicate: false))
        XCTAssertEqual(after(.finish, 200, body: #"{"duplicateOf":"a"}"#), .done(duplicate: true))
        XCTAssertEqual(after(.finish, 409, body: #"{"error":"The upload is incomplete","offset":10}"#), .send(from: 10))
        XCTAssertEqual(after(.finish, 413, body: #"{"error":"Too large"}"#), .failed("Too large"))
        XCTAssertEqual(after(.finish, 500, body: #"{"error":"disk"}"#), .startOver("disk"))
    }

    func testStepRoundTrip() {
        let step = TransferStep(itemId: id, kind: .patch, offset: 33554432, part: 0)
        XCTAssertEqual(TransferStep(encoded: step.encoded), step)
        XCTAssertNil(TransferStep(encoded: "nonsense"))
    }

    func testBackoff() {
        XCTAssertEqual(Rules.backoff(1), 10)
        XCTAssertEqual(Rules.backoff(3), 40)
        XCTAssertEqual(Rules.backoff(20), 600)
    }
}

final class SignInTests: XCTestCase {
    func testAddresses() {
        XCTAssertEqual(SignIn.parse("studio.example.com")?.origin.absoluteString, "https://studio.example.com/")
        XCTAssertEqual(SignIn.parse("192.0.2.20:43127")?.origin.absoluteString, "http://192.0.2.20:43127/")
        XCTAssertEqual(SignIn.parse("my-mac.local:43127")?.origin.absoluteString, "http://my-mac.local:43127/")
        XCTAssertEqual(SignIn.parse(" https://studio.example.com/library ")?.linkPath, nil)
        XCTAssertNil(SignIn.parse("not an address"))
        XCTAssertNil(SignIn.parse("ftp://example.com"))
    }

    func testSignInLink() {
        let target = SignIn.parse("http://192.0.2.20:43127/api/auth/link/AbC-123_x")
        XCTAssertEqual(target?.origin.absoluteString, "http://192.0.2.20:43127/")
        XCTAssertEqual(target?.linkPath, "/api/auth/link/AbC-123_x")
    }

    func testCookieFromRedirect() {
        let response = HTTPURLResponse(url: URL(string: "https://studio.example.com/api/auth/link/x")!, statusCode: 302,
                                       httpVersion: nil,
                                       headerFields: ["Set-Cookie": "cap_auth=tinyacrobatics.abc; HttpOnly; Path=/; Max-Age=60; SameSite=Lax; Secure"])!
        XCTAssertEqual(SignIn.cookie(from: response), "tinyacrobatics.abc")
    }
}
