// The person's Creator Toolset account, asked for on the first run. The app opens the account server's Apple or
// Google sign-in in the system's sign-in sheet; the server ends on creatortoolset://account?code=<one-time code>, the
// app swaps the code for a token (POST /api/account/token) and keeps it in the Keychain. The account's name and email
// go to the server on this Mac as its owner's profile. An empty account server (Mac settings) means no account step.
import AppKit
import AuthenticationServices
import Foundation

/// The account server from Mac settings: never set = creatortoolset.com; "" = none (forks, own servers).
func accountServerURL(_ saved: String?) -> URL? {
    guard let saved else { return productionSite }
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
    let email: String
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

    func loginURL(_ provider: String) -> URL {
        URL(string: "/api/account/login/\(provider)?app=1", relativeTo: server)!.absoluteURL
    }

    /// Whether the server's sign-in is set up: 404 or 501 = not yet; anything else (its redirect to Apple or Google) = yes.
    func isSetUp(_ provider: String) async throws -> Bool {
        var request = URLRequest(url: loginURL(provider))
        request.timeoutInterval = 10
        let (_, response) = try await session.data(for: request, delegate: NoRedirects())
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        return code != 404 && code != 501
    }

    /// POST {code} → {token, name, email}. The code works once and soon expires.
    func exchange(_ code: String) async throws -> (token: String, profile: AccountProfile) {
        var request = URLRequest(url: URL(string: "/api/account/token", relativeTo: server)!)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["code": code])
        struct Reply: Decodable { let token: String; let name: String; let email: String }
        let reply: Reply = try await send(request)
        return (reply.token, AccountProfile(name: reply.name, email: reply.email))
    }

    /// GET /api/account/me with the token: who it signs in as. 401 = the token no longer works.
    func me(_ token: String) async throws -> AccountProfile {
        var request = URLRequest(url: URL(string: "/api/account/me", relativeTo: server)!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return try await send(request)
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

/// What the page's account step is told (AccountStep.tsx): state signedIn / signedOut / notSetUp / off / cancelled /
/// error, with the name, email or message that goes with it.
typealias AccountReply = [String: String]

/// The sign-in flow and the stored account: the token in the Keychain, the profile in UserDefaults, both per server.
@MainActor
final class Account: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let vault = "com.creatortoolset.mac.account"
    private let serverKey = "accountServer"
    /// Where the sign-in sheet sits, and what to do with a new profile (the server on this Mac takes it).
    var window: () -> NSWindow? = { nil }
    var signedIn: (AccountProfile) -> Void = { _ in }
    private var session: ASWebAuthenticationSession?
    private var pending: ((AccountReply) -> Void)?

    var server: URL? { accountServerURL(UserDefaults.standard.string(forKey: serverKey)) }
    /// The text Mac settings shows ("" when off).
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

    private func reply(_ profile: AccountProfile) -> AccountReply {
        ["state": "signedIn", "name": profile.name, "email": profile.email]
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
            return try await client.isSetUp("apple") ? ["state": "signedOut"] : ["state": "notSetUp", "server": host]
        } catch {
            return ["state": "error", "message": "Can't reach \(host): \(error.localizedDescription)"]
        }
    }

    /// "Continue with Apple" / "Continue with Google": the server's sign-in in the system sheet, then the code exchange.
    /// `done` is called exactly once.
    func signIn(_ provider: String, done: @escaping (AccountReply) -> Void) {
        guard let server else { return done(["state": "off"]) }
        guard provider == "apple" || provider == "google" else { return done(["state": "error", "message": "Unknown sign-in."]) }
        session?.cancel()
        pending?(["state": "cancelled"])
        pending = done
        Task { () -> Void in
            let client = AccountClient(server: server)
            do {
                guard try await client.isSetUp(provider) else { answer(reply(AccountError.notSetUp)); return }
            } catch {
                answer(["state": "error", "message": "Can't reach \(host): \(error.localizedDescription)"])
                return
            }
            let sheet = ASWebAuthenticationSession(url: client.loginURL(provider), callbackURLScheme: "creatortoolset") { [weak self] url, error in
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

    /// A one-time code, from the sheet or a creatortoolset://account link: swapped once for the token.
    @discardableResult
    func finish(code: String) async -> AccountReply {
        guard let server else { return answer(["state": "off"]) }
        do {
            let (token, profile) = try await AccountClient(server: server).exchange(code)
            guard DeviceVault.save(token, for: host, service: Self.vault) else {
                return answer(["state": "error", "message": "The Keychain didn't keep the sign-in."])
            }
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
