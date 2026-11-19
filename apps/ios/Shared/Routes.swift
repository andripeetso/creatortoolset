import Foundation

// Compiled into the app and the Share extension.

/// How a route reaches its server, by the host it names (and the server's own word that an address is tailnet).
enum RouteKind: String, Codable, CaseIterable {
    case thisDevice, lan, tailnet, vpn, publicHost = "public", account

    /// The order a new route is put in: the nearest first, the account's tunnel last. The person can reorder.
    var rank: Int {
        switch self {
        case .thisDevice: 0
        case .lan: 1
        case .tailnet, .vpn: 2
        case .publicHost: 3
        case .account: 5
        }
    }

    /// Plain addresses on a home network, tailnet or a VPN answer within a LAN's probe time.
    var isNear: Bool { self == .thisDevice || self == .lan }

    static func of(host: String, tailnet: Bool = false) -> RouteKind {
        let host = HostClass.normalize(host)
        if HostClass.isLoopback(host) { return .thisDevice }
        if tailnet || HostClass.isTailnet(host) { return .tailnet }
        if HostClass.isSharedAddressSpace(host) { return .vpn }
        return HostClass.isPrivate(host) ? .lan : .publicHost
    }
}

/// One way to reach a server. A paired route holds its own credential; a learned one (an address the connected
/// server reported) borrows the credential of the route it was learned over; an account route is minted through
/// the account each time.
struct Route: Codable, Hashable, Identifiable {
    enum Authorization: String, Codable { case paired, account }

    var id: String
    var url: URL
    var learned = false
    var authorization: Authorization = .paired
    /// "tailnet" when the server said this address is its tailnet one.
    var network: String?

    var kind: RouteKind {
        if authorization == .account, !learned { return .account }
        return RouteKind.of(host: url.host(percentEncoded: false) ?? "", tailnet: network == "tailnet")
    }

    var label: String {
        switch kind {
        case .thisDevice: "This device"
        case .lan: "LAN"
        case .tailnet: "Tailnet"
        case .vpn: "VPN"
        case .account: "Account"
        case .publicHost: url.host(percentEncoded: false) ?? "Remote link"
        }
    }

    var isPlainHTTP: Bool { url.scheme?.lowercased() == "http" }

    /// The address part a route is known by: two routes to one origin are the same route.
    var origin: String { Routes.origin(url) }

    static func paired(_ url: URL) -> Route { Route(id: "paired:" + Routes.origin(url), url: url) }
    static let accountId = "account"
    static func account(_ url: URL) -> Route { Route(id: accountId, url: url, authorization: .account) }
}

/// An address the server reports for itself (`GET /api/server/endpoints`).
struct ReportedEndpoint: Codable, Equatable {
    let kind: String
    let httpBaseUrl: String
}

enum Routes {
    static func origin(_ url: URL) -> String {
        var parts = URLComponents()
        parts.scheme = url.scheme?.lowercased()
        let host = HostClass.normalize(url.host(percentEncoded: false) ?? "")
        // an IPv6 address keeps its brackets
        parts.percentEncodedHost = host.contains(":") ? "[\(host)]" : host.addingPercentEncoding(withAllowedCharacters: .urlHostAllowed)
        parts.port = url.port
        return parts.url?.absoluteString ?? "\(parts.scheme ?? "https")://\(host)"
    }

    static func base(_ origin: String) -> URL? { URL(string: origin + "/") }

    /// A new route goes after every route that ranks at or above it (`aheadOfSameKind`: before the others of its kind).
    static func insert(_ routes: [Route], _ route: Route, aheadOfSameKind: Bool = false) -> [Route] {
        let kind = route.kind
        guard let index = routes.firstIndex(where: { $0.kind.rank > kind.rank || (aheadOfSameKind && $0.kind == kind) }) else {
            return routes + [route]
        }
        var out = routes
        out.insert(route, at: index)
        return out
    }

    /// The route with the same id is replaced in place; a new one goes first among its kind, so its fresh credential
    /// connects.
    static func upsert(_ routes: [Route], _ route: Route) -> [Route] {
        if routes.contains(where: { $0.id == route.id }) { return routes.map { $0.id == route.id ? route : $0 } }
        return insert(routes, route, aheadOfSameKind: true)
    }

    /// The route whose credential a route uses: its own, or (learned over a paired route) that route's.
    static func credentialId(_ routeId: String) -> String {
        guard routeId.hasPrefix("learned:"), let at = routeId.lastIndex(of: "@") else { return routeId }
        return String(routeId[routeId.index(after: at)...])
    }

    /// A paired token goes to a plain HTTP address outside the tailnet only when it was paired that way.
    static func tokenAllowsPlainHTTP(_ routes: [Route], _ credentialId: String) -> Bool {
        guard let paired = routes.first(where: { $0.id == credentialId }) else { return false }
        return paired.isPlainHTTP && (paired.kind == .lan || paired.kind == .publicHost)
    }

    /// Whether connecting over `route` would send a paired token over plain HTTP it wasn't paired over. An account
    /// session is bound to this phone's key, so it may.
    static func sendsTokenInClear(_ routes: [Route], _ route: Route, tailnet: Bool? = nil) -> Bool {
        guard route.authorization == .paired else { return false }
        if tailnet ?? (route.network == "tailnet") || !route.isPlainHTTP { return false }
        let credential = credentialId(route.id)
        return credential != route.id && !tokenAllowsPlainHTTP(routes, credential)
    }

