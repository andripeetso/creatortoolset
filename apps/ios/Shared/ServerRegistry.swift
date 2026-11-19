import Foundation

// Compiled into the app and the Share extension: both read the saved servers and their credentials from the Keychain.

/// What a route signs its requests with. A paired session is a bearer token (30 days); an account session is bound
/// to this phone's key (DPoP, 1 hour, renewed); a server saved before pairing existed keeps its sign-in cookie until
/// the server turns it away.
struct Credential: Codable, Equatable {
    enum Kind: String, Codable { case bearer, dpop, cookie }
    var kind: Kind
    var token: String
    var expiresAt: Date?
    var scopes: [String]?

    /// The headers one request carries. `Authorization` from the route in use, never the cookie, unless the server
    /// was saved before pairing existed.
    func headers(method: String, url: URL, key: DPoPKey = .shared) -> [String: String] {
        switch kind {
        case .cookie: return ["Cookie": "cap_auth=\(token)"]
        case .bearer: return ["Authorization": "Bearer \(token)"]
        case .dpop:
            var h = ["Authorization": "DPoP \(token)"]
            h["DPoP"] = try? DPoP.proof(method: method, url: url, accessToken: token, key: key)
            return h
        }
    }

    func expired(_ now: Date = Date()) -> Bool { expiresAt.map { $0 <= now } ?? false }
}

/// One server saved on this phone, known by the id the server gives itself, with every way to reach it.
struct ServerEntry: Codable, Identifiable, Hashable {
    var serverId: String
    var label: String
    var enabled = true
    var routes: [Route]
    /// Why this app can't talk to it ("Client not supported"); it stays saved.
    var unsupportedReason: String?
    /// It runs an older Creator Toolset: saved, and the detail page offers the update.
    var updateRequired: Bool?
    /// Who it signed in as (what is kept on disk is kept per account).
    var username: String?
    var version: String?
    var platform: String?
    /// The route the app last connected over: the Share extension uses it.
    var activeRouteId: String?
    /// The address it was first added by. Other parts of the app know the server by it (`Server.id`), so it never
    /// changes while the server stays saved, whichever route is in use.
    var home: URL

    var id: String { serverId }
    var key: String { home.absoluteString }
    /// Saved before servers had ids: the first answer from it names the real one.
    var provisional: Bool { serverId.hasPrefix("url:") }

    var server: Server { Server(url: home, username: username, label: label) }

    var activeRoute: Route? {
        routes.first { $0.id == activeRouteId } ?? Routes.usable(routes).first
    }
}

/// The saved servers, in the Keychain group the app shares with its Share extension.
enum ServerRegistry {
    struct Saved: Codable, Equatable {
        var servers: [ServerEntry] = []
        /// The server the screens show (a filter until the lists merge across servers), by `ServerEntry.key`.
        var currentKey: String?

        var current: ServerEntry? { servers.first { $0.key == currentKey } ?? servers.first }
    }

    static let account = "registry"

    static func read() -> Saved {
        if let saved = Keychain.get(account).flatMap({ try? JSONDecoder().decode(Saved.self, from: Data($0.utf8)) }) { return saved }
        return migrate()
    }

    static func write(_ saved: Saved) {
        Keychain.set(account, (try? JSONEncoder().encode(saved)).flatMap { String(data: $0, encoding: .utf8) })
    }

    // MARK: credentials, one Keychain item per server and route

    static func credentialAccount(_ serverId: String, _ routeId: String) -> String {
        "cred:\(serverId):\(Routes.credentialId(routeId))"
    }

    /// The credential a route signs with: its own, or the one of the route it was learned over, or (any account
    /// route) the server's account session.
    static func credential(_ serverId: String, route: Route) -> Credential? {
        let id = route.authorization == .account ? Route.accountId : route.id
        return Keychain.get(credentialAccount(serverId, id)).flatMap { try? JSONDecoder().decode(Credential.self, from: Data($0.utf8)) }
    }

    @discardableResult
    static func setCredential(_ serverId: String, routeId: String, _ credential: Credential?) -> Bool {
        Keychain.set(credentialAccount(serverId, routeId),
                     credential.flatMap { try? JSONEncoder().encode($0) }.flatMap { String(data: $0, encoding: .utf8) })
    }

    static func forgetCredentials(_ entry: ServerEntry) {
        for route in entry.routes { setCredential(entry.serverId, routeId: route.id, nil) }
        setCredential(entry.serverId, routeId: Route.accountId, nil)
    }

    /// A server's id became known (it was saved by address): its credentials move to the new id.
    static func rekey(_ entry: ServerEntry, to serverId: String) -> ServerEntry {
        var next = entry
        next.serverId = serverId
        for route in entry.routes where route.authorization == .paired && !route.learned {
            if let c = credential(entry.serverId, route: route) {
                setCredential(serverId, routeId: route.id, c)
                setCredential(entry.serverId, routeId: route.id, nil)
            }
        }
        return next
    }

    // MARK: migration

    /// The first launch with routes: each server saved by address becomes a server with one route, its sign-in
    /// cookie kept as that route's credential until the server turns it away (then the person pairs again). The old
    /// cookie item is deleted only once its copy is in.
    static func migrate(from old: SavedServers? = SavedServers.read() ?? SavedServers.fromDefaults()) -> Saved {
        guard let old else { return Saved() }
        var saved = Saved()
        for server in old.list {
            let route = Route.paired(server.url)
            let entry = ServerEntry(serverId: "url:" + Routes.origin(server.url), label: server.name, routes: [route],
                                    username: server.username, activeRouteId: route.id, home: server.url)
            if let cookie = Keychain.get(server.id) {
                guard setCredential(entry.serverId, routeId: route.id, Credential(kind: .cookie, token: cookie)) else { return Saved() }
            }
            saved.servers.append(entry)
        }
        saved.currentKey = old.currentId
        write(saved)
        guard Keychain.get(account) != nil else { return saved }   // a locked phone: tried again next launch
        for server in old.list { Keychain.set(server.id, nil) }
        return saved
    }

    // MARK: for the Share extension, which has no supervisor

    /// The server in use, the address it was last reached on and that route's headers for one request.
    static func currentConnection() -> (base: URL, entry: ServerEntry, credential: Credential?)? {
        guard let entry = read().current, let route = entry.activeRoute else { return nil }
        return (route.url, entry, credential(entry.serverId, route: route))
    }
}
