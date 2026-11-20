import Foundation
import Security
import WebKit

import Combine

/// The servers added on this phone and the one in use, as the screens read them: a thin view of `Connections` (servers
/// keyed by their own id, with routes). Every screen reads `current`; `current` stays a filter until the lists merge
/// across servers.
@MainActor
final class Servers: ObservableObject {
    static let shared = Servers()

    @Published private(set) var list: [Server] = []
    @Published private(set) var currentId: String?
    /// Set when the server in use turned its credential away: the person pairs or signs in again.
    @Published private(set) var signedOut = false
    private var bag = Set<AnyCancellable>()

    init(connections: Connections? = nil) {
        (connections ?? .shared).$saved.sink { [weak self] saved in
            MainActor.assumeIsolated {
                guard let self else { return }
                let list = saved.servers.map(\.server)
                if list != self.list { self.list = list }
                if saved.current?.key != self.currentId { self.currentId = saved.current?.key }
            }
        }.store(in: &bag)
        #if DEBUG
        // a server without sign-in on this Mac, for the simulator: -localServer http://localhost:43190
        if let raw = debugArg("localServer"), let target = SignIn.parse(raw), !list.contains(where: { $0.url == target.origin }) {
            add(Server(url: target.origin, username: "local"), cookie: nil)
        }
        #endif
    }

    var current: Server? { list.first { $0.id == currentId } }

    /// The client for the server in use, or nil before one is added.
    var api: API? { Connections.shared.current.map(API.connected) }

    /// A server signed in to by address (username and password, or a hosted server through the account).
    func add(_ server: Server, cookie: String?) {
        Connections.shared.addByAddress(server.url, label: server.label, username: server.username, cookie: cookie)
        signedOut = false
    }

    func use(_ id: String) {
        Connections.shared.use(key: id)
        signedOut = false
    }

    /// Removed from this phone only; revoking it happens on the computer.
    func remove(_ id: String) {
        if let entry = Connections.shared.entry(key: id) { Connections.shared.remove(entry.serverId) }
    }

    /// The server in use turned `refused` away (`code`: the 401's own). A sign-in made since (a request still on its way
    /// with the old one) stays.
    func sessionExpired(_ refused: String?, code: String? = nil) {
        guard let entry = Connections.shared.current, let route = entry.activeRoute,
              ServerRegistry.credential(entry.serverId, route: route)?.token == refused else { return }
        if code == "SESSION_REVOKED" {
            Connections.shared.lineRefused(entry.serverId, route: route, status: 401, code: code)
            signedOut = true
            return
        }
        if route.authorization == .account {
            Connections.shared.refused(entry)   // a new session is minted through the account
            return
        }
        // a paired token or an old cookie the server turned away is dropped: the person pairs again
        ServerRegistry.setCredential(entry.serverId, routeId: route.id, nil)
        signedOut = true
        Connections.shared.refused(entry)
    }
}

enum APIError: LocalizedError, Equatable {
    case signedOut
    case server(Int, String)
    /// No answer: no connection, or the server is down.
    case offline
    /// The library's Upload setting turned the file away (409 `upload_refused`): its line is shown as it is, and the
    /// upload is never tried again by itself.
    case refused(String)

    /// The HTTP status: 401 signed out, 0 no answer.
    var status: Int {
        switch self {
        case .signedOut: return 401
        case .server(let status, _): return status
        case .offline: return 0
        case .refused: return 409
        }
    }

    /// The server's line when an answer is its upload refusal (`api/library/upload-gate.ts`), else nil.
    static func refusal(_ status: Int, _ json: [String: Any]?) -> String? {
        guard status == 409, json?["code"] as? String == "upload_refused" else { return nil }
        return json?["message"] as? String ?? json?["error"] as? String
    }

    var message: String { errorDescription ?? "" }

    /// The shape shared phone code throws (`ToolsetAPI.Failure(status:message:)`).
    init(status: Int, message: String) { self = .server(status, message) }

    var errorDescription: String? {
        switch self {
        case .signedOut: return "Signed out. Sign in again in Tools → Computers."
        case .server(_, let message): return message
        case .offline: return "No connection to the server"
        case .refused(let line): return line
        }
    }
}

/// A refusal with a `code`, for a caller that tells them apart (`API.data(_:coded:)`); its text is the server's line.
struct CodedRefusal: LocalizedError, Equatable {
    let status: Int
    let code: String
    let line: String
    var errorDescription: String? { line }
}

