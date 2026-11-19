import Foundation
import UIKit

/// `GET /.well-known/creator-toolset/server`: who a server is, asked before any credential goes to it.
struct ServerDescriptor: Codable, Equatable {
    /// The protocol this app speaks.
    static let supportedProtocol = 1

    let serverId: String
    let label: String
    let platform: String?
    let version: String?
    let protocolVersion: Int

    enum CodingKeys: String, CodingKey {
        case serverId, label, platform, version
        case protocolVersion = "protocol"
    }

    init(serverId: String, label: String, platform: String? = nil, version: String? = nil, protocolVersion: Int = supportedProtocol) {
        self.serverId = serverId
        self.label = label
        self.platform = platform
        self.version = version
        self.protocolVersion = protocolVersion
    }

    /// No redirects followed and nothing cached: a cached answer would speak for a host that can't be reached.
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: NoRedirect(), delegateQueue: nil)
    }()

    static func fetch(_ base: URL, timeout: TimeInterval = 10, session: URLSession = session) async throws -> ServerDescriptor {
        var request = URLRequest(url: API(server: base, cookie: nil).url("/.well-known/creator-toolset/server"))
        request.timeoutInterval = timeout
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else { throw PairingError.notAServer(base.host(percentEncoded: false) ?? base.absoluteString) }
        return try JSONDecoder().decode(ServerDescriptor.self, from: data)
    }
}

enum PairingError: LocalizedError, Equatable {
    case invalid
    case notAServer(String)
    case differentServer(String)
    case alreadySaved(String)
    case unsupported
    case refused(String)

    var errorDescription: String? {
        switch self {
        case .invalid: "The pairing details are invalid."
        case .notAServer(let host): "\(host) didn't answer as a Creator Toolset computer."
        case .differentServer(let label): "That address reaches \(label), a different computer. Add it as its own computer instead."
        case .alreadySaved(let label): "That address claims to be \(label), which is already saved. Add it as a route from that computer's settings instead."
        case .unsupported: "Use compatible versions of the app and server to connect."
        case .refused(let words): words
        }
    }
}

/// A pairing link or a typed address and code.
struct PairingTarget: Equatable {
    let origin: URL
    let code: String?

    /// `https://host/#token=XXXX`, `?token=`, the app's own link (`creatortoolset://pair?pairingUrl=<that link>`), or an
    /// address with no scheme: http for an IP or a `.local` name, https otherwise.
    static func parse(_ text: String, code typed: String? = nil) -> PairingTarget? {
        var raw = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty, !raw.contains(" ") else { return nil }
        if let link = URLComponents(string: raw), link.scheme?.lowercased() == "creatortoolset", link.host?.lowercased() == "pair",
           let inner = link.queryItems?.first(where: { $0.name == "pairingUrl" || $0.name == "url" })?.value {
            return parse(inner, code: typed)
        }
        if !raw.contains("://") {
            let hostPart = String(raw.split(separator: "/").first ?? "")
            let host = hostPart.hasPrefix("[") ? String(hostPart.prefix { $0 != "]" }.dropFirst())
                : String(hostPart.split(separator: ":").first ?? "")
            raw = (HostClass.isLocalLiteral(host) ? "http://" : "https://") + raw
        }
        guard let parts = URLComponents(string: raw), let scheme = parts.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parts.host, !host.isEmpty, let url = parts.url else { return nil }
        let fragment = URLComponents(string: "?" + (parts.fragment ?? ""))?.queryItems?.first { $0.name == "token" }?.value
        let query = parts.queryItems?.first { $0.name == "token" }?.value
        let typed = typed?.trimmingCharacters(in: .whitespacesAndNewlines)
        let code = [typed, fragment, query].compactMap { $0 }.first { !$0.isEmpty }
        guard let origin = Routes.base(Routes.origin(url)) else { return nil }
        return PairingTarget(origin: origin, code: code?.uppercased())
    }
}

/// `POST /oauth/token` → a session for this phone.
struct TokenResponse: Decodable {
    let access_token: String
    let token_type: String
    let expires_in: Double?
    let scope: String?

    func credential(now: Date = Date()) -> Credential {
        Credential(kind: token_type.lowercased() == "dpop" ? .dpop : .bearer, token: access_token,
                   expiresAt: expires_in.map { now.addingTimeInterval($0) },
                   scopes: scope?.split(separator: " ").map(String.init))
    }
}

enum Pairing {
    static let grantType = "urn:ietf:params:oauth:grant-type:token-exchange"
    static let bootstrapType = "urn:creatortoolset:params:oauth:token-type:server-bootstrap"
    static let accessType = "urn:ietf:params:oauth:token-type:access_token"

    /// Checked before the one-time code is redeemed, so a wrong link is not spent. `expected`: the server a new
    /// route is added to. A server this app is too old for is refused; an older server is still saved (to update).
    static func check(_ descriptor: ServerDescriptor, expected: String?, saved: [ServerEntry]) throws -> (updateRequired: Bool, provisional: ServerEntry?) {
        if let expected, descriptor.serverId != expected {
            let entry = saved.first { $0.serverId == expected }
            // a server saved by address before ids existed is that same server once its address answers
            if entry?.provisional != true { throw PairingError.differentServer(descriptor.label) }
            return (descriptor.protocolVersion < ServerDescriptor.supportedProtocol, entry)
        }
        if expected == nil, saved.contains(where: { $0.serverId == descriptor.serverId }) {
            throw PairingError.alreadySaved(descriptor.label)
        }
        if descriptor.protocolVersion > ServerDescriptor.supportedProtocol { throw PairingError.unsupported }
        return (descriptor.protocolVersion < ServerDescriptor.supportedProtocol, nil)
    }

