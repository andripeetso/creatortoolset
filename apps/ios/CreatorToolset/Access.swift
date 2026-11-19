import SwiftUI

/// The app's tabs, the desktop's stages: Chats (the assistant's chats), Plan (ideas and scripts), Make (the edits and
/// Review videos, and the Media Library), Distribute (Ready to post and Finals), then Tools (and Settings). Every tab
/// always shows; one the account can't use says why it's empty (`ToolsetAccess.uses`).
enum AppTab: String, Hashable, CaseIterable {
    case chats, plan, make, distribute, tools

    /// A tab by an older name (`-startTab edits`, a saved `startTab`).
    init?(named raw: String) {
        switch raw {
        case "edits", "upload": self = .make
        case "finals": self = .distribute
        case "more": self = .tools
        default: self.init(rawValue: raw)
        }
    }
}

/// Which tools the account may use on the server in use (Admin → Access on the computer: `off` lists the ones switched
/// off; admins have all of them). Remembered per server between launches so tabs don't jump, asked again on every
/// launch, return to the app and server change.
@MainActor
final class ToolsetAccess: ObservableObject {
    static let shared = ToolsetAccess()

    struct Me: Codable, Equatable {
        let username: String
        let role: String
        let off: [String]?
    }

    /// nil: not known yet, or signed out.
    @Published private(set) var me: Me?
    private var serverId: String?

    /// The server in use's last answer, before the first screen draws (so tabs don't jump and a helper starts on
    /// Upload).
    init() { load(for: API.current?.server.absoluteString) }

    private static let key = "toolsetAccess"
    private var saved: [String: Me] {
        get { UserDefaults.standard.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([String: Me].self, from: $0) } ?? [:] }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: Self.key) }
    }

    /// A tool by its key on the computer (contracts/tools.ts); nil = admins only. Before the account is known,
    /// everything but the admin-only tools shows, and the tool itself asks for the sign-in.
    func allows(_ key: String?) -> Bool { Self.allows(key, me: me) }
    func uses(_ tab: AppTab) -> Bool { Self.uses(tab, me: me) }

    nonisolated static func allows(_ key: String?, me: Me?) -> Bool {
        guard let me else { return key != nil }
        if me.role == "admin" { return true }
        guard let key else { return false }
        return !(me.off ?? []).contains(key)
    }

    /// What a tab holds needs a known account that has its tool: Plan the Workshop, Make's edits the AI Editor or
    /// Review (its Media side has its own gate, `media`), Distribute Finals. Chats and Tools ask for the sign-in
    /// themselves. The tab shows either way.
    nonisolated static func uses(_ tab: AppTab, me: Me?) -> Bool {
        switch tab {
        case .chats, .tools: true
        case .plan: me != nil && allows("workshop", me: me)
        case .make: me != nil && (allows("editor", me: me) || allows("review", me: me))
        case .distribute: me != nil && allows("finals", me: me)
        }
    }

    /// What this server said last time, at once.
    func load(for serverId: String?) {
        self.serverId = serverId
        me = serverId.flatMap { saved[$0] }
    }

    func refresh() async {
        // filed under the server asked, even if another one is picked meanwhile
        guard let api = API.current else { return }
        let id = api.server.absoluteString
        struct Check: Decodable { let user: Me? }
        do {
            let check: Check = try await api.get("/api/auth/check")
            set(check.user, for: id)
        } catch APIError.signedOut {
            set(nil, for: id)
        } catch {
            // offline or a hiccup: keep what we knew
        }
    }

    private func set(_ value: Me?, for id: String) {
        var all = saved
        all[id] = value
        saved = all
        if id == serverId, value != me { me = value }
    }
}

/// Which plug-ins the server in use has, read the way the computer's app learns it (`GET /api/plugins`), and whether
/// its Media Library is a plug-in's (`GET /api/library/:id/sources` lists one with `main: true`). Remembered per
/// server; asked again on sign-in, server change and each return to the app. Whether a plug-in's tools are on for the
/// account is `ToolsetAccess.allows(<its gate>)`.
@MainActor
final class ServerPlugins: ObservableObject {
    static let shared = ServerPlugins()

    struct Source: Codable, Equatable {
        let id: String
        let label: String
    }

    struct Known: Codable, Equatable {
        var plugins: [String] = []
        /// The plug-in source that is this server's Media Library, when one is.
        var mainSource: Source?
    }

    @Published private(set) var known = Known()
    private var serverId: String?

    init() { load(for: API.current?.server.absoluteString) }

    private static let key = "serverPlugins"
    private var saved: [String: Known] {
        get { UserDefaults.standard.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([String: Known].self, from: $0) } ?? [:] }
        set { UserDefaults.standard.set(try? JSONEncoder().encode(newValue), forKey: Self.key) }
    }

    /// The server has this plug-in (by its id).
    func has(_ id: String) -> Bool { known.plugins.contains(id) }
    var mainSource: Source? { known.mainSource }

    func load(for serverId: String?) {
        self.serverId = serverId
        known = serverId.flatMap { saved[$0] } ?? Known()
    }

    func refresh() async {
        guard let api = API.current else { return }
        let id = api.server.absoluteString
        guard let fresh = try? await Self.read(api) else { return }   // offline: keep what we knew
        var all = saved
        all[id] = fresh
        saved = all
        if id == serverId, fresh != known { known = fresh }
    }

    /// The answers in the server's words. A server from before plug-ins answers 404: none.
    nonisolated static func read(_ api: API) async throws -> Known {
        let list: PluginList
        do {
            list = try await api.get("/api/plugins")
        } catch APIError.server(404, _) {
            return Known()
        }
        // only a plug-in can give the Media Library another source
        guard !list.plugins.isEmpty else { return known(list, sources: nil) }
        let libraries: Libraries = try await api.get("/api/library")
        guard let library = libraries.libraries.first else { return known(list, sources: nil) }
        return known(list, sources: try await api.get("/api/library/\(library.id)/sources"))
    }

    nonisolated static func known(_ list: PluginList, sources: Sources?) -> Known {
        Known(plugins: list.plugins.map(\.id),
              mainSource: sources?.sources.first { $0.main == true }.map { Source(id: $0.id, label: $0.label) })
    }

    struct PluginList: Decodable {
        struct Plugin: Decodable { let id: String }
        let plugins: [Plugin]
    }

    struct Libraries: Decodable {
        struct Library: Decodable { let id: String }
        let libraries: [Library]
    }

    struct Sources: Decodable {
        struct Source: Decodable {
            let id: String
            let label: String
            let main: Bool?
        }
        let sources: [Source]
    }
}