    /// The routes a connect may use.
    static func usable(_ routes: [Route]) -> [Route] { routes.filter { !sendsTokenInClear(routes, $0) } }

    /// The server's reported addresses merged into the saved routes, learned over `active`. Nil when nothing changes.
    /// Loopback is never learned; a learned route borrows `active`'s credential; a paired token is never taken to a
    /// plain HTTP address it wasn't paired over; addresses the server stops reporting are dropped; saved routes stay.
    static func mergeLearned(_ saved: [Route], active: Route, reported: [ReportedEndpoint], allowInsecure: Bool = true) -> [Route]? {
        let account = active.authorization == .account
        let shared: String? = account ? nil : credentialId(active.id)
        var reportedOrigins: [String] = []
        var tailnet = Set<String>()
        for endpoint in reported {
            guard let url = URL(string: endpoint.httpBaseUrl), let scheme = url.scheme?.lowercased(),
                  scheme == "http" || scheme == "https", let host = url.host(percentEncoded: false), !host.isEmpty else { continue }
            if scheme == "http", !allowInsecure { continue }
            // a loopback address names whichever device opens it, never the server
            if HostClass.isLoopback(host) { continue }
            let o = origin(url)
            if !reportedOrigins.contains(o) { reportedOrigins.append(o) }
            if endpoint.kind == "tailnet" { tailnet.insert(o) }
        }
        let reportedSet = Set(reportedOrigins)
        var known = Set(saved.filter { !$0.learned }.map(\.origin))
        func withNetwork(_ route: Route, _ ts: Bool) -> Route {
            var r = route
            r.network = ts ? "tailnet" : nil
            return r
        }
        var next: [Route] = saved.compactMap { route in
            let o = route.origin
            if !route.learned { return reportedSet.contains(o) ? withNetwork(route, tailnet.contains(o)) : route }
            guard reportedSet.contains(o), !known.contains(o) else { return nil }
            if sendsTokenInClear(saved, route, tailnet: tailnet.contains(o)) { return nil }
            known.insert(o)
            return withNetwork(route, tailnet.contains(o))
        }
        for o in reportedOrigins where !known.contains(o) {
            guard let url = base(o) else { continue }
            if url.scheme == "http", let shared, !tailnet.contains(o), !tokenAllowsPlainHTTP(saved, shared) { continue }
            let id = "learned:" + o + (shared.map { "@" + $0 } ?? "")
            next = insert(next, Route(id: id, url: url, learned: true, authorization: account ? .account : .paired,
                                      network: tailnet.contains(o) ? "tailnet" : nil))
            known.insert(o)
        }
        func signature(_ routes: [Route]) -> String { routes.map { "\($0.id) \($0.url) \($0.kind)" }.joined(separator: "\n") }
        return signature(saved) == signature(next) ? nil : next
    }

    /// Routes left after removing one: a learned route goes with the route whose credential it borrows (removing the
    /// account route removes every route learned through it).
    static func removing(_ routes: [Route], _ removedId: String) -> [Route] {
        guard let removed = routes.first(where: { $0.id == removedId }) else { return routes }
        return routes.filter { route in
            if route.id == removed.id { return false }
            if !route.learned { return true }
            if route.authorization == .account { return removed.authorization != .account || removed.learned }
            return credentialId(route.id) != removedId
        }
    }
}

/// What kind of network a host name or address is on.
enum HostClass {
    static func normalize(_ host: String) -> String {
        var h = host.lowercased()
        if h.hasPrefix("["), h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
        while h.hasSuffix(".") { h.removeLast() }
        return h
    }

    static func ipv4(_ host: String) -> [Int]? {
        let parts = normalize(host).split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ ($0 ?? -1) >= 0 && ($0 ?? 256) <= 255 }) else { return nil }
        return parts.map { $0! }
    }

    static func isLoopback(_ host: String) -> Bool {
        let h = normalize(host)
        return h == "localhost" || h == "::1" || ipv4(h)?.first == 127
    }

    /// The tailnet's IPv6 range. A shared 100.64.0.0/10 address alone is a VPN until the server says it is its tailnet address.
    static func isTailnet(_ host: String) -> Bool {
        let h = normalize(host)
        return h.hasPrefix("fd7a:115c:a1e0:")
    }

    static func isSharedAddressSpace(_ host: String) -> Bool {
        guard let p = ipv4(host) else { return false }
        return p[0] == 100 && (64...127).contains(p[1])
    }

    static func isPrivate(_ host: String) -> Bool {
        let h = normalize(host)
        if h == "::" || isLoopback(h) || h.hasSuffix(".localhost") || h.hasSuffix(".local") || h == "home.arpa"
            || h.hasSuffix(".home.arpa") || (!h.contains(".") && !h.contains(":")) { return true }
        if let p = ipv4(h) {
            return p[0] == 0 || p[0] == 10 || p[0] == 127 || (p[0] == 100 && (64...127).contains(p[1]))
                || (p[0] == 172 && (16...31).contains(p[1])) || (p[0] == 192 && p[1] == 168)
                || (p[0] == 169 && p[1] == 254) || (p[0] == 198 && (18...19).contains(p[1]))
        }
        guard h.contains(":"), let first = UInt16(h.split(separator: ":", maxSplits: 1).first ?? "", radix: 16) else { return false }
        return first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80
    }

    /// An IP literal or a `.local` name: typed without a scheme, it is http.
    static func isLocalLiteral(_ host: String) -> Bool {
        let h = normalize(host)
        return h == "localhost" || h.hasSuffix(".local") || ipv4(h) != nil || h.contains(":")
    }
}