/// The server's JSON API, with the sign-in cookie sent by hand on every request (the session keeps no cookies, so
/// nothing is ever sent to another host, such as a storage bucket a media URL redirects to).
struct API {
    let server: URL
    let cookie: String?
    /// Who is signed in, for what is kept on disk per account (`cacheKey`).
    var username: String? = nil
    /// The route's session (`Authorization: Bearer`, or `DPoP` with a fresh proof per request), in place of the cookie.
    var credential: Credential? = nil
    /// The saved server this client is for (`Server.id`): its route can change, this stays.
    var key: String? = nil
    /// The workspace every request works in (`X-CT-Workspace`): the phone's pick on this server (`API.connected`), or
    /// a chat's own for that chat's calls. nil: the server's own rule.
    var workspace: String? = nil
    /// No route was checked yet (`ServerEntry.activeRoute` is nil): every request goes nowhere, so neither a sign-in nor
    /// footage reaches whatever answers at a saved plain-HTTP address on another network.
    var unrouted = false

    /// A host that never resolves (RFC 2606): a request to it fails as no connection.
    static let nowhere = URL(string: "https://unrouted.invalid/")!

    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        return making(config)
    }()

    /// A session that keeps no cookies and never takes a sign-in header to another host on a redirect.
    static func making(_ config: URLSessionConfiguration) -> URLSession {
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        return URLSession(configuration: config, delegate: SameHostRedirects(), delegateQueue: nil)
    }

    /// A path on this server. Only this server is ever asked: another site's address (in something the server passed
    /// on, a picture's or a video's) becomes this server's front door, so neither the request nor the sign-in that
    /// rides on it goes anywhere else.
    func url(_ path: String) -> URL {
        guard !unrouted else { return Self.nowhere }
        guard let made = URL(string: path.hasPrefix("/") ? String(path.dropFirst()) : path, relativeTo: server)?.absoluteURL,
              made.scheme == server.scheme, made.host() == server.host(), made.port == server.port else { return server }
        return made
    }

    /// What one request to `url` carries: the cookie or the route's `Authorization` (a DPoP proof names the method
    /// and the URL), and the workspace.
    func headers(method: String = "GET", url: URL) -> [String: String] {
        var h = cookie.map { ["Cookie": "cap_auth=\($0)"] } ?? credential?.headers(method: method, url: url) ?? [:]
        if let workspace { h[WorkspacePick.header] = workspace }
        return h
    }

    func request(_ path: String, method: String = "GET", json: Any? = nil) -> URLRequest {
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        for (k, v) in headers(method: method, url: request.url ?? server) { request.setValue(v, forHTTPHeaderField: k) }
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return request
    }

    @discardableResult
    func send(_ path: String, method: String = "POST", json: Any? = nil) async throws -> Data {
        try await data(request(path, method: method, json: json))
    }

    func get<T: Decodable>(_ path: String, decoder: JSONDecoder = JSONDecoder()) async throws -> T {
        try decoder.decode(T.self, from: try await data(request(path)))
    }

    /// The body of a 2xx answer. No answer at all throws `.offline`; a request that was called off stays cancelled. A
    /// DPoP proof the server couldn't check this time (`INVALID_DPOP`) is sent once more with a fresh proof; a server
    /// too busy to check one (503 `busy`) is asked again later, up to 3 times, after its `Retry-After` or 1, 2, 4 s.
    /// `coded`: a refusal that carries a `code` throws `CodedRefusal`, so the caller can tell refusals apart.
    func data(_ request: URLRequest, session: URLSession = API.session, again: Bool = true, busyTries: Int = 0,
              coded: Bool = false) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code != .cancelled {
            throw APIError.offline
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 503, busyTries < 3, Self.busy(data) {
            let after = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Retry-After").flatMap(Double.init)
            try await Task.sleep(for: .seconds(min(after ?? pow(2, Double(busyTries)), 10)))
            var fresh = request
            if let credential, credential.kind == .dpop, let url = request.url {
                for (k, v) in credential.headers(method: request.httpMethod ?? "GET", url: url) { fresh.setValue(v, forHTTPHeaderField: k) }
            }
            return try await self.data(fresh, session: session, again: again, busyTries: busyTries + 1, coded: coded)
        }
        if status == 401 {
            let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String
            if code == "INVALID_DPOP", again, let credential, credential.kind == .dpop, let url = request.url {
                var fresh = request
                for (k, v) in credential.headers(method: request.httpMethod ?? "GET", url: url) { fresh.setValue(v, forHTTPHeaderField: k) }
                return try await self.data(fresh, session: session, again: false, coded: coded)
            }
            // only the server in use: an upload to another server failing must not sign this one out
            await MainActor.run { if Servers.shared.currentId == key ?? server.absoluteString { Servers.shared.sessionExpired(credential?.token ?? cookie, code: code) } }
            throw APIError.signedOut
        }
        guard (200..<300).contains(status) else {
            if let code = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["code"] as? String, coded {
                throw CodedRefusal(status: status, code: code, line: Self.message(data, status: status))
            }
            if let line = APIError.refusal(status, try? JSONSerialization.jsonObject(with: data) as? [String: Any]) {
                throw APIError.refused(line)
            }
            throw APIError.server(status, Self.message(data, status: status))
        }
        return data
    }

    /// A 503 that says the server is too busy to check a signature now (`{code: "BUSY"}`, older `{error: "busy"}`).
    static func busy(_ data: Data) -> Bool {
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return [json?["code"], json?["error"]].contains { ($0 as? String)?.lowercased() == "busy" }
    }

    /// The server's `{ error }`, or its plain-text answer, or the status.
    static func message(_ data: Data, status: Int) -> String {
        if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any], let error = json["error"] as? String {
            return error
        }
        let text = String(data: data.prefix(300), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return text.isEmpty || text.hasPrefix("<") ? "The server answered \(status)" : text
    }
}

