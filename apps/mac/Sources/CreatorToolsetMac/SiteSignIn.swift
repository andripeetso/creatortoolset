// Sign in with Google, Apple or GitHub to the site the window shows. The providers refuse a sign-in inside an app's web
// view, and the window sends any page off the site to the browser, so a press on the login screen's button would end
// in the browser, signed in there and not here. Instead the app runs that sign-in in the system's sign-in sheet as an
// app's sign-in (`app=1` with a PKCE challenge), the site ends it on creatortoolset://signin?code=, and the window's own
// page swaps the code for its session (POST /api/auth/app with the verifier), so the cookie lands in the window.
import AppKit
import AuthenticationServices
import Foundation

/// The login screen's sign-in start on this site (`/api/account/login/<provider>?for=site`), with the page to come back
/// to; nil for any other address. An app's own start (`app=1`) is not one: it is already this flow.
func siteSignInStart(_ url: URL, site: URL) -> (provider: String, back: String)? {
    guard isSite(url, site), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    let path = url.path
    guard path.hasPrefix("/api/account/login/") else { return nil }
    let provider = String(path.dropFirst("/api/account/login/".count))
    guard accountProviders.contains(provider) else { return nil }
    let q = parts.queryItems ?? []
    guard q.first(where: { $0.name == "for" })?.value == "site", q.first(where: { $0.name == "app" }) == nil else { return nil }
    let next = q.first(where: { $0.name == "next" })?.value ?? "/"
    // only a path on this site (the server checks it again): never another site
    let back = next.hasPrefix("/") && !next.hasPrefix("//") && !next.contains("\\") ? next : "/"
    return (provider, back)
}

/// The sheet's address: the same start, as an app's sign-in with this challenge.
func siteSignInURL(provider: String, site: URL, back: String, challenge: String) -> URL {
    var parts = URLComponents(url: URL(string: "/api/account/login/\(provider)", relativeTo: site)!.absoluteURL, resolvingAgainstBaseURL: false)!
    parts.queryItems = [URLQueryItem(name: "for", value: "site"), URLQueryItem(name: "app", value: "1"),
                        URLQueryItem(name: "challenge", value: challenge), URLQueryItem(name: "next", value: back)]
    return parts.url!
}

/// creatortoolset://signin?code= or ?error=: the code, or the site's words for why not.
func siteSignInResult(_ url: URL) -> Result<String, SiteSignInError>? {
    guard url.scheme?.lowercased() == "creatortoolset", url.host?.lowercased() == "signin",
          let q = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
    if let code = q.first(where: { $0.name == "code" })?.value, !code.isEmpty { return .success(code) }
    return .failure(SiteSignInError(message: q.first(where: { $0.name == "error" })?.value ?? "Sign-in failed"))
}

struct SiteSignInError: Error, Equatable { let message: String }

/// The page's own call that swaps the code for the window's session, then goes to `back` (with the error, if any).
func siteSignInScript(code: String, verifier: String, back: String) -> String {
    let body = (try? JSONSerialization.data(withJSONObject: ["code": code, "verifier": verifier])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    let to = (try? JSONSerialization.data(withJSONObject: [back], options: .fragmentsAllowed)).map { String(decoding: $0, as: UTF8.self) } ?? "[\"/\"]"
    return """
    (async () => {
      const back = \(to)[0];
      try {
        const r = await fetch("/api/auth/app", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(\(body)) });
        if (r.ok) return location.replace(back);
        const d = await r.json().catch(() => ({}));
        location.replace(back + (back.includes("?") ? "&" : "?") + "error=" + encodeURIComponent(d.error || "Sign-in failed"));
      } catch { location.replace(back); }
    })();
    """
}

/// Runs one site sign-in at a time in the system's sheet, over the window.
@MainActor
final class SiteSignIn: NSObject, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?
    var window: () -> NSWindow? = { nil }

    /// `run(script)` is the window's page; `show(back, error)` loads `back` with the error when the sheet failed.
    func start(provider: String, site: URL, back: String, run: @escaping (String) -> Void, show: @escaping (String, String) -> Void) {
        session?.cancel()
        let pair = Pkce.make()
        let sheet = ASWebAuthenticationSession(url: siteSignInURL(provider: provider, site: site, back: back, challenge: pair.challenge),
                                               callbackURLScheme: "creatortoolset") { [weak self] url, error in
            Task { @MainActor in
                self?.session = nil
                if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin { return }
                switch url.flatMap(siteSignInResult) {
                case .success(let code)?: run(siteSignInScript(code: code, verifier: pair.verifier, back: back))
                case .failure(let e)?: show(back, e.message)
                case nil: show(back, error?.localizedDescription ?? "Sign-in failed")
                }
            }
        }
        sheet.presentationContextProvider = self
        session = sheet
        if !sheet.start() { show(back, "The sign-in sheet didn't open") }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { window() ?? NSApp.keyWindow ?? ASPresentationAnchor() }
    }
}
