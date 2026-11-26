// The person's Creator Toolset account, asked for on the first run. The app opens the account server's Apple, Google or
// GitHub sign-in in the system's sign-in sheet; the server ends on creatortoolset://account?code=<one-time code>, the
// app swaps the code for a token (POST /api/account/token) and keeps it in the Keychain. The account's name and email
// go to the server on this Mac as its owner's profile. An empty account server (This Mac) means no account step.
import AppKit
import AuthenticationServices
import CryptoKit
import Foundation

/// The optional account server for the first run's Apple or Google sign-in, when none is set. It has nothing to do with
/// which server the window opens (Servers.swift has no default).
let defaultAccountServer = URL(string: "https://creatortoolset.com")!

/// The sign-in providers the account server can offer, in the order the first run shows them. A provider the server has
/// no keys for is not offered (its sign-in page answers 404 or 501), so its button is not shown.
let accountProviders = ["apple", "google", "github"]

/// The sign-ins the default account server offers, in the order setup's last screen shows them. A fixed list, so a
/// signed-out person's status asks that server nothing and the app makes no call there before a press. A provider is
/// listed only once the server has its keys (Google and Apple since 2026-11-11, GitHub since 2026-11-12). Empty = no
/// account screen in setup.
let accountLive = ["google", "apple", "github"]

/// The account server from This Mac → Account: never set = defaultAccountServer; "" = none (forks, own servers).
func accountServerURL(_ saved: String?) -> URL? {
    guard let saved else { return defaultAccountServer }
    return saved.trimmingCharacters(in: .whitespaces).isEmpty ? nil : siteURL(from: saved)
}

/// creatortoolset://connect: the site's "Added" page (a computer approved with a device code, e.g. Linux's
/// `creatortoolset connect`) handing back to the app. It only brings the window forward; never loaded as a page.
func isConnectDone(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "creatortoolset" && url.host?.lowercased() == "connect"
}

/// The one-time code from creatortoolset://account?code=…, or nil for any other link.
func accountCode(from url: URL) -> String? {
    guard url.scheme?.lowercased() == "creatortoolset", url.host?.lowercased() == "account",
          let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value,
          !code.isEmpty else { return nil }
    return code
}

/// The account server's words from creatortoolset://account?error=… (a sign-in it turned down), or nil.
func accountError(from url: URL) -> String? {
    guard url.scheme?.lowercased() == "creatortoolset", url.host?.lowercased() == "account" else { return nil }
    return URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "error" })?.value
}

/// A sign-in linked to the account after it was made: its provider and the email it has there.
struct AccountLogin: Codable, Equatable {
    let provider: String
    let email: String
}

struct AccountProfile: Codable, Equatable {
    let name: String
    /// "" when the server has no verified email for the account (Google sends one only when it verified it).
    let email: String
    /// The sign-in the account was made with ("" from a server from before it said), and the ones linked to it.
    var provider = ""
    var logins: [AccountLogin] = []

    init(name: String, email: String, provider: String = "", logins: [AccountLogin] = []) {
        self.name = name
        self.email = email
        self.provider = provider
        self.logins = logins
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        email = try c.decodeIfPresent(String.self, forKey: .email) ?? ""
        provider = try c.decodeIfPresent(String.self, forKey: .provider) ?? ""
        logins = (try? c.decodeIfPresent([AccountLogin].self, forKey: .logins)) ?? []
    }
}

/// A PKCE pair: the app keeps `verifier` (32 random bytes, base64url, 43 chars) and sends `challenge`
/// (base64url of its SHA-256) when it starts a sign-in, so only this app can redeem the code that sign-in ends with.
struct Pkce {
    let verifier: String
    let challenge: String

    init(verifier: String) {
        self.verifier = verifier
        challenge = base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func make() -> Pkce {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Pkce(verifier: base64url(Data(bytes)))
    }
}

func base64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
        .replacingOccurrences(of: "=", with: "")
}

