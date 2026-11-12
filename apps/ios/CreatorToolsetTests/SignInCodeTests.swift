import XCTest
@testable import CreatorToolset

/// The sign-in code step, with no network: what each refusal of /api/auth/login, /api/auth/ticket and /api/auth/code
/// means to the phone. The bodies are the server's own answers (apps/captions/api/auth.ts, read back from a scratch
/// server), the step token shortened.
@MainActor
final class SignInCodeTests: XCTestCase {
    private let needed = #"{"error":"This account asks for a code from an authenticator app, which this app can't take yet. Sign in with a link from a signed-in computer instead.","code":"CODE_NEEDED","step":"Xq3v9Tn0aBcD-eFgHiJkLmNoPqRsTuVwXyZ01234567"}"#
    private let setup = #"{"error":"This server asks for a code from an authenticator app. Set it up in a browser, then sign in here with a link from it.","code":"CODE_SETUP","step":"Xq3v9Tn0aBcD-eFgHiJkLmNoPqRsTuVwXyZ01234567"}"#
    private let expired = #"{"error":"That sign-in expired. Sign in again.","code":"STEP_EXPIRED"}"#
    private let wrong = #"{"error":"Wrong code"}"#
    private let locked = #"{"error":"Too many wrong tries. Try again in 2 minutes.","code":"LOCKED"}"#

    private func refusal(_ status: Int, _ json: String) throws -> SignIn.Outcome {
        try SignIn.refusal(status, Data(json.utf8))
    }

    func testARightPasswordAsksForTheCode() throws {
        XCTAssertEqual(try refusal(401, needed), .needsCode(step: "Xq3v9Tn0aBcD-eFgHiJkLmNoPqRsTuVwXyZ01234567"))
        // the server asks everyone and this account has none yet: set up on the website, not here
        XCTAssertEqual(try refusal(401, setup), .setUpCode)
    }

    func testWhatTheCodeAnswers() {
        // wrong: said, and the step stays good for another try
        XCTAssertThrowsError(try refusal(401, wrong)) { XCTAssertEqual($0 as? APIError, .server(401, "Wrong code")) }
        // the step's five minutes are up: back to the password
        XCTAssertThrowsError(try refusal(401, expired)) {
            XCTAssertEqual($0 as? SignIn.StepExpired, SignIn.StepExpired(errorDescription: "That sign-in expired. Sign in again."))
            XCTAssertEqual($0.localizedDescription, "That sign-in expired. Sign in again.")
        }
        // too many tries: the server's sentence
        XCTAssertThrowsError(try refusal(429, locked)) {
            XCTAssertEqual($0 as? APIError, .server(429, "Too many wrong tries. Try again in 2 minutes."))
        }
    }

    func testOtherRefusalsKeepTheServersWords() {
        XCTAssertThrowsError(try refusal(401, #"{"error":"Wrong username or password"}"#)) {
            XCTAssertEqual($0 as? APIError, .server(401, "Wrong username or password"))
        }
        XCTAssertThrowsError(try refusal(403, #"{"error":"Your team signs in with Google: use that button","code":"SIGNIN_RULE"}"#)) {
            XCTAssertEqual($0 as? APIError, .server(403, "Your team signs in with Google: use that button"))
        }
        // a code word on another status, or the code step without its token, is not a step of the sign-in
        XCTAssertThrowsError(try refusal(403, needed)) { XCTAssertEqual(($0 as? APIError)?.errorDescription?.hasPrefix("This account asks"), true) }
        XCTAssertThrowsError(try refusal(401, #"{"error":"Ask for a link","code":"CODE_NEEDED"}"#)) {
            XCTAssertEqual($0 as? APIError, .server(401, "Ask for a link"))
        }
        XCTAssertThrowsError(try refusal(502, "<html>Bad gateway</html>")) { XCTAssertEqual($0 as? APIError, .server(502, "The server answered 502")) }
    }

    /// A sign-in route's 401 is decided by `SignIn.refusal`, never by `API.data`'s signed-out branch: the computer in use
    /// stays signed in and remembered.
    func testAStepOfTheSignInIsNeverASessionThatEnded() {
        let before = Servers.shared.signedOut
        for body in [needed, setup, expired, wrong] {
            do {
                _ = try refusal(401, body)
            } catch {
                XCTAssertNotEqual(error as? APIError, .signedOut, body)
            }
        }
        XCTAssertEqual(Servers.shared.signedOut, before)
    }
}
