import Combine
import SwiftUI

/// One of the person's workspaces (one brand) on a server, as `GET /api/workshop/workspace` lists them; the API calls it
/// a project.
struct Workspace: Codable, Identifiable, Hashable {
    var id: String
    var name: String
    /// Its colour's name (`Workspaces.palette`); missing on one from before colours.
    var color: String?
    var createdAt: Double?

    /// Its two letters: the first of its first two words ("Tiny Acrobatics" TA), or its first two letters.
    var initials: String { Workspace.initials(name) }

    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: \.isWhitespace).filter { $0.contains { $0.isLetter || $0.isNumber } }
        let two = words.count > 1 ? "\(words[0].first!)\(words[1].first!)" : String((words.first ?? "?").prefix(2))
        return two.uppercased()
    }
}

/// A row of the switcher: a workspace on one of the servers saved on the phone. A server that lists none (an older
/// one, or one not reached yet) is a row of its own, under its name, so every server can still be reached.
struct WorkspaceEntry: Identifiable, Hashable {
    let server: Server
    let workspace: Workspace?

    var id: String { server.id + "|" + (workspace?.id ?? "") }
    var name: String { workspace?.name ?? server.name }
}

/// What waits on the person in a workspace: the switcher's line and count, and the line on Chats about the others.
struct WorkspaceWaiting: Codable, Equatable {
    var reviews = 0
    var chats = 0

    var total: Int { reviews + chats }

