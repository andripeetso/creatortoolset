import Foundation

// Compiled into the app and the Share extension: what Share → Creator Toolset sends, with the sign-in the app saved
// (`ServerRegistry`, in the Keychain group both share).

/// The server in use, as the Share extension reaches it: one of the person's own posts linked to its Workshop session,
/// or a link saved to the Content Analyzer.
struct ShareLink {
    let server: URL
    /// The credential of the route the app last connected over (`Authorization`, not the cookie).
    var credential: Credential? = nil
    /// The phone's pick of workspace on this server (`WorkspacePick`): every request names it.
    var workspace: String? = nil

    struct Failure: LocalizedError {
        let status: Int   // 0 = no answer
        let message: String

        var errorDescription: String? { message }
        var needsSignIn: Bool { status == 401 }
    }

    /// The server the app has in use, or nil before any is added.
    static func saved(_ connection: (base: URL, entry: ServerEntry, credential: Credential?)? = ServerRegistry.currentConnection()) -> ShareLink? {
        connection.map {
            ShareLink(server: $0.base, credential: $0.credential,
                      workspace: WorkspacePick.get(server: $0.entry.key, username: $0.entry.username))
        }
    }

    /// The server in use on the first of its routes that answers as that server now. The app forgets the route it last
    /// connected over when the network changes, and the first in its order can be one this network can't reach (a
    /// tailnet address with the tailnet off), so each is asked at once and the first in order that answers is taken.
    static func reachable(_ entry: ServerEntry? = ServerRegistry.read().current, timeout: TimeInterval = 5) async -> ShareLink? {
        guard let entry else { return nil }
        let order = tryOrder(entry)
        let answered = await withTaskGroup(of: String?.self) { group in
            for route in order {
                group.addTask { await answers(route.url, serverId: entry.provisional ? nil : entry.serverId, timeout: timeout) ? route.id : nil }
            }
            var out = Set<String>()
            for await id in group { if let id { out.insert(id) } }
            return out
        }
        guard let route = order.first(where: { answered.contains($0.id) }) ?? entry.activeRoute else { return nil }
        return saved((route.url, entry, ServerRegistry.credential(entry.serverId, route: route)))
    }

    /// The routes to ask: the one the app last connected over, then the rest in the app's order. A plain HTTP address
    /// off the tailnet only when the answer can say it is this server.
    static func tryOrder(_ entry: ServerEntry) -> [Route] {
        let first = entry.activeRoute
        let rest = Routes.usable(entry.routes).filter { $0.id != first?.id && (!$0.needsVerifiedServer || !entry.provisional) }
        return (first.map { [$0] } ?? []) + rest
    }

    /// Whether `base` answers as a Creator Toolset server (`serverId` nil: any).
    private static func answers(_ base: URL, serverId: String?, timeout: TimeInterval) async -> Bool {
        struct Descriptor: Decodable { let serverId: String? }
        var request = URLRequest(url: URL(string: ".well-known/creator-toolset/server", relativeTo: base)?.absoluteURL ?? base)
        request.timeoutInterval = timeout
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let descriptor = try? JSONDecoder().decode(Descriptor.self, from: data) else { return false }
        return serverId == nil || descriptor.serverId == serverId
    }