/// Connecting a server: an address, or a one-time sign-in link from the computer (Settings → Computers, or the setup's
/// phone step), as `https://host/api/auth/link/<code>`.
enum SignIn {
    struct Target: Equatable {
        let origin: URL
        let linkPath: String?
    }

    enum Outcome: Equatable {
        case signedIn(cookie: String?, username: String)
        case needsPassword
        /// The password was right and the account asks for its sign-in code next: `code(_:step:code:)` with this step.
        case needsCode(step: String)
        /// The server asks every account for a sign-in code and this one has none yet: it is set up on the website.
        case setUpCode
    }

    /// The code step's five minutes are up: the password is asked again. Says so in the server's words.
    struct StepExpired: LocalizedError, Equatable {
        let errorDescription: String?
    }

    /// What was typed, pasted or scanned. No scheme: http for a local address (an IP, `localhost`, `.local`), else https.
    static func parse(_ text: String) -> Target? {
        var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, !raw.contains(" ") else { return nil }
        if !raw.contains("://") {
            let host = String(raw.split(separator: "/").first ?? "").split(separator: ":").first.map(String.init) ?? ""
            let local = host == "localhost" || host.hasSuffix(".local") || host.allSatisfy { $0.isNumber || $0 == "." }
            raw = (local ? "http://" : "https://") + raw
        }
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host(), !host.isEmpty else { return nil }
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = host
        parts.port = url.port
        parts.path = "/"
        guard let origin = parts.url else { return nil }
        let path = url.path()
        return Target(origin: origin, linkPath: path.hasPrefix("/api/auth/link/") ? path : nil)
    }

    /// A link signs in at once (its 302 carries the cookie); an address alone signs in only on a server without
    /// sign-in, else the person gives a username and password.
    static func connect(_ target: Target) async throws -> Outcome {
        if let linkPath = target.linkPath {
            var request = URLRequest(url: API(server: target.origin, cookie: nil).url(linkPath))
            request.httpShouldHandleCookies = false
            let (data, response) = try await NoRedirect.session.data(for: request)
            let http = response as? HTTPURLResponse
            guard let http, let cookie = cookie(from: http) else {
                throw APIError.server(http?.statusCode ?? 0, API.message(data, status: http?.statusCode ?? 0))
            }
            return .signedIn(cookie: cookie, username: try await username(target.origin, cookie: cookie))
        }
        let check = try await authCheck(target.origin, cookie: nil)
        if check.required == false { return .signedIn(cookie: nil, username: check.user?.username ?? "local") }
        return .needsPassword
    }

    static func login(_ origin: URL, username: String, password: String) async throws -> Outcome {
        try await post(origin, "/api/auth/login", ["username": username, "password": password])
    }

    /// A sign-in the account started on a hosted server: the one-time code its sign-in sheet ended with, swapped for
    /// the session (only with the verifier of the sign-in that made the code).
    static func app(_ origin: URL, code: String, verifier: String) async throws -> Outcome {
        try await post(origin, "/api/auth/app", ["code": code, "verifier": verifier])
    }

