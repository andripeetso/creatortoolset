import AuthenticationServices
import CryptoKit
import SwiftUI

/// The person's Creator Toolset account on this phone: one Sign in with Apple or Google, and the phone knows their
/// computers, so none needs an address typed or a code scanned. The account server is asked nothing before a press on
/// a sign-in button. Its token is kept in the Keychain and goes only to the account server.
@MainActor
final class Account: ObservableObject {
    static let shared = Account()
    static let site = URL(string: "https://creatortoolset.com/")!
    /// The connect service: it lists the computers added to the account and gives a ticket for one.
    static let connectService = URL(string: "https://connect.creatortoolset.com/")!
    static let providers = ["apple", "google"]

    struct Profile: Codable, Equatable {
        var name: String
        var email: String
        /// "apple" or "google": a hosted server is signed in to with the same one.
        var provider: String
        var title: String { !name.isEmpty ? name : !email.isEmpty ? email : "\(provider.capitalized) account" }
    }

    @Published private(set) var profile: Profile?
    private static let addedDidntLoad = "Your other computers didn't load. Pull down to try again."
    private let key = "account"
    private var token: String? { Keychain.get(key) }

    #if DEBUG
    /// `-signinDemo list|none|password|old|add|problem|partly` at launch: a made-up account and its computers, for
    /// simulator screenshots (`add` opens Add a computer from More; `problem` is a sign-in that failed, `partly` a list
    /// whose added computers didn't load). No server is asked anything.
    static let demo = UserDefaults.standard.string(forKey: "signinDemo")
    #endif

    init() {
        if token != nil, let data = UserDefaults.standard.data(forKey: key) {
            profile = try? JSONDecoder().decode(Profile.self, from: data)
        }
        #if DEBUG
        if let demo = Self.demo, demo != "problem" { profile = Profile(name: "Sam Tiny", email: "sam@tinyacrobatics.com", provider: "apple") }
        #endif
    }

    /// A press on Sign in with Apple or Google: the account server's sign-in in the system's sheet, then the one-time
    /// code it ends with swapped for the token. False = the person closed the sheet.
    func signIn(_ provider: String) async throws -> Bool {
        let pkce = Pkce.make()
        let start = Self.loginURL(Self.site, provider, challenge: pkce.challenge)
        // asked first without following it: no connection is said here, not on a page inside the sheet
        guard try await Self.redirects(start) else { throw AccountError.refused("Sign-in isn't set up on creatortoolset.com yet") }
        guard let code = try await WebSheet.shared.open(start, ends: "account") else { return false }
        let data = try await Self.send(Self.site, "/api/account/token", method: "POST",
                                       json: ["code": code, "verifier": pkce.verifier])
        let reply = try JSONDecoder().decode(AccountToken.self, from: data)
        Keychain.set(key, reply.token)
        guard token != nil else { throw AccountError.refused("The Keychain didn't keep the sign-in") }
        keep(Profile(name: reply.name ?? "", email: reply.email ?? "", provider: provider))
        return true
    }

    /// Forgets the account on this phone. The computers already connected stay as they are.
    func signOut() {
        Keychain.set(key, nil)
        UserDefaults.standard.removeObject(forKey: key)
        profile = nil
    }

    /// The account's computers: the hosted servers it signed in to, then the computers added to it. `problem` is said
    /// when the added computers could not be read; the hosted servers still show.
    func computers() async throws -> (list: [Computer], problem: String?) {
        #if DEBUG
        if Self.demo == "partly" { return (Array(Computer.demo.prefix(1)), Self.addedDidntLoad) }
        if let demo = Self.demo { return (demo == "none" ? [] : Computer.demo, nil) }
        #endif
        let me = try JSONDecoder().decode(AccountMe.self, from: try await ask("/api/account/me"))
        keep(Profile(name: me.name ?? "", email: me.email ?? "", provider: profile?.provider ?? ""))
        var added: [AddedComputers.One] = []
        var problem: String?
        do {
            if let relay = try await relayToken(orNone: true) {
                added = try JSONDecoder().decode(AddedComputers.self, from: try await Self.connect("/v1/computers", bearer: relay)).computers
            }
        } catch AccountError.signedOut {
            throw AccountError.signedOut
        } catch {
            problem = Self.addedDidntLoad
        }
        return (Computer.list(hosted: me.servers?.map(\.host) ?? [], added: added), problem)
    }