    var line: String? {
        var parts: [String] = []
        if reviews > 0 { parts.append(reviews == 1 ? "1 cut to review" : "\(reviews) cuts to review") }
        if chats > 0 { parts.append(chats == 1 ? "1 chat waiting" : "\(chats) chats waiting") }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

/// The workspaces of every server saved on the phone, and the one the phone works in. It scopes the whole app: every
/// request names it (`API.workspace`), every list and picture is kept per workspace (`API.cacheKey`). Picking one on
/// another server makes that server the one in use; the person never picks a computer. The pick is the phone's own
/// (`WorkspacePick`), never written to the server.
@MainActor
final class Workspaces: ObservableObject {
    static let shared = Workspaces()

    /// Each saved server's workspaces, as it last answered (kept between launches), by server id.
    @Published private(set) var lists: [String: [Workspace]]
    /// The workspace the phone works in on the server in use; nil before one is known (the server's own rule).
    @Published private(set) var picked: String?
    /// What waits in each workspace, by entry id.
    @Published private(set) var waiting: [String: WorkspaceWaiting] = [:]
    /// The switcher sheet is up.
    @Published var choosing = debugArg("SwitcherOpen") != nil
    /// "Switched to Tiny Acrobatics", after a notification or a link moved the app.
    @Published var toast: String?

    private static let listsKey = "workspaces.lists"
    private var lookedAt = Date.distantPast
    private var bag = Set<AnyCancellable>()

    private init() {
        lists = UserDefaults.standard.data(forKey: Self.listsKey)
            .flatMap { try? JSONDecoder().decode([String: [Workspace]].self, from: $0) } ?? [:]
        picked = API.current?.workspace
        #if DEBUG
        if PhoneDemo.on {
            lists = PhoneDemo.lists
            waiting = PhoneDemo.waiting
        }
        #endif
        // another server in use (signed in to a new one, the one in use removed): its own pick
        Servers.shared.$currentId.dropFirst().removeDuplicates().receive(on: DispatchQueue.main).sink { [weak self] _ in
            MainActor.assumeIsolated {
                self?.apply(API.current?.workspace)
                Task { await self?.load() }
            }
        }.store(in: &bag)
    }

    // MARK: Reading

    /// Every workspace of every saved server, in the order the servers were added, each server's in its own order.
    nonisolated static func entries(servers: [Server], lists: [String: [Workspace]]) -> [WorkspaceEntry] {
        servers.flatMap { server -> [WorkspaceEntry] in
            let list = lists[server.id] ?? []
            return list.isEmpty ? [WorkspaceEntry(server: server, workspace: nil)] : list.map { WorkspaceEntry(server: server, workspace: $0) }
        }
    }

    /// The servers the switcher spans: every one saved on the phone and switched on, whichever route reaches it.
    var servers: [Server] { Connections.shared.servers.filter(\.enabled).map(\.server) }

    var entries: [WorkspaceEntry] { Self.entries(servers: servers, lists: lists) }

    /// The entry the phone is in: the picked workspace on the server in use (its first, or the server itself, until
    /// one is picked).
    var current: WorkspaceEntry? {
        let here = entries.filter { $0.server.id == Servers.shared.currentId }
        return here.first { $0.workspace?.id == picked } ?? here.first
    }

    func isCurrent(_ entry: WorkspaceEntry) -> Bool { entry.id == current?.id }

    /// Chats that wait on the person in every workspace but this one.
    var chatsElsewhere: Int {
        let here = current?.id
        return waiting.filter { $0.key != here }.values.reduce(0) { $0 + $1.chats }
    }

    /// Every saved server's workspaces, asked at once; each server's pick is settled (a pick that is gone falls back).
    func load() async {
        #if DEBUG
        if PhoneDemo.on { return }
        #endif
        struct Answer: Decodable {
            var currentProjectId: String?
            var projects: Tolerant<Workspace>
        }
        let servers = self.servers
        let answers = await withTaskGroup(of: (Server, Answer?).self) { group in
            for server in servers {
                group.addTask { (server, try? await API.connected(server)?.get("/api/workshop/workspace")) }
            }
            var all: [(Server, Answer?)] = []
            for await answer in group { all.append(answer) }
            return all
        }
        var fresh = lists.filter { id, _ in servers.contains { $0.id == id } }
        for (server, answer) in answers {
            guard let answer else { continue }   // not reached: what it said last time stays
            let list = answer.projects.items
            fresh[server.id] = list
            let kept = WorkspacePick.get(server: server.id, username: server.username)
            let settled = WorkspacePick.resolve(kept: kept, ids: list.map(\.id), current: answer.currentProjectId)
            if settled != kept { WorkspacePick.set(settled, server: server.id, username: server.username) }
            if server.id == Servers.shared.currentId { apply(settled) }
        }
        if fresh != lists {
            lists = fresh
            UserDefaults.standard.set(try? JSONEncoder().encode(fresh), forKey: Self.listsKey)
        }
    }

    /// What waits in each workspace: its Review videos that wait for a review, and its chats that ask something. At
    /// most every 20 seconds unless `force`.
    func look(force: Bool = false) async {
        #if DEBUG
        if PhoneDemo.on { return waiting = PhoneDemo.waiting }
        #endif
        guard force || Date().timeIntervalSince(lookedAt) > 20 else { return }
        lookedAt = Date()
        let entries = self.entries
        let fresh = await withTaskGroup(of: [(String, WorkspaceWaiting)].self) { group in
            for server in servers {
                guard let api = API.connected(server) else { continue }
                let here = entries.filter { $0.server.id == server.id && $0.workspace != nil }
                guard !here.isEmpty else { continue }
                group.addTask {
                    let chats = (try? await api.get("/api/assistant/chats") as ChatSummary.List)?.chats.items ?? []
                    var out: [(String, WorkspaceWaiting)] = []
                    for entry in here {
                        var scoped = api
                        scoped.workspace = entry.workspace?.id
                        let videos = (try? await scoped.get("/api/review") as Tolerant<ReviewListItem>)?.items ?? []
                        out.append((entry.id, Self.waiting(videos: videos, chats: chats, in: entry.workspace?.id)))
                    }
                    return out
                }
            }
            var all: [String: WorkspaceWaiting] = [:]
            for await part in group { for (id, w) in part { all[id] = w } }
            return all
        }
        if fresh != waiting { waiting = fresh }
    }

    nonisolated static func waiting(videos: [ReviewListItem], chats: [ChatSummary], in workspace: String?) -> WorkspaceWaiting {
        WorkspaceWaiting(reviews: videos.filter { $0.status == "needs_review" }.count,
                         chats: chats.filter { $0.workspace == workspace && $0.asks == true }.count)
    }

    // MARK: Moving

    /// Makes `entry` the phone's workspace, and its server the one in use. Every tab starts again there.
    func pick(_ entry: WorkspaceEntry) {
        let servers = Servers.shared
        if let ws = entry.workspace { WorkspacePick.set(ws.id, server: entry.server.id, username: entry.server.username) }
        if entry.server.id != servers.currentId { servers.use(entry.server.id) }
        // at once, so a screen a link opens next lands in the new workspace (the server sink then finds nothing to do)
        apply(entry.workspace?.id ?? API.current?.workspace)
    }

    /// A notification or a link names a server and a workspace: the app moves there and says so in a toast. Nothing
    /// happens for the one it is in, or for a workspace this phone doesn't know on that server. True when it moved.
    @discardableResult
    func go(server: String?, workspace: String?) -> Bool {
        let servers = Servers.shared
        guard let target = servers.list.first(where: { $0.id == (server ?? servers.currentId) }) else { return false }
        let list = lists[target.id] ?? []
        let ws = workspace.flatMap { id in list.first { $0.id == id } }
        if workspace != nil, ws == nil { return false }
        let entry = WorkspaceEntry(server: target, workspace: ws)
        let here = target.id == servers.currentId && (ws == nil || ws?.id == picked)
        guard !here else { return false }
        pick(entry)
        toast = "Switched to \(entry.name)"
        return true
    }

    /// The workspace a link names in its query (`ws=`), the way the website opens a page in a workspace.
    nonisolated static func asked(in path: String) -> String? {
        URLComponents(string: path)?.queryItems?.first { $0.name == "ws" }?.value.flatMap { $0.isEmpty ? nil : $0 }
    }

    private func apply(_ id: String?) {
        guard id != picked else { return }
        picked = id
        // the screens open on top of a tab were the other workspace's
        let nav = AppNavigator.shared
        nav.chats = []
        nav.plan = []
        nav.make = []
        Task {
            await ChatsModel.shared.load()
            await WorkshopModel.shared.load(force: true)
            await look(force: true)
        }
    }

    // MARK: Colours

    /// The website's colours (`PROJECT_COLORS`, Tailwind 600), by name, in its order.
    static let palette: [(name: String, rgb: (Double, Double, Double))] = [
        ("violet", (124, 58, 237)), ("sky", (2, 132, 199)), ("emerald", (5, 150, 105)), ("amber", (217, 119, 6)),
        ("rose", (225, 29, 72)), ("orange", (234, 88, 12)), ("teal", (13, 148, 136)), ("pink", (219, 39, 119)),
        ("blue", (37, 99, 235)), ("indigo", (79, 70, 229)), ("fuchsia", (192, 38, 211)), ("red", (220, 38, 38)),
        ("lime", (101, 163, 13)), ("cyan", (8, 145, 178)), ("yellow", (202, 138, 4)), ("slate", (71, 85, 105)),
    ]

    /// A workspace's colour, as the website picks it: its own, else the first no other workspace has (oldest first).
    nonisolated static func colorName(of ws: Workspace, in all: [Workspace]) -> String {
        let names = palette.map(\.name)
        func valid(_ c: String?) -> Bool { c.map(names.contains) ?? false }
        if valid(ws.color) { return ws.color! }
        var used = Set(all.compactMap(\.color).filter(valid))
        for other in all.sorted(by: { ($0.createdAt ?? 0) < ($1.createdAt ?? 0) }) where !valid(other.color) {
            let free = names.first { !used.contains($0) } ?? names[0]
            used.insert(free)
            if other.id == ws.id { return free }
        }
        return names.first { !used.contains($0) } ?? names[0]
    }

    func color(of entry: WorkspaceEntry) -> Color {
        guard let ws = entry.workspace else { return .secondary }
        let name = Self.colorName(of: ws, in: lists[entry.server.id] ?? [ws])
        let rgb = Self.palette.first { $0.name == name }!.rgb
        return Color(red: rgb.0 / 255, green: rgb.1 / 255, blue: rgb.2 / 255)
    }
}

/// One chat as `GET /api/assistant/chats` lists it: what the workspace filter and the waiting counts need.
struct ChatSummary: Decodable, Equatable {
    let id: String
    var workspace: String?
    /// It asks the person something (an Allow, a Yes / No, a key).
    var asks: Bool?

    struct List: Decodable { var chats: Tolerant<ChatSummary> }
}

// MARK: Views

/// A workspace's mark: its two letters in its colour, on a pale square of that colour.
struct WorkspaceMark: View {
    let entry: WorkspaceEntry
    var size: CGFloat = 22
    @ObservedObject private var all = Workspaces.shared

    var body: some View {
        let tint = all.color(of: entry)
        Text(Workspace.initials(entry.name))
            .font(.system(size: size * 0.48, weight: .bold))
            .foregroundStyle(tint)
            .frame(width: size, height: size)
            .background(tint.opacity(0.16), in: RoundedRectangle(cornerRadius: size * 0.27))
            .accessibilityHidden(true)
    }
}

/// Top left on every tab: the workspace's mark, its name and a chevron. A tap opens the switcher.
struct WorkspaceSwitcherButton: View {
    @ObservedObject private var workspaces = Workspaces.shared
    @EnvironmentObject private var servers: Servers

    var body: some View {
        Button { workspaces.choosing = true } label: {
            HStack(spacing: 6) {
                if let entry = workspaces.current {
                    WorkspaceMark(entry: entry)
                    // its own width up to a cap: a toolbar item otherwise squeezes the name away
                    Text(entry.name).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                        .frame(maxWidth: 170, alignment: .leading)
                        .fixedSize()
                }
                Image(systemName: "chevron.down").font(.caption2.weight(.bold)).foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Workspace: \(workspaces.current?.name ?? "none")")
        .accessibilityHint("Opens the workspaces")
    }
}

/// The switcher: only workspaces, from every server saved on the phone. The one in use has a check; the others say what
/// waits there. A tap moves the whole app there.
struct WorkspaceSwitcher: View {
    @ObservedObject private var workspaces = Workspaces.shared
    @EnvironmentObject private var servers: Servers
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let entries = workspaces.entries
        let manyServers = Set(entries.map(\.server.id)).count > 1
        NavigationStack {
            List(entries) { entry in
                let current = workspaces.isCurrent(entry)
                let waits = workspaces.waiting[entry.id]
                Button {
                    workspaces.pick(entry)
                    dismiss()
                } label: {
                    HStack(spacing: 12) {
                        WorkspaceMark(entry: entry, size: 30)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.name).font(.body.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                            if let line = current ? nil : waits?.line {
                                Text(line).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                            } else if manyServers {
                                Text(entry.server.name).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                        Spacer(minLength: 8)
                        // one fixed slot at the right: the check, or the count of what waits
                        ZStack {
                            if current {
                                Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(Color.accentColor)
                            } else if let n = waits?.total, n > 0 {
                                Text("\(n)").font(.caption.weight(.bold)).foregroundStyle(.white)
                                    .padding(.horizontal, 7).frame(minWidth: 22, minHeight: 22)
                                    .background(Color.red, in: Capsule())
                            }
                        }
                        .frame(width: 32)
                    }
                    .frame(minHeight: 44)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(current ? .isSelected : [])
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Workspaces")
            .navigationBarTitleDisplayMode(.inline)
        }
        .presentationDetents([.medium, .large])
        .task {
            await workspaces.load()
            await workspaces.look(force: true)
        }
    }
}

/// "Switched to Tiny Acrobatics", at the top for a moment.
struct WorkspaceToast: View {
    @ObservedObject private var workspaces = Workspaces.shared

    var body: some View {
        VStack {
            if let text = workspaces.toast {
                Text(text)
                    .font(.subheadline.weight(.semibold))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
                    .background(.regularMaterial, in: Capsule())
                    .shadow(color: .black.opacity(0.12), radius: 8, y: 2)
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .task(id: text) {
                        try? await Task.sleep(for: .seconds(2.5))
                        withAnimation { workspaces.toast = nil }
                    }
            }
            Spacer()
        }
        .padding(.top, 4)
        .animation(.easeOut(duration: 0.25), value: workspaces.toast)
        .allowsHitTesting(false)
    }
}

extension View {
    /// The workspace switcher, top left: on the first screen of every tab.
    func workspaceSwitcher() -> some View {
        toolbar {
            ToolbarItem(placement: .topBarLeading) { WorkspaceSwitcherButton() }
        }
    }
}