enum AccountError: LocalizedError, Equatable {
    /// The server has no sign-in yet (404 or 501).
    case notSetUp
    /// The code was used already or expired: the server's own words when it gave some.
    case codeRejected(String)
    case signedOut
    case status(Int)
    /// The catalog said no to a pack (publish): its own words.
    case refused(String)

    var errorDescription: String? {
        switch self {
        case .notSetUp: return "Sign-in isn't set up on the account server yet."
        case .codeRejected(let why): return "That sign-in didn't go through (\(why)). Sign in again."
        case .signedOut: return "Signed out. Sign in again."
        case .status(let code): return "The account server answered \(code)."
        case .refused(let why): return why
        }
    }
}

/// The account server's API. `session` is swapped for a stub in the tests.
struct AccountClient {
    let server: URL
    var session: URLSession = .shared
    /// This Mac's key (`DPoPKey.shared` in the app): a sign-in binds the token to it, and a token bound to it goes out
    /// as `DPoP` with its proof. Nil: plain Bearer tokens, as before binding.
    var key: DPoPKey? = nil

    /// The token on a request: `DPoP` with this key's proof once it is bound to it, else a plain Bearer.
    private func authorize(_ request: inout URLRequest, _ token: String) throws {
        guard let key, BoundTokens.contains(token), let url = request.url else {
            return request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        request.setValue("DPoP \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(try DPoP.proof(method: request.httpMethod ?? "GET", url: url, accessToken: token, key: key), forHTTPHeaderField: "DPoP")
    }

    /// `link`: a ticket from linkStart, so this sign-in joins the account that asked for it.
    func loginURL(_ provider: String, challenge: String, link: String? = nil) -> URL {
        let extra = link.flatMap { $0.addingPercentEncoding(withAllowedCharacters: .alphanumerics) }.map { "&link=\($0)" } ?? ""
        return URL(string: "/api/account/login/\(provider)?app=1&challenge=\(challenge)\(extra)", relativeTo: server)!.absoluteURL
    }

    /// POST /api/account/link-start with the token: a one-time ticket that adds the next sign-in to this account.
    func linkStart(_ token: String) async throws -> String {
        var request = URLRequest(url: URL(string: "/api/account/link-start", relativeTo: server)!)
        request.httpMethod = "POST"
        try authorize(&request, token)
        struct Reply: Decodable { let link: String }
        let reply: Reply = try await send(request)
        return reply.link
    }

    /// DELETE /api/account/logins/<provider> with the token: drops a linked sign-in; the account as it is now.
    func unlink(_ provider: String, token: String) async throws -> AccountProfile {
        var request = URLRequest(url: URL(string: "/api/account/logins/\(provider)", relativeTo: server)!)
        request.httpMethod = "DELETE"
        try authorize(&request, token)
        return try await send(request)
    }

    /// The providers whose sign-in the server has set up, in `accountProviders` order.
    func offeredProviders() async throws -> [String] {
        var up: [String] = []
        for p in accountProviders {
            if try await isSetUp(p) { up.append(p) }
        }
        return up
    }

    /// Whether the server's sign-in is set up: only its redirect to Apple, Google or GitHub says yes. Anything else (404, 501, a
    /// sign-in page that wants a site login, a fork's app page) = not yet, so the step lets the person go on.
    func isSetUp(_ provider: String) async throws -> Bool {
        // the server refuses a sign-in start without a challenge, so the probe sends a throwaway one
        var request = URLRequest(url: loginURL(provider, challenge: Pkce.make().challenge))
        request.timeoutInterval = 10
        let (_, response) = try await session.data(for: request, delegate: NoRedirects())
        return (300..<400).contains((response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    /// POST {code, verifier} → {token, name, email}. The code works once, soon expires, and only with the verifier of
    /// the sign-in that made it.
    func exchange(_ code: String, verifier: String) async throws -> (token: String, profile: AccountProfile) {
        var request = URLRequest(url: URL(string: "/api/account/token", relativeTo: server)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // `app`: the server keeps which app a binding is (signing the phones out leaves the Mac's)
        request.httpBody = try JSONEncoder().encode(["code": code, "verifier": verifier].merging(key == nil ? [:] : ["app": "mac"]) { a, _ in a })
        if let key, let url = request.url { request.setValue(try DPoP.proof(method: "POST", url: url, key: key), forHTTPHeaderField: "DPoP") }
        struct Reply: Decodable { let token: String; let bound: Bool? }
        let data = try await sendData(request)
        let reply = try JSONDecoder().decode(Reply.self, from: data)
        // only the server says it bound the token: one from before binding ignores the proof and keeps it plain
        if key != nil, reply.bound == true { BoundTokens.add(reply.token) }
        return (reply.token, try JSONDecoder().decode(AccountProfile.self, from: data))
    }

    /// POST /api/account/sign-out with the token: the server ends it. Best effort, no answer.
    func signOut(_ token: String) async {
        var request = URLRequest(url: URL(string: "/api/account/sign-out", relativeTo: server)!)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = false
        guard (try? authorize(&request, token)) != nil else { return }
        _ = try? await session.data(for: request)
    }

    enum Binding { case bound, refused, later }

    /// POST /api/account/bind: a plain token from an app before binding is bound to this Mac's key, once. `refused`:
    /// the server no longer takes plain tokens (403) or this token (401), so the person signs in again; `later`:
    /// offline, an older server, or no key here, and the token stays plain.
    func bind(_ token: String) async -> Binding {
        guard let key else { return .later }
        var request = URLRequest(url: URL(string: "/api/account/bind", relativeTo: server)!)
        request.httpMethod = "POST"
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = false
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let proof = try? DPoP.proof(method: "POST", url: request.url!, accessToken: token, key: key) else { return .later }
        request.setValue(proof, forHTTPHeaderField: "DPoP")
        guard let (_, response) = try? await session.data(for: request) else { return .later }
        switch (response as? HTTPURLResponse)?.statusCode ?? 0 {
        case 200..<300: BoundTokens.add(token); return .bound
        case 401, 403: return .refused   // 401: the server no longer knows it (ended, or bound by someone else first)
        default: return .later
        }
    }

    /// GET /api/account/me with the token: who it signs in as. 401 = the token no longer works.
    func me(_ token: String) async throws -> AccountProfile {
        var request = URLRequest(url: URL(string: "/api/account/me", relativeTo: server)!)
        try authorize(&request, token)
        return try await send(request)
    }

    /// POST /api/account/relay-token with the token: a short token the connect service (the broker) trusts for this
    /// account, and its life in seconds when the server says. The account server mints it; this Mac's own token never
    /// goes to the broker.
    func relayToken(_ token: String) async throws -> (token: String, expiresIn: TimeInterval?) {
        var request = URLRequest(url: URL(string: "/api/account/relay-token", relativeTo: server)!)
        request.httpMethod = "POST"
        try authorize(&request, token)
        struct Reply: Decodable { let token: String; let expiresIn: TimeInterval? }
        let reply: Reply = try await send(request)
        return (reply.token, reply.expiresIn)
    }

    /// POST /api/account-signin/app-ticket with the token: a one-time ticket for `host`, a server the account signed in
    /// to through this account server, bound to this Mac's key and to `challenge`. The account server answers only a token
    /// bound to this key at its sign-in, and refuses a server the account never signed in to.
    func appTicket(_ token: String, host: String, challenge: String) async throws -> String {
        var request = URLRequest(url: URL(string: "/api/account-signin/app-ticket", relativeTo: server)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        try authorize(&request, token)
        request.httpBody = try JSONSerialization.data(withJSONObject: ["host": host, "challenge": challenge])
        struct Reply: Decodable { let ticket: String }
        let reply: Reply = try await send(request)
        return reply.ticket
    }

    /// POST a pack to the community catalog on this account server, as the account the token signs in as (`body` is
    /// {pack, rights}). It waits there for an admin's review. 401 = signed out; any other no is the catalog's own words.
    func submit(_ body: Data, token: String) async throws {
        var request = URLRequest(url: URL(string: "/api/pack-catalog/submit", relativeTo: server)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        try authorize(&request, token)
        request.httpBody = body
        struct Reply: Decodable { let status: String }
        let _: Reply = try await send(request)
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await sendData(request))
    }

    private func sendData(_ request: URLRequest) async throws -> Data {
        var request = request
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = false
        let (data, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch code {
        case 200..<300: return data
        case 401 where request.url?.path == "/api/account/me" || request.url?.path == "/api/pack-catalog/submit": throw AccountError.signedOut
        case 400..<500 where request.url?.path == "/api/pack-catalog/submit":
            throw AccountError.refused((try? JSONDecoder().decode([String: AnyText].self, from: data))?["error"]?.text ?? "The catalog answered \(code).")
        // "not set up" is only the sign-in page's answer (isSetUp): past it, a 404 is a code the server doesn't know
        case 400..<500:
            let why = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw AccountError.codeRejected(why ?? "the server answered \(code)")
        default: throw AccountError.status(code)
        }
    }
}

/// One value of a JSON object read as text when it is text (the catalog's error replies carry lists beside the words).
struct AnyText: Decodable {
    let text: String?
    init(from decoder: Decoder) throws { text = try? decoder.singleValueContainer().decode(String.self) }
}

/// Keeps a probe from following the server's redirect to Apple or Google.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}

/// The window's own sign-in through the account, as a server takes it (POST /api/auth/account-ticket, api/auth-clients.ts):
/// the account's ticket for that server and its verifier as JSON, what this Mac is called for the server's list, and this
/// key's proof for the request. The answer's cookie is the window's: this app's own cookie jar never keeps it.
func accountTicketRequest(base: URL, ticket: String, verifier: String, key: DPoPKey, name: String, version: String) throws -> URLRequest {
    let url = URL(string: "/api/auth/account-ticket", relativeTo: base)!.absoluteURL
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpShouldHandleCookies = false
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(try DPoP.proof(method: "POST", url: url, key: key), forHTTPHeaderField: "DPoP")
    let client = ["label": name, "os": "macOS", "appVersion": version]
    request.httpBody = try JSONSerialization.data(withJSONObject: ["ticket": ticket, "verifier": verifier, "client": client])
    return request
}

/// The page's account message: "status" or "offered" (the same question; setup's account screen and Settings ask
/// "offered", which an app from before 2026-11-10 answers "off" without asking its server which sign-ins exist),
/// "signout", "apple", "google" or "github", "link:<provider>" (add that sign-in to the account) or "unlink:<provider>",
/// "window" (the sign-in page of a server: sign this window in through the account, Shell.signInWithAccount),
/// and only from the window's own page, never from a frame inside it (an embed would read the name and email, open a
/// sign-in or sign the person out).
func accountAsk(_ body: Any, mainFrame: Bool) -> String? {
    guard mainFrame, let ask = body as? String else { return nil }
    let provider = ask.hasPrefix("link:") ? String(ask.dropFirst(5)) : ask.hasPrefix("unlink:") ? String(ask.dropFirst(7)) : ask
    guard ["status", "offered", "signout", "window"].contains(ask) || accountProviders.contains(provider) else { return nil }
    return ask
}

// MARK: publishing a pack to Community

/// A pack the page asks to publish (PublishDialog.tsx, the "publishPack" message), read by this app itself: the body
/// to send ({pack, rights}), its name, and what it holds, for the alert. The alert's words come from the pack, never from
/// the page. Nil for anything that is not a JSON object with a name, or is over 512 KB.
func packToPublish(_ text: String) -> (body: Data, name: String, holds: String)? {
    guard text.utf8.count <= 512 * 1024, let data = text.data(using: .utf8),
          let pack = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
          // the name goes in the alert's title: one line, no control characters
          let name = (pack["name"] as? String)?.components(separatedBy: .controlCharacters).joined(separator: " ")
              .trimmingCharacters(in: .whitespaces), !name.isEmpty,
          let body = try? JSONSerialization.data(withJSONObject: ["pack": pack, "rights": true]) else { return nil }
    func count(_ key: String) -> Int { (pack[key] as? [Any])?.count ?? (pack[key] as? [String: Any])?.count ?? 0 }
    let kinds = [("instructions", "instruction", "instructions"), ("frameworks", "framework", "frameworks"),
                 ("captionStyles", "caption style", "caption styles"), ("designSystems", "design system", "design systems"),
                 ("grades", "colour grade", "colour grades"), ("voiceMixes", "voice mix", "voice mixes"),
                 ("sfxSets", "sound set", "sound sets"), ("resolve", "Resolve setting", "Resolve settings"),
                 ("skills", "skill", "skills")]
    var parts = kinds.compactMap { key, one, many -> String? in
        let n = count(key)
        return n == 0 ? nil : n == 1 ? "1 \(one)" : "\(n) \(many)"
    }
    if pack["home"] is [String: Any] { parts.append("a Home layout") }
    if pack["editorDefaults"] is [String: Any] { parts.append("editor defaults") }
    return (body, String(name.prefix(80)), parts.isEmpty ? "nothing" : parts.joined(separator: ", "))
}

/// The alert before a pack leaves this Mac. It is this app's own alert because the ask comes from the page, where a
/// plug-in's pages run too: only a click on Publish sends it.
func publishAlertText(name: String, holds: String, host: String, who: String) -> (message: String, detail: String) {
    ("Publish “\(name)” to Community?",
     "It goes to \(host) for review, from your account\(who.isEmpty ? "" : " \(who)"). It holds: \(holds).")
}

/// What the page's account step is told (AccountStep.tsx): state signedIn / signedOut / notSetUp / off / cancelled /
/// unreachable / error, with the name, email, server or message that goes with it.
typealias AccountReply = [String: String]

/// The sign-in flow and the stored account: the token in the Keychain, the profile in UserDefaults, both per server.
@MainActor
final class Account: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let vault = AppIdentity.keychain("account")
    private let serverKey = "accountServer"
    /// Where the sign-in sheet sits, and what to do with a new profile (the server on this Mac takes it).
    var window: () -> NSWindow? = { nil }
    var signedIn: (AccountProfile) -> Void = { _ in }
    /// Called with the old token before it is replaced by another account's (`new`) or removed (nil): this Mac leaves
    /// the account it is linked to while it still can (Shell.leaveAccount).
    var leaving: (_ old: String, _ new: String?) async -> Void = { _, _ in }
    private var session: ASWebAuthenticationSession?
    private var pending: ((AccountReply) -> Void)?
    /// The verifier of the sign-in in flight: a code is swapped only with it.
    private var pkce: Pkce?
    /// The provider of the sign-in in flight, kept with the account once it goes through.
    private var signingInWith = ""
    private var bindTried = false

    var server: URL? { accountServerURL(UserDefaults.standard.string(forKey: serverKey)) }
    /// The text This Mac shows ("" when off).
    var serverText: String { server?.absoluteString ?? "" }

    func setServer(_ text: String) {
        UserDefaults.standard.set(text.trimmingCharacters(in: .whitespaces), forKey: serverKey)
    }

    private var host: String { server?.host ?? "" }
    private var profileKey: String { "accountProfile.\(host)" }

    var profile: AccountProfile? {
        guard DeviceVault.token(for: host, service: Self.vault) != nil,
              let data = UserDefaults.standard.data(forKey: profileKey) else { return nil }
        return try? JSONDecoder().decode(AccountProfile.self, from: data)
    }

    /// Which sign-in this Mac's account was made with ("google", "apple"…), kept beside the profile so Settings can show
    /// its mark; "" for a sign-in from before this was kept.
    private var providerKey: String { "accountProvider.\(host)" }

    private func reply(_ profile: AccountProfile) -> AccountReply {
        var reply = ["state": "signedIn", "name": profile.name, "email": profile.email]
        let provider = profile.provider.isEmpty ? UserDefaults.standard.string(forKey: providerKey) ?? "" : profile.provider
        if !provider.isEmpty { reply["provider"] = provider }
        // the linked sign-ins: "github,apple", each one's email as login.<provider>
        reply["logins"] = profile.logins.map(\.provider).joined(separator: ",")
        for l in profile.logins { reply["login.\(l.provider)"] = l.email }
        return reply
    }

    private func reply(_ error: Error) -> AccountReply {
        if error as? AccountError == .notSetUp { return ["state": "notSetUp", "server": host] }
        if error as? AccountError == .signedOut { return ["state": "signedOut"] }
        return ["state": "error", "message": error.localizedDescription]
    }

    /// Signed in (the token checked with the server when it answers), signed out, or why there is no sign-in.
    func status() async -> AccountReply {
        guard let server else { return ["state": "off"] }
        let client = AccountClient(server: server, key: DPoPKey.shared)
        if let token = await token() {
            do {
                let fresh = try await client.me(token)
                keep(fresh)
                // the sign-ins on offer too, so Settings can link one more to the account
                var signedIn = reply(fresh)
                if let up = try? await offered(client) { signedIn["providers"] = up.joined(separator: ",") }
                return signedIn
            } catch AccountError.signedOut {
                ended()
            } catch {
                if let profile { return reply(profile) }   // offline: the account it had
            }
        }
        do {
            let up = try await offered(client)
            if up.isEmpty { return ["state": "notSetUp", "server": host] }
            // the sign-in ended on the account's side, not by a press here: said until the person signs in again
            if UserDefaults.standard.bool(forKey: endedKey) {
                return ["state": "error", "message": "Your sign-in ended. Sign in again.", "providers": up.joined(separator: ",")]
            }
            return ["state": "signedOut", "providers": up.joined(separator: ",")]
        } catch {
            return unreachable(error)
        }
    }

    /// The sign-ins a signed-out person is offered. The default account server is asked nothing (accountLive); a server
    /// the person set themselves (This Mac → Account) is theirs, so it is asked which of its sign-ins are set up.
    private func offered(_ client: AccountClient) async throws -> [String] {
        server?.absoluteString == defaultAccountServer.absoluteString ? accountLive : try await client.offeredProviders()
    }

    private var endedKey: String { "accountEnded.\(host)" }

    /// The account server ended this Mac's token (it no longer takes it, or a copy of it was used elsewhere): it goes
    /// from here, and the account step says "Sign in again" until the person does.
    private func ended() {
        AppLog.write("the account server ended this Mac's sign-in: it asks to sign in again")
        DeviceVault.remove(for: host, service: Self.vault)
        UserDefaults.standard.removeObject(forKey: profileKey)
        UserDefaults.standard.removeObject(forKey: providerKey)
        UserDefaults.standard.set(true, forKey: endedKey)
    }

    /// The stored token. One from an app before binding is bound to this Mac's key first, quietly, once a launch.
    /// A server that no longer takes plain tokens, or no longer knows this one, ends the sign-in here, so the app asks
    /// for it again. Offline or an older server: it stays plain and is tried again next launch.
    func token() async -> String? {
        guard let server, let token = DeviceVault.token(for: host, service: Self.vault) else { return nil }
        guard !bindTried, !BoundTokens.contains(token), DPoPKey.shared != nil else { return token }
        bindTried = true
        switch await AccountClient(server: server, key: DPoPKey.shared).bind(token) {
        case .bound, .later: return token
        case .refused:
            ended()
            return nil
        }
    }

    /// Sign out: the token leaves the Keychain and the kept name and email go with it. The name this Mac's own server
    /// shows stays as it is. Answers as `status` does for a signed-out person.
    func signOut() async -> AccountReply {
        session?.cancel()
        session = nil
        answer(["state": "cancelled"])
        pkce = nil
        if let old = DeviceVault.token(for: host, service: Self.vault) {
            await leaving(old, nil)
            // the account server forgets the token too (best effort: offline, it is still gone from this Mac)
            if let server { await AccountClient(server: server, key: DPoPKey.shared).signOut(old) }
        }
        DeviceVault.remove(for: host, service: Self.vault)
        UserDefaults.standard.removeObject(forKey: profileKey)
        UserDefaults.standard.removeObject(forKey: providerKey)
        UserDefaults.standard.removeObject(forKey: endedKey)
        return await status()
    }

    /// Drops a linked sign-in from the account (Settings → Account → Connected accounts).
    func unlink(_ provider: String) async -> AccountReply {
        guard let server else { return ["state": "off"] }
        guard let token = DeviceVault.token(for: host, service: Self.vault) else { return ["state": "signedOut"] }
        do {
            let fresh = try await AccountClient(server: server, key: DPoPKey.shared).unlink(provider, token: token)
            keep(fresh)
            return reply(fresh)
        } catch {
            return reply(error)
        }
    }

    /// "Continue with Apple" / "Google" / "GitHub": the server's sign-in in the system sheet, then the code exchange.
    /// `link`: signed in already, this sign-in is added to the same account (a ticket from the server first).
    /// `done` is called exactly once.
    func signIn(_ provider: String, link: Bool = false, done: @escaping (AccountReply) -> Void) {
        guard let server else { return done(["state": "off"]) }
        guard accountProviders.contains(provider) else { return done(["state": "error", "message": "Unknown sign-in."]) }
        let token = DeviceVault.token(for: host, service: Self.vault)
        if link && token == nil { return done(["state": "signedOut"]) }
        session?.cancel()
        pending?(["state": "cancelled"])
        pending = done
        // a link keeps the sign-in the account was made with as its provider
        signingInWith = link ? (UserDefaults.standard.string(forKey: providerKey) ?? "") : provider
        let pair = Pkce.make()
        pkce = pair
        Task { () -> Void in
            let client = AccountClient(server: server, key: DPoPKey.shared)
            var ticket: String?
            // a later sign-in or a sign-out during the checks took this one's place and answered it: nothing more from here
            let current = { self.pkce?.verifier == pair.verifier }
            do {
                let up = try await client.isSetUp(provider)
                guard current() else { return }
                guard up else { answer(reply(AccountError.notSetUp)); return }
                if link, let token { ticket = try await client.linkStart(token) }
                guard current() else { return }
            } catch {
                if current() { answer(link ? reply(error) : unreachable(error)) }
                return
            }
            let sheet = ASWebAuthenticationSession(url: client.loginURL(provider, challenge: pair.challenge, link: ticket), callbackURLScheme: "creatortoolset") { [weak self] url, error in
                Task { @MainActor in
                    guard let self else { return }
                    self.session = nil
                    if let url, let code = accountCode(from: url) {
                        await self.finish(code: code)
                    } else if let url, let why = accountError(from: url) {
                        self.pkce = nil
                        self.answer(["state": "error", "message": why])
                    } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        self.answer(["state": "cancelled"])
                    } else {
                        self.answer(["state": "error", "message": error?.localizedDescription ?? "The sign-in didn't finish."])
                    }
                }
            }
            sheet.presentationContextProvider = self
            session = sheet
            if !sheet.start() { answer(["state": "error", "message": "The sign-in sheet didn't open."]) }
        }
    }

    /// Publish a pack to Community with this Mac's account: this app's alert names the pack, what it holds and the
    /// account; only a click on Publish sends it, with the token, to the account server (never to an address the page
    /// names). `done` once: sent, signedOut, cancelled, off, or error with the catalog's words.
    func publish(_ text: String, done: @escaping (AccountReply) -> Void) {
        guard let server else { return done(["state": "off"]) }
        guard let token = DeviceVault.token(for: host, service: Self.vault) else { return done(["state": "signedOut"]) }
        guard let pack = packToPublish(text) else { return done(["state": "error", "message": "That isn't a pack this app can read."]) }
        let who = profile.map { $0.email.isEmpty ? $0.name : $0.email } ?? ""
        let words = publishAlertText(name: pack.name, holds: pack.holds, host: host, who: who)
        let alert = pluginAlert(message: words.message, detail: words.detail, agree: "Publish")
        let answer: (NSApplication.ModalResponse) -> Void = { response in
            guard response == .alertSecondButtonReturn else { return done(["state": "cancelled"]) }
            Task { @MainActor in
                do {
                    try await AccountClient(server: server, key: DPoPKey.shared).submit(pack.body, token: token)
                    done(["state": "sent"])
                } catch AccountError.signedOut {
                    // the token still signs in: it is the catalog that doesn't take packs from the app (a site from
                    // before it could), not a sign-out
                    if (try? await AccountClient(server: server, key: DPoPKey.shared).me(token)) != nil {
                        done(["state": "error", "message": "\(self.host) doesn't take packs from the app yet. Download the file and send it on the catalog's site."])
                    } else {
                        done(["state": "signedOut"])
                    }
                } catch {
                    done(["state": "error", "message": error.localizedDescription])
                }
            }
        }
        if let w = window() { alert.beginSheetModal(for: w, completionHandler: answer) } else { answer(alert.runModal()) }
    }

    /// Offline or the account server is down: the step may be passed (it asks again next time), with a retry.
    private func unreachable(_ error: Error) -> AccountReply {
        ["state": "unreachable", "server": host, "message": "Can't reach \(host): \(error.localizedDescription)"]
    }

    /// A creatortoolset://account link handed to the app: swapped only while this app has a sign-in of its own in
    /// flight. Any other link is someone else's code (it would sign this Mac in to their account), so it is refused.
    @discardableResult
    func link(code: String) async -> AccountReply {
        guard pending != nil, pkce != nil else { return ["state": "error", "message": "That sign-in link didn't come from this app. Sign in from the app."] }
        session?.cancel()
        session = nil
        return await finish(code: code)
    }

    /// A one-time code, from the sheet or a creatortoolset://account link: swapped once for the token.
    @discardableResult
    private func finish(code: String) async -> AccountReply {
        guard let server else { return answer(["state": "off"]) }
        guard let pair = pkce else { return answer(["state": "error", "message": "No sign-in is in progress. Sign in from the app."]) }
        pkce = nil   // one try per sign-in: the server burns the code on a wrong verifier anyway
        do {
            let (token, profile) = try await AccountClient(server: server, key: DPoPKey.shared).exchange(code, verifier: pair.verifier)
            if let old = DeviceVault.token(for: host, service: Self.vault), old != token { await leaving(old, token) }
            guard DeviceVault.save(token, for: host, service: Self.vault) else {
                return answer(["state": "error", "message": "The Keychain didn't keep the sign-in."])
            }
            UserDefaults.standard.set(signingInWith, forKey: providerKey)
            UserDefaults.standard.removeObject(forKey: endedKey)
            keep(profile)
            return answer(reply(profile))
        } catch {
            return answer(reply(error))
        }
    }

    private func keep(_ profile: AccountProfile) {
        UserDefaults.standard.set(try? JSONEncoder().encode(profile), forKey: profileKey)
        signedIn(profile)
    }

    @discardableResult
    private func answer(_ reply: AccountReply) -> AccountReply {
        pending?(reply)
        pending = nil
        return reply
    }

    /// Asked on the main thread.
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated { window() ?? NSApp.keyWindow ?? ASPresentationAnchor() }
    }
}
