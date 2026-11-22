import Foundation

/// What kind of network a host name or address is on.
public enum HostClass {
    public static func normalize(_ host: String) -> String {
        var h = host.lowercased()
        if h.hasPrefix("["), h.hasSuffix("]") { h = String(h.dropFirst().dropLast()) }
        while h.hasSuffix(".") { h.removeLast() }
        return h
    }

    public static func ipv4(_ host: String) -> [Int]? {
        let parts = normalize(host).split(separator: ".", omittingEmptySubsequences: false).map { Int($0) }
        guard parts.count == 4, parts.allSatisfy({ ($0 ?? -1) >= 0 && ($0 ?? 256) <= 255 }) else { return nil }
        return parts.map { $0! }
    }

    public static func isLoopback(_ host: String) -> Bool {
        let h = normalize(host)
        return h == "localhost" || h == "::1" || ipv4(h)?.first == 127
    }

    /// The tailnet's IPv6 range. A shared 100.64.0.0/10 address alone is a VPN until the server says it is its tailnet address.
    public static func isTailnet(_ host: String) -> Bool {
        let h = normalize(host)
        return h.hasPrefix("fd7a:115c:a1e0:")
    }

    public static func isSharedAddressSpace(_ host: String) -> Bool {
        guard let p = ipv4(host) else { return false }
        return p[0] == 100 && (64...127).contains(p[1])
    }

    public static func isPrivate(_ host: String) -> Bool {
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
    public static func isLocalLiteral(_ host: String) -> Bool {
        let h = normalize(host)
        return h == "localhost" || h.hasSuffix(".local") || ipv4(h) != nil || h.contains(":")
    }
}
