import Foundation
import WebKit

/// A media ticket (`POST /api/auth/media-ticket/<use>`, `api/media-ticket.ts`): what stands for this phone's session where a
/// request can't be signed by itself: a player's range requests, a web view's page and its own calls, an upload the
/// background transfer service sends minutes later. It opens one path (and below it), reading only unless asked for
/// writing, for 5 minutes at most, and ends with the session. It works only for its own use: `media` (players, web
/// views) rides in a cookie, `upload` (background upload steps) in a header; never in a URL (URLs end up in logs).
enum MediaTicket {
    enum Use: String {
        case media, upload
    }

    static let cookieName = "ct_ticket"
    static let header = "X-CT-Ticket"
    /// A web view asks again this often; the server's tickets live 5 minutes.
    static let refresh: Duration = .seconds(4 * 60)

    struct Answer: Decodable {
        let ticket: String
    }

    /// The cookie a web view or a player carries it in: this server's host only, never sent from another site's page,
    /// never readable by the page's scripts.
    static func cookie(_ ticket: String, for server: URL) -> HTTPCookie? {
        guard server.host() != nil else { return nil }
        let secure = server.scheme == "https" ? "; Secure" : ""
        let header = "\(cookieName)=\(ticket); Path=/; HttpOnly; SameSite=Strict\(secure)"
        return HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: server).first
    }
}

extension API {
    /// A DPoP session signs each request with a fresh proof, good for one request within minutes: what can't sign by
    /// itself carries a ticket.
    var needsTicket: Bool { cookie == nil && credential?.kind == .dpop }

    /// A web view can't add a header to the page's own calls: any device session (Bearer or DPoP) hands it a ticket.
    var webNeedsTicket: Bool { cookie == nil && (credential?.kind == .dpop || credential?.kind == .bearer) }

    /// A ticket for `prefix` (a path on this server) and `use`, reading only unless `write` (an upload always writes).
    func mediaTicket(_ prefix: String, use: MediaTicket.Use = .media, write: Bool = false,
                     session: URLSession = API.session) async throws -> String {
        let data = try await data(request("/api/auth/media-ticket/\(use.rawValue)", method: "POST",
                                          json: ["path": prefix, "write": write || use == .upload]), session: session)
        return try JSONDecoder().decode(MediaTicket.Answer.self, from: data).ticket
    }

    /// A request built by `request(_:method:)` for the background transfer service: a DPoP session's proof is swapped
    /// for a write ticket on `prefix` in a header, so iOS may send it later; a 401 asks for a new one (`UploadEngine`).
    /// Others go as they are.
    func background(_ request: URLRequest, prefix: String, session: URLSession = API.session) async throws -> URLRequest {
        guard needsTicket else { return request }
        var out = request
        out.setValue(try await mediaTicket(prefix, use: .upload, session: session), forHTTPHeaderField: MediaTicket.header)
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
