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
    /// False when no route answered the probe and this link fell back to an unprobed safe route.
    var reached = true

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
    /// tailnet address with the tailnet off), so each is asked at once. A higher-priority route keeps a short
    /// `headStart` before a lower-priority answer wins; once decided, slower probes are cancelled.
    static func reachable(_ entry: ServerEntry? = ServerRegistry.read().current,
                          timeout: TimeInterval = 5,
                          headStart: TimeInterval = 0.5,
                          credential: ((Route) -> Credential?)? = nil,
                          now: Date = Date(),
                          probe: (@Sendable (Route, String?, TimeInterval) async -> Bool)? = nil) async -> ShareLink? {
        guard let entry else { return nil }
        let readCred = credential ?? { ServerRegistry.credential(entry.serverId, route: $0) }
        let order = tryOrder(entry, credential: readCred, now: now)
        let serverId = entry.provisional ? nil : entry.serverId
        let ask = probe ?? { route, id, t in await answers(route.url, serverId: id, timeout: t) }
        if let index = await pickRoute(order, headStart: headStart, probe: { await ask($0, serverId, timeout) }) {
            let route = order[index]
            return saved((route.url, entry, readCred(route)))
        }
        // None answered: fall back only to a route that needs no server check (never plain HTTP outside the tailnet),
        // preferring HTTPS over a plain-HTTP tailnet address.
        let safe = order.filter { !$0.needsVerifiedServer }
        let activeFallback = entry.activeRoute.flatMap { $0.needsVerifiedServer ? nil : $0 }
        guard let route = safe.first(where: { !$0.isPlainHTTP }) ?? safe.first ?? activeFallback else { return nil }
        var link = saved((route.url, entry, readCred(route)))
        link?.reached = false
        return link
    }

    /// The routes to ask: the one the app last connected over, then the rest in the app's order. A plain HTTP address
    /// off the tailnet only when the answer can say it is this server. When any route has a live credential, routes
    /// with a missing or expired credential are skipped so they don't win the unauthenticated probe and 401.
    static func tryOrder(_ entry: ServerEntry,
                         credential: ((Route) -> Credential?)? = nil,
                         now: Date = Date()) -> [Route] {
        let readCred = credential ?? { ServerRegistry.credential(entry.serverId, route: $0) }
        let allUsable = Routes.usable(entry.routes)
        let active = entry.activeRouteId.flatMap { id in allUsable.first { $0.id == id } }
        let rest = allUsable.filter { $0.id != active?.id && (!$0.needsVerifiedServer || !entry.provisional) }
        let ordered = (active.map { [$0] } ?? []) + rest
        let ready = ordered.filter { readCred($0).map { !$0.expired(now) } ?? false }
        return ready.isEmpty ? ordered : ready
    }

    private enum ProbeEvent: Sendable {
        case probed(Int, Bool)
        case headStartEnded
    }

    /// Probes every route in `order` concurrently and returns the lowest index that answers. A lower-priority answer
    /// waits at most `headStart` for higher-priority routes; once decided, remaining probes are cancelled immediately.
    static func pickRoute(_ order: [Route], headStart: TimeInterval = 0.5,
                          probe: @escaping @Sendable (Route) async -> Bool) async -> Int? {
        guard !order.isEmpty else { return nil }
        return await withTaskGroup(of: ProbeEvent.self) { group in
            for (index, route) in order.enumerated() {
                group.addTask { .probed(index, await probe(route)) }
            }
            let waitHeadStart = order.count > 1 && headStart > 0
            if waitHeadStart {
                group.addTask {
                    try? await Task.sleep(for: .seconds(headStart))
                    return .headStartEnded
                }
            }
            var resolved = Set<Int>()
            var answered = Set<Int>()
            var headStartDone = !waitHeadStart

            func bestReady() -> Int? {
                guard let best = answered.min() else { return nil }
                return (headStartDone || (0..<best).allSatisfy { resolved.contains($0) }) ? best : nil
            }

            for await event in group {
                switch event {
                case .probed(let index, let ok):
                    resolved.insert(index)
                    if ok { answered.insert(index) }
                case .headStartEnded:
                    headStartDone = true
                }
                if let winner = bestReady() {
                    group.cancelAll()
                    return winner
                }
                if resolved.count == order.count {
                    group.cancelAll()
                    return answered.min()
                }
            }
            return answered.min()
        }
    }

    /// Whether `base` answers as this Creator Toolset server (`serverId` nil: any server with a valid descriptor).
    static func answers(_ base: URL, serverId: String?, timeout: TimeInterval, session: URLSession = probeSession) async -> Bool {
        struct Descriptor: Decodable {
            let serverId: String
            let label: String
            let protocolVersion: Int

            enum CodingKeys: String, CodingKey {
                case serverId, label
                case protocolVersion = "protocol"
            }
        }
        var request = URLRequest(url: URL(string: ".well-known/creator-toolset/server", relativeTo: base)?.absoluteURL ?? base)
        request.timeoutInterval = timeout
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let descriptor = try? JSONDecoder().decode(Descriptor.self, from: data),
              !descriptor.serverId.isEmpty else { return false }
        return serverId == nil || descriptor.serverId == serverId
    }

    private final class ProbeNoRedirect: NSObject, URLSessionTaskDelegate {
        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest) async -> URLRequest? { nil }
    }

    /// No redirects followed and nothing cached: a cached answer or redirect would speak for an untrusted host.
    static let probeSession: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: config, delegate: ProbeNoRedirect(), delegateQueue: nil)
    }()

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