    /// A computer reached through the account: the account's ticket for it, and the computer's own password.
    static func ticket(_ origin: URL, ticket: String, password: String) async throws -> Outcome {
        try await post(origin, "/api/auth/ticket", ["ticket": ticket, "password": password])
    }

    /// The six digits from the authenticator app, or a recovery code, after a password that asked for one. A wrong
    /// code throws the server's words and the step stays good; an expired step throws `StepExpired`.
    static func code(_ origin: URL, step: String, code: String) async throws -> Outcome {
        try await post(origin, "/api/auth/code", ["step": step, "code": code])
    }

    /// A server from before sign-in by the account answers 404 here; a newer one refuses the empty code with 400.
    static func takesAppSignIn(_ origin: URL) async throws -> Bool {
        var request = API(server: origin, cookie: nil).request("/api/auth/app", method: "POST", json: [String: String]())
        request.httpShouldHandleCookies = false
        let (_, response) = try await API.session.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode != 404
    }

    /// Every sign-in route answers 200 with the cookie, or says why not in its own words.
    private static func post(_ origin: URL, _ path: String, _ json: [String: String]) async throws -> Outcome {
        var request = API(server: origin, cookie: nil).request(path, method: "POST", json: json)
        request.httpShouldHandleCookies = false
        let (data, response) = try await API.session.data(for: request)
        let http = response as? HTTPURLResponse
        guard let http, http.statusCode == 200 else { return try refusal(http?.statusCode ?? 0, data) }
        // a server without sign-in answers ok with no cookie
        let cookie = cookie(from: http)
        return .signedIn(cookie: cookie, username: try await Self.username(origin, cookie: cookie))
    }

    /// A sign-in route's answer other than 200. A 401 with a `code` is a step of the sign-in, never a session that
    /// ended: the sign-in code comes next, or is set up on the website first, or (expired) the password is asked again.
    /// Anything else is thrown in the server's own words ("Wrong code", too many tries).
    static func refusal(_ status: Int, _ data: Data) throws -> Outcome {
        struct Body: Decodable {
            let code: String?
            let step: String?
        }
        let body = try? JSONDecoder().decode(Body.self, from: data)
        if status == 401 {
            switch body?.code {
            case "CODE_NEEDED": if let step = body?.step { return .needsCode(step: step) }
            case "CODE_SETUP": return .setUpCode
            case "STEP_EXPIRED": throw StepExpired(errorDescription: API.message(data, status: status))
            default: break
            }
        }
        throw APIError.server(status, API.message(data, status: status))
    }

    struct Check: Decodable {
        struct User: Decodable { let username: String }
        let required: Bool?
        let authed: Bool?
        let user: User?
    }

    /// On the plain session: no answer stays a `URLError`, which the account's sign-in names with the server's address.
    static func authCheck(_ origin: URL, cookie: String?) async throws -> Check {
        let (data, response) = try await API.session.data(for: API(server: origin, cookie: cookie).request("/api/auth/check"))
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw APIError.server(status, API.message(data, status: status)) }
        return try JSONDecoder().decode(Check.self, from: data)
    }

    private static func username(_ origin: URL, cookie: String?) async throws -> String {
        try await authCheck(origin, cookie: cookie).user?.username ?? "local"
    }

    static func cookie(from response: HTTPURLResponse) -> String? {
        let headers = response.allHeaderFields.reduce(into: [String: String]()) { out, pair in
            if let k = pair.key as? String, let v = pair.value as? String { out[k] = v }
        }
        guard let url = response.url else { return nil }
        return HTTPCookie.cookies(withResponseHeaderFields: headers, for: url).first { $0.name == "cap_auth" }?.value
    }
}

/// A redirect to another host (a storage bucket a media URL points at) takes none of the headers that sign a request
/// in or name a workspace.
final class SameHostRedirects: NSObject, URLSessionTaskDelegate {
    static let signIn = ["Authorization", "DPoP", "Cookie", MediaTicket.header, WorkspacePick.header]

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        guard let from = response.url, let to = request.url, Routes.origin(from) != Routes.origin(to) else { return request }
        var out = request
        for name in Self.signIn { out.setValue(nil, forHTTPHeaderField: name) }
        return out
    }
}

/// The sign-in link answers 302 with the cookie: stop there instead of following it to the page.
final class NoRedirect: NSObject, URLSessionTaskDelegate {
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }()

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? { nil }
}