    /// A hosted server, signed in to with the account's own Apple or Google in a second sheet (the sheets share the
    /// phone's browser sign-ins, so Apple or Google should not ask a second time). Nil = the person closed the sheet;
    /// `.needsPassword` = a server that does not sign in this way, which takes a username and password.
    func signIn(to computer: Computer) async throws -> SignIn.Outcome? {
        guard let provider = profile?.provider, Self.providers.contains(provider) else { return .needsPassword }
        let pkce = Pkce.make()
        let start = Self.loginURL(computer.url, provider, challenge: pkce.challenge, forSite: true)
        // an older server would sign the sheet's own browser in and never come back to the app: asked first
        guard try await Self.reaching(computer.url, { try await SignIn.takesAppSignIn(computer.url) }),
              try await Self.redirects(start) else { return .needsPassword }
        guard let code = try await WebSheet.shared.open(start, ends: "signin") else { return nil }
        return try await Self.reaching(computer.url) { try await SignIn.app(computer.url, code: code, verifier: pkce.verifier) }
    }

    /// A computer added to the account: a ticket from the connect service (it works once, for two minutes, so each try
    /// gets a new one), then the computer's own password.
    func signIn(to computer: Computer, password: String) async throws -> SignIn.Outcome {
        guard let id = computer.addedId, let relay = try await relayToken() else { throw AccountError.signedOut }
        let ticket: String
        do {
            let data = try await Self.connect("/v1/computers/\(id)/ticket", method: "POST", bearer: relay)
            ticket = try JSONDecoder().decode(ComputerTicket.self, from: data).ticket
        } catch APIError.server(404, _) {
            throw AccountError.refused("\(computer.name) is no longer on your account")
        }
        return try await Self.reaching(computer.url) { try await SignIn.ticket(computer.url, ticket: ticket, password: password) }
    }

    /// Takes a hosted server off the account's list. The phone's own sign-in to it stays.
    func forget(_ computer: Computer) async throws {
        do {
            _ = try await ask("/api/account/servers/\(computer.name)", method: "DELETE")
        } catch APIError.server(404, _) {
            // an account server from before the list: nothing to take off
        }
    }

    private func keep(_ profile: Profile) {
        UserDefaults.standard.set(try? JSONEncoder().encode(profile), forKey: key)
        self.profile = profile
    }

    /// The account server, as this account. 401 = the token no longer works: the account is forgotten here.
    private func ask(_ path: String, method: String = "GET") async throws -> Data {
        guard let token else { throw AccountError.signedOut }
        do {
            return try await Self.send(Self.site, path, method: method, bearer: token)
        } catch APIError.server(401, _) {
            signOut()
            throw AccountError.signedOut
        }
    }

    /// A short token the connect service trusts for this account: the account's own token never goes there.
    /// `orNone`: nil when the account server has no connect service (503), which is nothing to report.
    private func relayToken(orNone: Bool = false) async throws -> String? {
        do {
            return try JSONDecoder().decode(RelayToken.self, from: try await ask("/api/account/relay-token", method: "POST")).token
        } catch APIError.server(503, _) where orNone {
            return nil
        }
    }

    static func loginURL(_ server: URL, _ provider: String, challenge: String, forSite: Bool = false) -> URL {
        API(server: server, cookie: nil).url("/api/account/login/\(provider)?\(forSite ? "for=site&" : "")app=1&challenge=\(challenge)")
    }

