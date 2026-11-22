import Foundation
import XCTest
@testable import CreatorToolsetMac

/// The login screen's Sign in with Google in the window: run in the system's sheet as an app's sign-in, ending here.
final class SiteSignInTests: XCTestCase {
    private let site = URL(string: "https://creatortoolset.com")!

    /// A page's `next` is only ever a path on this site: anything else, control characters included, comes back as the root.
    func testTheReturnPageIsASamePathOrTheRoot() {
        XCTAssertEqual(sameSiteBack("/admin?tab=2", site: site), "/admin?tab=2")
        for bad in ["//evil.example", "/\\evil.example", "https://evil.example", "evil.example", "/\t/evil.example", "/\n/evil.example", ""] {
            XCTAssertEqual(sameSiteBack(bad, site: site), "/", bad)
        }
        XCTAssertTrue(sameSiteBack("/a b%zz", site: site).hasPrefix("/"))   // a malformed path does not crash
    }

    /// Links the page hands to macOS: web and mail only.
    func testOnlyWebAndMailLeaveTheWindowForMacOS() {
        for ok in ["https://example.com/a", "http://example.com", "mailto:someone@example.com", "HTTPS://example.com"] {
            XCTAssertTrue(opensOutside(URL(string: ok)!), ok)
        }
        for no in ["smb://server/share", "file:///etc/hosts", "creatortoolset://account?code=x", "tel:+1555", "vscode://file/x"] {
            XCTAssertFalse(opensOutside(URL(string: no)!), no)
        }
    }

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
