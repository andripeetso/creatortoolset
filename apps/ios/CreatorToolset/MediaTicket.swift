import Foundation
import WebKit

/// A media ticket (`POST /api/auth/media-ticket`, `api/media-ticket.ts`): what stands for this phone's session where a
/// request can't be signed by itself: a player's range requests, a web view's page and its own calls, an upload the
/// background transfer service sends minutes later. It opens one path (and below it), reading only unless asked for
/// writing, for an hour at most, and ends with the session.
enum MediaTicket {
    static let param = "ct_ticket"

    struct Answer: Decodable {
        let ticket: String
    }

    /// `url` with the ticket in its query, beside what is there.
    static func add(_ ticket: String, to url: URL) -> URL {
        url.appending(queryItems: [URLQueryItem(name: param, value: ticket)])
    }

    /// The cookie a web view carries it in: this server's host only, never sent from another site's page.
    static func cookie(_ ticket: String, for server: URL) -> HTTPCookie? {
        guard let host = server.host() else { return nil }
        var properties: [HTTPCookiePropertyKey: Any] = [.name: param, .value: ticket, .domain: host, .path: "/",
                                                        .sameSitePolicy: HTTPCookieStringPolicy.sameSiteStrict]
        if server.scheme == "https" { properties[.secure] = "TRUE" }
        return HTTPCookie(properties: properties)
    }
}

extension API {
    /// A DPoP session signs each request with a fresh proof, good for one request within minutes: what can't sign by
    /// itself carries a ticket.
    var needsTicket: Bool { cookie == nil && credential?.kind == .dpop }

    /// A web view can't add a header to the page's own calls: any device session (Bearer or DPoP) hands it a ticket.
    var webNeedsTicket: Bool { cookie == nil && (credential?.kind == .dpop || credential?.kind == .bearer) }

    /// A ticket for `prefix` (a path on this server), reading only unless `write`.
    func mediaTicket(_ prefix: String, write: Bool = false) async throws -> String {
        let data = try await send("/api/auth/media-ticket", json: ["path": prefix, "write": write])
        return try JSONDecoder().decode(MediaTicket.Answer.self, from: data).ticket
    }

    /// `path` on this server with a ticket for exactly that path in its query.
    func ticketed(_ path: String, write: Bool = false) async throws -> URL {
        let url = url(path)
        return MediaTicket.add(try await mediaTicket(url.path(percentEncoded: false), write: write), to: url)
    }

    /// A request built by `request(_:method:)` for the background transfer service: a DPoP session's proof is swapped
    /// for a write ticket on `prefix`, so iOS may send it whenever it likes within the hour. Others go as they are.
    func background(_ request: URLRequest, prefix: String) async throws -> URLRequest {
        guard needsTicket, let url = request.url else { return request }
        var out = request
        out.url = MediaTicket.add(try await mediaTicket(prefix, write: true), to: url)
        out.setValue(nil, forHTTPHeaderField: "Authorization")
        out.setValue(nil, forHTTPHeaderField: "DPoP")
        return out
    }

    /// Signs a web view in: the cookie of a session from before pairing, or a ticket for the whole API (writing when
    /// the session may write) in a cookie. False when there was nothing to give it.
    @MainActor
    func signIn(_ store: WKHTTPCookieStore) async -> Bool {
        if let c = webCookie {
            await store.setCookie(c)
            return true
        }
        guard webNeedsTicket,
              let ticket = try? await mediaTicket("/api/", write: credential?.scopes?.contains("write") ?? true),
              let c = MediaTicket.cookie(ticket, for: server) else { return false }
        await store.setCookie(c)
        return true
    }
}
