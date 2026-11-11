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
/// listed only once the server has its keys (Google and Apple since 2026-11-11). Empty = no account screen in setup.
let accountLive = ["google", "apple"]

/// The account server from This Mac → Account: never set = defaultAccountServer; "" = none (forks, own servers).
func accountServerURL(_ saved: String?) -> URL? {
    guard let saved else { return defaultAccountServer }
    return saved.trimmingCharacters(in: .whitespaces).isEmpty ? nil : siteURL(from: saved)
}

/// The one-time code from creatortoolset://account?code=…, or nil for any other link.
func accountCode(from url: URL) -> String? {
    guard url.scheme?.lowercased() == "creatortoolset", url.host?.lowercased() == "account",
          let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value,
          !code.isEmpty else { return nil }
    return code
}

struct AccountProfile: Codable, Equatable {
    let name: String
    /// "" when the server has no verified email for the account (Google sends one only when it verified it).
    let email: String

    init(name: String, email: String) {
        self.name = name
        self.email = email
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        email = try c.decodeIfPresent(String.self, forKey: .email) ?? ""
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

    var errorDescription: String? {
        switch self {
        case .notSetUp: return "Sign-in isn't set up on the account server yet."
        case .codeRejected(let why): return "That sign-in didn't go through (\(why)). Sign in again."
        case .signedOut: return "Signed out. Sign in again."
        case .status(let code): return "The account server answered \(code)."
        }
    }
}

/// The account server's API. `session` is swapped for a stub in the tests.
struct AccountClient {
    let server: URL
    var session: URLSession = .shared

    func loginURL(_ provider: String, challenge: String) -> URL {
        URL(string: "/api/account/login/\(provider)?app=1&challenge=\(challenge)", relativeTo: server)!.absoluteURL
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
        request.httpBody = try JSONEncoder().encode(["code": code, "verifier": verifier])
        struct Reply: Decodable { let token: String; let name: String; let email: String? }
        let reply: Reply = try await send(request)
        return (reply.token, AccountProfile(name: reply.name, email: reply.email ?? ""))
    }

    /// GET /api/account/me with the token: who it signs in as. 401 = the token no longer works.
    func me(_ token: String) async throws -> AccountProfile {
        var request = URLRequest(url: URL(string: "/api/account/me", relativeTo: server)!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try await send(request)
    }

    /// POST /api/account/relay-token with the token: a short token the connect service (the broker) trusts for this
    /// account. The account server mints it; this Mac's own token never goes to the broker.
    func relayToken(_ token: String) async throws -> String {
        var request = URLRequest(url: URL(string: "/api/account/relay-token", relativeTo: server)!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        struct Reply: Decodable { let token: String }
        let reply: Reply = try await send(request)
        return reply.token
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        var request = request
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = false
        let (data, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        switch code {
        case 200..<300: return try JSONDecoder().decode(T.self, from: data)
        case 401 where request.url?.path == "/api/account/me": throw AccountError.signedOut
        // "not set up" is only the sign-in page's answer (isSetUp): past it, a 404 is a code the server doesn't know
        case 400..<500:
            let why = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw AccountError.codeRejected(why ?? "the server answered \(code)")
        default: throw AccountError.status(code)
        }
    }
}

/// Keeps a probe from following the server's redirect to Apple or Google.
private final class NoRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}

/// The page's account message: "status" or "offered" (the same question; setup's account screen and Settings ask
/// "offered", which an app from before 2026-11-10 answers "off" without asking its server which sign-ins exist),
/// "signout", "apple", "google" or "github", and only from the window's own page, never from a frame inside it (an
/// embed would read the name and email, open a sign-in or sign the person out).
func accountAsk(_ body: Any, mainFrame: Bool) -> String? {
    guard mainFrame, let ask = body as? String, ["status", "offered", "signout"].contains(ask) || accountProviders.contains(ask) else { return nil }
    return ask
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
    private var session: ASWebAuthenticationSession?
    private var pending: ((AccountReply) -> Void)?
    /// The verifier of the sign-in in flight: a code is swapped only with it.
    private var pkce: Pkce?
    /// The provider of the sign-in in flight, kept with the account once it goes through.
    private var signingInWith = ""

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
        if let provider = UserDefaults.standard.string(forKey: providerKey), !provider.isEmpty { reply["provider"] = provider }
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
        let client = AccountClient(server: server)
        if let token = DeviceVault.token(for: host, service: Self.vault) {
            do {
                let fresh = try await client.me(token)
                keep(fresh)
                return reply(fresh)
            } catch AccountError.signedOut {
                DeviceVault.remove(for: host, service: Self.vault)
            } catch {
                if let profile { return reply(profile) }   // offline: the account it had
            }
        }
        do {
            let up = try await offered(client)
            return up.isEmpty ? ["state": "notSetUp", "server": host] : ["state": "signedOut", "providers": up.joined(separator: ",")]
        } catch {
            return unreachable(error)
        }
    }

    /// The sign-ins a signed-out person is offered. The default account server is asked nothing (accountLive); a server
    /// the person set themselves (This Mac → Account) is theirs, so it is asked which of its sign-ins are set up.
    private func offered(_ client: AccountClient) async throws -> [String] {
        server?.absoluteString == defaultAccountServer.absoluteString ? accountLive : try await client.offeredProviders()
    }

    /// Sign out: the token leaves the Keychain and the kept name and email go with it. The name this Mac's own server
    /// shows stays as it is. Answers as `status` does for a signed-out person.
    /// ponytail: the token is only forgotten here; call the account server's revoke when it has one.
    func signOut() async -> AccountReply {
        session?.cancel()
        session = nil
        answer(["state": "cancelled"])
        pkce = nil
        DeviceVault.remove(for: host, service: Self.vault)
        UserDefaults.standard.removeObject(forKey: profileKey)
        UserDefaults.standard.removeObject(forKey: providerKey)
        return await status()
    }

    /// "Continue with Apple" / "Google" / "GitHub": the server's sign-in in the system sheet, then the code exchange.
    /// `done` is called exactly once.
    func signIn(_ provider: String, done: @escaping (AccountReply) -> Void) {
        guard let server else { return done(["state": "off"]) }
        guard accountProviders.contains(provider) else { return done(["state": "error", "message": "Unknown sign-in."]) }
        session?.cancel()
        pending?(["state": "cancelled"])
        pending = done
        signingInWith = provider
        let pair = Pkce.make()
        pkce = pair
        Task { () -> Void in
            let client = AccountClient(server: server)
            do {
                guard try await client.isSetUp(provider) else { answer(reply(AccountError.notSetUp)); return }
            } catch {
                answer(unreachable(error))
                return
            }
            let sheet = ASWebAuthenticationSession(url: client.loginURL(provider, challenge: pair.challenge), callbackURLScheme: "creatortoolset") { [weak self] url, error in
                Task { @MainActor in
                    guard let self else { return }
                    self.session = nil
                    if let url, let code = accountCode(from: url) {
                        await self.finish(code: code)
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
            let (token, profile) = try await AccountClient(server: server).exchange(code, verifier: pair.verifier)
            guard DeviceVault.save(token, for: host, service: Self.vault) else {
                return answer(["state": "error", "message": "The Keychain didn't keep the sign-in."])
            }
            UserDefaults.standard.set(signingInWith, forKey: providerKey)
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