    /// Whether a sign-in start answers with its redirect to Apple or Google (anything else: no sign-in there).
    private static func redirects(_ url: URL) async throws -> Bool {
        var request = URLRequest(url: url)
        request.httpShouldHandleCookies = false
        request.timeoutInterval = 15
        let (_, response) = try await reaching(url) { try await NoRedirect.session.data(for: request) }
        return (300..<400).contains((response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    /// One request to the account server or the connect service. An answer outside 200..<300 throws the server's words.
    private static func send(_ base: URL, _ path: String, method: String = "GET", bearer: String? = nil,
                             json: [String: String]? = nil) async throws -> Data {
        var request = API(server: base, cookie: nil).request(path, method: method, json: json)
        if let bearer { request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        request.httpShouldHandleCookies = false
        let (data, response) = try await reaching(base) { try await API.session.data(for: request) }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw APIError.server(status, API.message(data, status: status)) }
        return data
    }

    /// The connect service answers with codes, not words: what went wrong is said as its status.
    private static func connect(_ path: String, method: String = "GET", bearer: String) async throws -> Data {
        do {
            return try await send(connectService, path, method: method, bearer: bearer)
        } catch APIError.server(let status, _) {
            throw APIError.server(status, "the connect service answered \(status)")
        }
    }

    /// No connection, or the server does not answer: said with the server's name.
    private static func reaching<T>(_ url: URL, _ work: () async throws -> T) async throws -> T {
        do {
            return try await work()
        } catch is URLError {
            throw AccountError.unreachable(url.host() ?? url.absoluteString)
        }
    }
}

enum AccountError: LocalizedError, Equatable {
    case unreachable(String)
    case signedOut
    /// The server's own words, or what went wrong on the phone.
    case refused(String)

    var errorDescription: String? {
        switch self {
        case .unreachable(let host): return "Can't reach \(host). Check the connection and try again."
        case .signedOut: return "Signed out of the account. Sign in again."
        case .refused(let words): return words
        }
    }
}

/// POST /api/account/token → the account's token and who it is.
struct AccountToken: Decodable {
    let token: String
    let name: String?
    let email: String?
}

/// POST /api/account/relay-token → the short token for the connect service.
struct RelayToken: Decodable { let token: String }

/// POST /v1/computers/<id>/ticket on the connect service → the ticket a computer added to the account takes.
struct ComputerTicket: Decodable { let ticket: String }

/// GET /api/account/me. `servers` are the hosted servers this account signed in to; an older account server sends none.
struct AccountMe: Decodable {
    struct Hosted: Decodable { let host: String }
    let name: String?
    let email: String?
    let servers: [Hosted]?
}

/// GET /v1/computers on the connect service: the computers added to the account.
struct AddedComputers: Decodable {
    struct One: Decodable {
        let id: String
        let name: String
        let hostname: String
        let status: String
    }
    let computers: [One]
}

/// One of the account's computers: a hosted server it signed in to, or a computer added to the account (reached
/// through the connect service, with the computer's own password).
struct Computer: Identifiable, Equatable {
    /// The connect service's id of a computer added to the account; nil for a hosted server.
    let addedId: String?
    let name: String
    let url: URL
    var offline = false
    var id: String { url.absoluteString }

    /// https, and only a plain host name (with a port at most): the name comes from a server, and a sign-in code or a
    /// password is sent there.
    static func origin(_ host: String) -> URL? {
        guard host.count <= 253, host.wholeMatch(of: #/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?/#) != nil else { return nil }
        return SignIn.parse("https://" + host)?.origin
    }

    /// One list: hosted servers by host, added computers by name. A computer the connect service has dropped is left
    /// out; one whose link is down is "offline".
    static func list(hosted: [String], added: [AddedComputers.One]) -> [Computer] {
        hosted.compactMap { host in origin(host).map { Computer(addedId: nil, name: host, url: $0) } }
            + added.compactMap { c in
                guard c.status != "gone", c.id.wholeMatch(of: #/[0-9a-f]{32}/#) != nil, let url = origin(c.hostname) else { return nil }
                return Computer(addedId: c.id, name: c.name.isEmpty ? c.hostname : c.name, url: url,
                                offline: c.status == "inactive" || c.status == "down")
            }
    }

    /// Straight after a sign-in, an account with exactly one computer connects to it without showing a list. Not when
    /// it is offline or already on this phone: then the list says so.
    static func only(_ list: [Computer], here: [Server]) -> Computer? {
        guard list.count == 1, let one = list.first, !one.offline, !here.contains(where: { $0.id == one.id }) else { return nil }
        return one
    }

    #if DEBUG
    static let demo = list(hosted: ["studio.example.com"], added: [
        .init(id: String(repeating: "a", count: 32), name: "Sam's Mac", hostname: String(repeating: "a", count: 32) + ".tunnels.example.com", status: "healthy"),
        .init(id: String(repeating: "b", count: 32), name: "Office Mac", hostname: String(repeating: "b", count: 32) + ".tunnels.example.com", status: "inactive"),
    ])
    #endif
}

/// The app keeps `verifier` (32 random bytes, base64url) and sends `challenge` (base64url of its SHA-256) when it
/// starts a sign-in, so only this app can swap the code that sign-in ends with.
struct Pkce {
    let verifier: String
    let challenge: String

    init(verifier: String) {
        self.verifier = verifier
        challenge = Self.base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func make() -> Pkce {
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return Pkce(verifier: base64url(Data(bytes)))
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

/// Where a sign-in sheet ended: creatortoolset://account (the account) or creatortoolset://signin (a hosted server),
/// with ?code=<a one-time code> or ?error=<the server's words>. Any other link is nil.
enum SheetEnd: Equatable {
    case code(String)
    case error(String)

    init?(_ url: URL, _ what: String) {
        guard url.scheme?.lowercased() == "creatortoolset", url.host()?.lowercased() == what else { return nil }
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 } }
        if let code = value("code") {
            self = .code(code)
        } else if let words = value("error") {
            self = .error(words)
        } else {
            return nil
        }
    }
}

/// The system's sign-in sheet. It shares the phone's browser sign-ins, so Apple or Google asks once for the account
/// and not again for a hosted server.
@MainActor
final class WebSheet: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = WebSheet()
    private var session: ASWebAuthenticationSession?
    private var current: UUID?
    private var done: CheckedContinuation<URL?, Error>?
    private var closedAt = Date.distantPast

    /// The one-time code the sign-in ended with; nil when the person closed the sheet. The server's `?error=` words
    /// are thrown.
    func open(_ url: URL, ends what: String) async throws -> String? {
        // ponytail: a sheet opened while the one before is still sliding away may not show; 0.6 s is a guess, tune on a phone
        let wait = 0.6 - Date().timeIntervalSince(closedAt)
        if wait > 0 { try await Task.sleep(for: .seconds(wait)) }
        let back: URL? = try await withCheckedThrowingContinuation { continuation in
            session?.cancel()
            finish(.success(nil))   // a sheet still open gives way to this one
            let id = UUID()
            current = id
            done = continuation
            let sheet = ASWebAuthenticationSession(url: url, callbackURLScheme: "creatortoolset") { [weak self] url, error in
                Task { @MainActor in
                    guard let self, self.current == id else { return }
                    if let url {
                        self.finish(.success(url))
                    } else if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
                        self.finish(.success(nil))
                    } else {
                        self.finish(.failure(error ?? AccountError.refused("The sign-in didn't finish")))
                    }
                }
            }
            sheet.presentationContextProvider = self
            session = sheet
            if !sheet.start() { finish(.failure(AccountError.refused("The sign-in sheet didn't open"))) }
        }
        guard let back else { return nil }
        switch SheetEnd(back, what) {
        case .code(let code): return code
        case .error(let words): throw AccountError.refused(words)
        case nil: throw AccountError.refused("The sign-in didn't finish")
        }
    }

    /// Answers the sign-in that is waiting, once.
    private func finish(_ result: Result<URL?, Error>) {
        done?.resume(with: result)
        done = nil
        session = nil
        current = nil
        closedAt = Date()
    }

    /// Asked on the main thread.
    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            UIApplication.shared.connectedScenes.compactMap { ($0 as? UIWindowScene)?.keyWindow }.first ?? ASPresentationAnchor()
        }
    }
}

/// A sign-in button that fills its row, which gives it the row's own shape: the system's Sign in with Apple button,
/// and a plain one in the same colours for Google.
struct SignInButton: View {
    let provider: String
    let press: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if provider == "apple" {
            // made again when the look changes: the system's button takes its colours once
            AppleButton(dark: scheme == .dark, press: press).frame(height: 52).id(scheme)
        } else {
            Button(action: press) {
                Text("Sign in with \(provider.capitalized)")
                    .font(.system(size: 20.5, weight: .medium))   // the size the system's button draws at this height
                    .foregroundStyle(Color(.systemBackground))
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(Color.primary)
            }
            .buttonStyle(.plain)
        }
    }
}

/// Only the button: a press opens the account's sign-in sheet, like the Google one.
private struct AppleButton: UIViewRepresentable {
    let dark: Bool
    let press: () -> Void

    func makeUIView(context: Context) -> ASAuthorizationAppleIDButton {
        let button = ASAuthorizationAppleIDButton(type: .signIn, style: dark ? .white : .black)
        button.cornerRadius = 0   // the row rounds it, the same as the Google one
        button.addTarget(context.coordinator, action: #selector(Coordinator.pressed), for: .touchUpInside)
        return button
    }

    func updateUIView(_ button: ASAuthorizationAppleIDButton, context: Context) {
        context.coordinator.press = press
        button.isEnabled = context.environment.isEnabled
    }

    func makeCoordinator() -> Coordinator { Coordinator(press: press) }

    final class Coordinator: NSObject {
        var press: () -> Void
        init(press: @escaping () -> Void) { self.press = press }
        @objc func pressed() { press() }
    }
}

/// The account on this phone: who, and Sign out (the computers already connected stay).
struct AccountRow: View {
    let profile: Account.Profile
    let signOut: () -> Void

    var body: some View {
        HStack {
            Text(profile.title)
            Spacer()
            Button("Sign out", action: signOut).buttonStyle(.borderless)
        }
    }
}