    private static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    /// One request to this server. The answer's body, or its `{ error }` (else `fallback`) as a Failure.
    private func call(_ path: String, method: String = "POST", json: [String: Any]? = nil, fallback: String) async throws -> Data {
        let request = request(path, method: method, json: json)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await Self.session.data(for: request)
        } catch {
            throw Failure(status: 0, message: "No connection to \(server.host() ?? "the server")")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let error = ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["error"] as? String
            throw Failure(status: status, message: error ?? "\(fallback) (HTTP \(status))")
        }
        return data
    }

    /// A request to this server, as the app's own client builds it (`API.url`, `API.headers`).
    func request(_ path: String, method: String = "POST", json: [String: Any]? = nil) -> URLRequest {
        var request = URLRequest(url: URL(string: String(path.dropFirst()), relativeTo: server)?.absoluteURL ?? server)
        request.httpMethod = method
        for (k, v) in credential?.headers(method: method, url: request.url ?? server) ?? [:] { request.setValue(v, forHTTPHeaderField: k) }
        if let workspace { request.setValue(workspace, forHTTPHeaderField: WorkspacePick.header) }
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return request
    }

    /// Why a shared link is kept, the Analyzer's "Kept for" choice.
    enum Keep: String, CaseIterable {
        case content, format, knowhow

        var label: String {
            switch self {
            case .content: "Content"
            case .format: "Format"
            case .knowhow: "Know-how"
            }
        }

        var hint: String {
            switch self {
            case .content: "You might remake this idea"
            case .format: "You're keeping the layout, not the topic"
            case .knowhow: "Strategy, reference, other: just saved, not indexed"
            }
        }

        /// The fields the share route reads; Know-how replaces content / format.
        var fields: [String: Any] { self == .knowhow ? ["knowhow": true] : ["savedFor": rawValue] }
    }

    /// The share route's body.
    static func shareBody(_ text: String, keep: Keep, projectId: String?) -> [String: Any] {
        var json = keep.fields
        json["text"] = text
        if let projectId { json["projectId"] = projectId }
        return json
    }

    /// Sends what the share sheet handed over; answers the server's one line ("Saved to Content, crawling now", …).
    func share(_ text: String, keep: Keep, projectId: String? = nil) async throws -> String {
        let data = try await call("/api/instagram/share", json: Self.shareBody(text, keep: keep, projectId: projectId),
                                  fallback: "Couldn't save it")
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["message"] as? String ?? "Saved"
    }

    /// The person's projects (one per brand) and the current one (`GET /api/workshop/workspace`).
    struct Workspace: Decodable, Equatable {
        struct Project: Decodable, Equatable, Identifiable {
            let id: String
            let name: String
            /// a project colour key of the website (violet, sky, emerald…)
            let color: String?
        }
        let currentProjectId: String?
        let projects: [Project]
    }

    func workspace() async throws -> Workspace {
        try JSONDecoder().decode(Workspace.self, from: try await call("/api/workshop/workspace", method: "GET",
                                                                       fallback: "Couldn't load your workspaces"))
    }

    /// One of the account's own posts (`POST /api/workshop/own-post`): the session it is linked to already, or the
    /// sessions it could be, best first.
    struct OwnPost: Decodable, Equatable {
        struct Session: Decodable, Equatable { let id: String; let title: String }
        struct Candidate: Decodable, Equatable {
            let id: String
            let title: String
            /// A Workshop status as the server names it ("toPost").
            let status: String
        }
        let own: Bool
        /// the project whose account posted it
        let projectId: String?
        let handle: String?
        let url: String?
        let caption: String?
        let linked: Session?
        let candidates: [Candidate]?
    }

    func ownPost(_ text: String) async throws -> OwnPost {
        try JSONDecoder().decode(OwnPost.self, from: try await call("/api/workshop/own-post", json: ["text": text],
                                                                     fallback: "Couldn't check the post"))
    }

    /// Links a session to the post (`posted` also marks it Published); answers the session's title.
    func link(session id: String, to url: String) async throws -> String {
        let data = try await call("/api/workshop/sessions/\(id)", method: "PATCH", json: ["posted": url],
                                  fallback: "Couldn't link it")
        return ((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?["title"] as? String ?? "the project"
    }

    /// A Workshop status in the website's words (the extension can't see the app's `WorkshopStatus`).
    static func statusLabel(_ status: String) -> String {
        ["draft": "Idea", "writing": "Writing", "ready": "Ready", "production": "In Production", "editing": "Editing",
         "toPost": "Ready to post", "published": "Published", "shelved": "Shelved"][status] ?? status
    }
}
