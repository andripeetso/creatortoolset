import Foundation
import Security
import WebKit

/// The servers added on this phone and the one in use. Every screen reads `current`.
@MainActor
final class Servers: ObservableObject {
    static let shared = Servers()

    @Published private(set) var list: [Server] = []
    @Published private(set) var currentId: String?
    /// Set when the server answered 401: the cookie is gone, so the person signs in again.
    @Published private(set) var signedOut = false

    /// Where the list and the server in use are saved (`API.current` reads them too).
    nonisolated static let listKey = "servers"
    nonisolated static let currentKey = "currentServer"
    private var listKey: String { Self.listKey }
    private var currentKey: String { Self.currentKey }

    init() {
        if let data = UserDefaults.standard.data(forKey: listKey),
           let saved = try? JSONDecoder().decode([Server].self, from: data) {
            list = saved
        }
        currentId = UserDefaults.standard.string(forKey: currentKey) ?? list.first?.id
        #if DEBUG
        // a server without sign-in on this Mac, for the simulator: -localServer http://localhost:43190
        if let raw = debugArg("localServer"), let target = SignIn.parse(raw) {
            add(Server(url: target.origin, username: "local"), cookie: nil)
        }
        #endif
        // a phone that added its servers before the Share extension existed
        if !list.isEmpty, SavedServers.read() == nil { SavedServers(list: list, currentId: currentId).write() }
    }

    var current: Server? { list.first { $0.id == currentId } }

    /// The client for the server in use, or nil before one is added.
    var api: API? { current.map { API(server: $0.url, cookie: Keychain.get($0.id), username: $0.username) } }

    func add(_ server: Server, cookie: String?) {
        list = Self.adding(server, to: list)
        Keychain.set(server.id, cookie)
        use(server.id)
    }

    /// The list with a server added, in place of the one with the same address. Signed in again by its address, a
    /// computer keeps the name it had.
    static func adding(_ server: Server, to list: [Server]) -> [Server] {
        var server = server
        if server.label == nil { server.label = list.first { $0.id == server.id }?.label }
        return list.filter { $0.id != server.id } + [server]
    }

    func use(_ id: String) {
        currentId = id
        signedOut = false
        save()
    }

    /// A removed server stops sending this phone anything (its push is forgotten with the sign-in still in hand),
    /// and removing the last one forgets what the in-app web pages kept.
    func remove(_ id: String) {
        if let server = list.first(where: { $0.id == id }) {
            let api = API(server: server.url, cookie: Keychain.get(id), username: server.username)
            Task { await StudioHooks.removing(api) }
        }
        list.removeAll { $0.id == id }
        Keychain.set(id, nil)
        if currentId == id { currentId = list.first?.id }
        save()
        if list.isEmpty {
            WKWebsiteDataStore.default().removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {}
        }
    }

    func sessionExpired() {
        guard let id = currentId else { return }
        Keychain.set(id, nil)
        signedOut = true
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: listKey)
        UserDefaults.standard.set(currentId, forKey: currentKey)
        SavedServers(list: list, currentId: currentId).write()
    }
}

enum APIError: LocalizedError, Equatable {
    case signedOut
    case server(Int, String)
    /// No answer: no connection, or the server is down.
    case offline

    /// The HTTP status: 401 signed out, 0 no answer.
    var status: Int {
        switch self {
        case .signedOut: return 401
        case .server(let status, _): return status
        case .offline: return 0
        }
    }

    var message: String { errorDescription ?? "" }

    /// The shape shared phone code throws (`ToolsetAPI.Failure(status:message:)`).
    init(status: Int, message: String) { self = .server(status, message) }

    var errorDescription: String? {
        switch self {
        case .signedOut: return "Signed out. Sign in again in More → Computers."
        case .server(_, let message): return message
        case .offline: return "No connection to the server"
        }
    }
}

/// The server's JSON API, with the sign-in cookie sent by hand on every request (the session keeps no cookies, so
/// nothing is ever sent to another host, such as a storage bucket a media URL redirects to).
struct API {
    let server: URL
    let cookie: String?
    /// Who is signed in, for what is kept on disk per account (`cacheKey`).
    var username: String? = nil

    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    /// A path on this server. Only this server is ever asked: another site's address (in something the server passed
    /// on, a picture's or a video's) becomes this server's front door, so neither the request nor the sign-in that
    /// rides on it goes anywhere else.
    func url(_ path: String) -> URL {
        guard let made = URL(string: path.hasPrefix("/") ? String(path.dropFirst()) : path, relativeTo: server)?.absoluteURL,
              made.scheme == server.scheme, made.host() == server.host(), made.port == server.port else { return server }
        return made
    }

    var headers: [String: String] { cookie.map { ["Cookie": "cap_auth=\($0)"] } ?? [:] }

    func request(_ path: String, method: String = "GET", json: Any? = nil) -> URLRequest {
        var request = URLRequest(url: url(path))
        request.httpMethod = method
        for (k, v) in headers { request.setValue(v, forHTTPHeaderField: k) }
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

    /// The body of a 2xx answer. No answer at all throws `.offline`; a request that was called off stays cancelled.
    func data(_ request: URLRequest, session: URLSession = API.session) async throws -> Data {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch let error as URLError where error.code != .cancelled {
            throw APIError.offline
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 {
            // only the server in use: an upload to another server failing must not sign this one out
            await MainActor.run { if Servers.shared.currentId == server.absoluteString { Servers.shared.sessionExpired() } }
            throw APIError.signedOut
        }
        guard (200..<300).contains(status) else { throw APIError.server(status, Self.message(data, status: status)) }
        return data
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
        guard let http, http.statusCode == 200 else {
            throw APIError.server(http?.statusCode ?? 0, API.message(data, status: http?.statusCode ?? 0))
        }
        // a server without sign-in answers ok with no cookie
        let cookie = cookie(from: http)
        return .signedIn(cookie: cookie, username: try await Self.username(origin, cookie: cookie))
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