    /// The phone as the computer lists it: "Sam's iPhone", mobile or tablet, "iOS 26", the model, the app's version.
    @MainActor
    static func clientMetadata() -> [String: String] {
        let device = UIDevice.current
        return [
            "client_label": device.name,
            "client_device_type": device.userInterfaceIdiom == .pad ? "tablet" : "mobile",
            "client_os": "iOS \(device.systemVersion.split(separator: ".").first ?? "")",
            "client_model": modelIdentifier(),
            "app_version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
        ]
    }

    private static func modelIdentifier() -> String {
        var info = utsname()
        uname(&info)
        return withUnsafeBytes(of: &info.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    }

    /// The token exchange: a pairing code (Bearer, 30 days) or an account's connect credential (with `dpop`, bound
    /// to this phone's key, 1 hour). An invalid code is said in the server's words.
    static func exchange(_ base: URL, credential: String, dpop: Bool, metadata: [String: String],
                         session: URLSession = API.session) async throws -> Credential {
        var request = URLRequest(url: API(server: base, cookie: nil).url("/oauth/token"))
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        if dpop { request.setValue(try DPoP.proof(method: "POST", url: request.url!), forHTTPHeaderField: "DPoP") }
        var fields = ["grant_type": grantType, "subject_token": credential, "subject_token_type": bootstrapType,
                      "requested_token_type": accessType]
        fields.merge(metadata.filter { !$0.value.isEmpty }) { a, _ in a }
        request.httpBody = Data(form(fields).utf8)
        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let words = object?["error_description"] as? String ?? object?["error"] as? String
            throw PairingError.refused(words ?? "The server answered \(status).")
        }
        return try JSONDecoder().decode(TokenResponse.self, from: data).credential()
    }

    static func form(_ fields: [String: String]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return fields.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&")
    }

    /// Pairs this phone: descriptor, checks, then the code. `expected`: add a route to that saved server.
    /// Returns the server's id.
    @MainActor
    @discardableResult
    static func pair(_ target: PairingTarget, expected: String? = nil, connections: Connections? = nil,
                     session: URLSession? = nil) async throws -> String {
        let connections = connections ?? .shared
        guard let code = target.code, !code.isEmpty else { throw PairingError.invalid }
        let descriptor: ServerDescriptor
        do {
            descriptor = try await ServerDescriptor.fetch(target.origin, session: session ?? ServerDescriptor.session)
        } catch let error as PairingError {
            throw error
        } catch {
            throw PairingError.refused("Can't reach \(target.origin.host(percentEncoded: false) ?? "that address"). Check the address and that the computer is on.")
        }
        let (updateRequired, provisional) = try check(descriptor, expected: expected, saved: connections.servers)
        let credential = try await exchange(target.origin, credential: code, dpop: false, metadata: clientMetadata(),
                                            session: session ?? API.session)
        var username: String?
        if let info = try? await sessionInfo(target.origin, credential, session: session ?? API.session) { username = info.user?.username }
        let route = Route.paired(target.origin)
        if let provisional {
            // the same server saved by address: it takes its real id with the new route
            connections.add(serverId: provisional.serverId, label: provisional.label, route: route, credential: credential, username: username)
        } else {
            connections.add(serverId: descriptor.serverId, label: descriptor.label, route: route, credential: credential,
                            username: username, descriptor: descriptor, updateRequired: updateRequired)
        }
        return descriptor.serverId
    }

    struct SessionInfo: Decodable {
        struct User: Decodable { let username: String }
        let authenticated: Bool?
        let scopes: [String]?
        let user: User?
    }

    /// `GET /api/auth/session`: who the new session is.
    static func sessionInfo(_ base: URL, _ credential: Credential, session: URLSession = API.session) async throws -> SessionInfo {
        var api = API(server: base, cookie: nil)
        api.credential = credential
        return try JSONDecoder().decode(SessionInfo.self, from: try await session.data(for: api.request("/api/auth/session")).0)
    }
}

/// A pairing link opened from outside the app (the Camera, the website's "Open in the app", another app): the Add screen
/// opens filled in and waits for the person's Connect. It never connects by itself: a link carries a host and a code
/// someone else chose.
@MainActor
final class PairingLinks: ObservableObject {
    static let shared = PairingLinks()

    /// The link waiting on the Add screen.
    @Published var pending: PairingTarget?

    /// True when `url` was a pairing link (it is then shown, never redeemed).
    @discardableResult
    func open(_ url: URL) -> Bool {
        guard let target = Self.target(url) else { return false }
        pending = target
        return true
    }

    /// `creatortoolset://pair?pairingUrl=…`, or a universal link `https://host/#token=…` (`?token=` too).
    nonisolated static func target(_ url: URL) -> PairingTarget? {
        let scheme = url.scheme?.lowercased()
        if scheme == "creatortoolset" { guard url.host()?.lowercased() == "pair" else { return nil } }
        else if scheme == "https" || scheme == "http" {
            let parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
            let inFragment = URLComponents(string: "?" + (parts?.fragment ?? ""))?.queryItems?.contains { $0.name == "token" } ?? false
            guard inFragment || parts?.queryItems?.contains(where: { $0.name == "token" }) == true else { return nil }
        } else { return nil }
        guard let target = PairingTarget.parse(url.absoluteString), target.code?.isEmpty == false else { return nil }
        return target
    }
}
