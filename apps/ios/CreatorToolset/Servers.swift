import Foundation
import Security

/// A Creator Toolset server this phone talks to: the one on the person's own computer, their own server, or a hosted
/// one. The sign-in cookie (`cap_auth`) is kept in the Keychain, never in the list.
struct Server: Codable, Identifiable, Hashable {
    let url: URL
    var username: String?
    /// The computer's own name, for one reached through the account (its address is a row of letters and digits).
    var label: String?
    var id: String { url.absoluteString }
    var name: String { label ?? (url.host(percentEncoded: false) ?? url.absoluteString) + (url.port.map { ":\($0)" } ?? "") }
}

/// The servers added on this phone and the one in use. Every screen reads `current`.
@MainActor
final class Servers: ObservableObject {
    static let shared = Servers()

    @Published private(set) var list: [Server] = []
    @Published private(set) var currentId: String?
    /// Set when the server answered 401: the cookie is gone, so the person signs in again.
    @Published private(set) var signedOut = false

    private let listKey = "servers"
    private let currentKey = "currentServer"

    init() {
        if let data = UserDefaults.standard.data(forKey: listKey),
           let saved = try? JSONDecoder().decode([Server].self, from: data) {
            list = saved
        }
        currentId = UserDefaults.standard.string(forKey: currentKey) ?? list.first?.id
    }

    var current: Server? { list.first { $0.id == currentId } }

    /// The client for the server in use, or nil before one is added.
    var api: API? { current.map { API(server: $0.url, cookie: Keychain.get($0.id)) } }

    func add(_ server: Server, cookie: String?) {
        list.removeAll { $0.id == server.id }
        list.append(server)
        Keychain.set(server.id, cookie)
        use(server.id)
    }

    func use(_ id: String) {
        currentId = id
        signedOut = false
        save()
    }

    func remove(_ id: String) {
        list.removeAll { $0.id == id }
        Keychain.set(id, nil)
        if currentId == id { currentId = list.first?.id }
        save()
    }

    func sessionExpired() {
        guard let id = currentId else { return }
        Keychain.set(id, nil)
        signedOut = true
    }

    private func save() {
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: listKey)
        UserDefaults.standard.set(currentId, forKey: currentKey)
    }
}

/// One generic-password item per server, readable after the first unlock (background uploads need it).
enum Keychain {
    private static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "creator-toolset.server",
         kSecAttrAccount as String: account]
    }

    static func get(_ account: String) -> String? {
        var q = query(account)
        q[kSecReturnData as String] = true
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func set(_ account: String, _ value: String?) {
        SecItemDelete(query(account) as CFDictionary)
        guard let value else { return }
        var q = query(account)
        q[kSecValueData as String] = Data(value.utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(q as CFDictionary, nil)
    }
}

enum APIError: LocalizedError, Equatable {
    case signedOut
    case server(Int, String)

    var errorDescription: String? {
        switch self {
        case .signedOut: return "Signed out. Sign in again in More → Computers."
        case .server(_, let message): return message
        }
    }
}

/// The server's JSON API, with the sign-in cookie sent by hand on every request (the session keeps no cookies, so
/// nothing is ever sent to another host, such as a storage bucket a media URL redirects to).
struct API {
    let server: URL
    let cookie: String?

    static let session: URLSession = {
        let config = URLSessionConfiguration.default
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    func url(_ path: String) -> URL {
        URL(string: path.hasPrefix("/") ? String(path.dropFirst()) : path, relativeTo: server)!.absoluteURL
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

    func get<T: Decodable>(_ path: String) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await data(request(path)))
    }

    func data(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await Self.session.data(for: request)
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

    static func authCheck(_ origin: URL, cookie: String?) async throws -> Check {
        try await API(server: origin, cookie: cookie).get("/api/auth/check")
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
