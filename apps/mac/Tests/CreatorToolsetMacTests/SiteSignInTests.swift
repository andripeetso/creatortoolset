import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The login screen's Sign in with Google in the window: run in the system's sheet as an app's sign-in, ending here.
final class SiteSignInTests: XCTestCase {
    private let site = URL(string: "https://creatortoolset.com")!

    func testOnlyTheLoginScreensStartOnThisSiteIsTaken() {
        let start = siteSignInStart(URL(string: "https://creatortoolset.com/api/account/login/google?for=site&next=%2Fadmin")!, site: site)
        XCTAssertEqual(start?.provider, "google")
        XCTAssertEqual(start?.back, "/admin")
        XCTAssertEqual(siteSignInStart(URL(string: "https://creatortoolset.com/api/account/login/apple?for=site")!, site: site)?.back, "/")
        // another site, a link (for=link), the app's own start, an unknown provider: not this
        XCTAssertNil(siteSignInStart(URL(string: "https://evil.example/api/account/login/google?for=site")!, site: site))
        XCTAssertNil(siteSignInStart(URL(string: "https://creatortoolset.com/api/account/login/google?for=link")!, site: site))
        XCTAssertNil(siteSignInStart(URL(string: "https://creatortoolset.com/api/account/login/google?for=site&app=1")!, site: site))
        XCTAssertNil(siteSignInStart(URL(string: "https://creatortoolset.com/api/account/login/microsoft?for=site")!, site: site))
        // a way back to another site is dropped
        XCTAssertEqual(siteSignInStart(URL(string: "https://creatortoolset.com/api/account/login/google?for=site&next=%2F%2Fevil.example")!, site: site)?.back, "/")
    }

    func testTheSheetStartsAnAppsSignInWithTheChallenge() {
        let url = siteSignInURL(provider: "google", site: site, back: "/admin", challenge: "abc")
        XCTAssertEqual(url.absoluteString, "https://creatortoolset.com/api/account/login/google?for=site&app=1&challenge=abc&next=/admin")
    }

    func testTheSitesAnswerIsReadAsACodeOrItsWords() {
        XCTAssertEqual(siteSignInResult(URL(string: "creatortoolset://signin?code=xyz")!), .success("xyz"))
        XCTAssertEqual(siteSignInResult(URL(string: "creatortoolset://signin?error=No%20account")!), .failure(SiteSignInError(message: "No account")))
        XCTAssertNil(siteSignInResult(URL(string: "creatortoolset://account?code=xyz")!))   // the Mac's own account sign-in
    }

    func testThePageSwapsTheCodeAndGoesBack() {
        let js = siteSignInScript(code: "c\"1", verifier: "v", back: "/admin")
        XCTAssertTrue(js.contains(#"fetch("/api/auth/app""#))
        XCTAssertTrue(js.contains(#"\"c\\\"1\""#) || js.contains(#"c\"1"#))
        XCTAssertTrue(js.contains(#"["\/admin"]"#) || js.contains(#"["/admin"]"#))
    }
}
