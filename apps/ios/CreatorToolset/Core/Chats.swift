import Combine
import SwiftUI
import UIKit

/// One row of Chats (an assistant's chat) or of Edits (an edit, a Review video): a conversation or a piece
/// of work that talks back.
struct ChatRow: Identifiable, Hashable {
    /// The page of the website it opens ("/editor/<id>", "/review/<id>"): one row per thing.
    let id: String
    let route: AppRoute
    let title: String
    /// The line under the title: what happened last, or what it waits for.
    let detail: String
    var detailIsError = false
    var status: RowStatus
    /// Its newest activity: the order inside a group.
    let at: Date
    var shelf: Shelf = .active
    /// The server's own names for what waits on the person in it right now. A name not seen
    /// before is news (a notification); "Mark read" hands them back to where the row came from.
    var keys: [String] = []
    /// When its work last ended with nothing left to ask: the row says Done until it is opened.
    var finished: Date?
    /// A New edit made on this phone (`PhoneEdit.id`): the phone keeps its row, and a swipe removes it.
    var phoneEdit: UUID?
    /// The picture of its newest cut in Review, when it has one.
    var picture: String?

    /// Where a row sits: with the ones in play, under "Working" while a job runs, under "Done" when it is over.
    enum Shelf: String { case active, working, done }
}

/// A video in Review as the list sends it (`GET /api/review`): only what its row needs.
struct ReviewListItem: Decodable {
    var id: String
    var name: String
    /// "none", "in_progress", "needs_review", "changes" or "approved".
    var status: String
    var versions: Int
    var newComments: Int
    /// Milliseconds since 1970.
    var at: Double
    /// The page of what made it, when something did (an edit made its cut).
    var source: String?
    /// The picture of its newest version that is ready.
    var picture: String?

    private enum Keys: String, CodingKey { case id, name, approval, versions, newComments, updatedAt, createdAt }
    private struct Approval: Decodable { var status: String? }
    /// Each field on its own: one odd value costs the picture, never the versions or what made them.
    private struct Version: Decodable {
        var n: Int?
        var status: String?
        var removed: Bool?
        var createdAt: Double?
        var source: Source?
        struct Source: Decodable { var href: String? }

        private enum Keys: String, CodingKey { case n, status, removed, createdAt, source }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            n = try? c.decode(Int.self, forKey: .n)
            status = try? c.decode(String.self, forKey: .status)
            removed = try? c.decode(Bool.self, forKey: .removed)
            createdAt = try? c.decode(Double.self, forKey: .createdAt)
            source = try? c.decode(Source.self, forKey: .source)
        }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        status = (try? c.decode(Approval.self, forKey: .approval))?.status ?? "none"
        let all = (try? c.decode([Version].self, forKey: .versions)) ?? []
        versions = all.count
        source = all.last?.source?.href
        // the same address Review's own screen asks (`ReviewAsset.media`)
        if let ready = all.last(where: { $0.status == "ready" && $0.removed != true }), let n = ready.n {
            picture = "/api/review/assets/\(id)/v/\(n)/thumb?c=\(Int(ready.createdAt ?? 0))"
        }
        newComments = (try? c.decode(Int.self, forKey: .newComments)) ?? 0
        at = (try? c.decode(Double.self, forKey: .updatedAt)) ?? (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
    }
}

/// A list from the server read one item at a time: an item this version of the app cannot read is
/// left out and counted, so one odd item neither empties the list nor goes unnoticed.
struct Tolerant<Item: Decodable>: Decodable {
    var items: [Item] = []
    var skipped = 0

    init() {}

    init(from decoder: Decoder) throws {
        var list = try decoder.unkeyedContainer()
        while !list.isAtEnd {
            let before = list.currentIndex
            if let item = try? list.decode(Item.self) {
                items.append(item)
            } else {
                _ = try? list.decode(Unread.self)
                skipped += 1
            }
            if list.currentIndex == before { break }   // nothing could be read past this item
        }
    }

    private struct Unread: Decodable {
        init(from decoder: Decoder) throws {}
    }
}

/// A list the server may not have for this account or on this version: then it is nothing.
/// "The server did not answer" is an error, so a list is never emptied by a lost connection.
/// An answer this version of the app cannot read is nothing too, but it is counted
/// (`ChatsModel.unreadable`), so Chats says so instead of showing less without a word.
func orNothing<T>(_ nothing: T, _ read: () async throws -> T) async throws -> T {
    do {
        return try await read()
    } catch let failure as ToolsetAPI.Failure where failure.status == 0 || failure.status == 401 {
        throw failure
    } catch is DecodingError {
        await MainActor.run { ChatsModel.shared.unreadable += 1 }
        return nothing
    } catch {
        return nothing
    }
}

/// What Chats and Edits show, worked out from what the server said: which rows, in which order.
enum ChatList {
    /// The tab a row is on: the assistant's chats on Chats, everything else (edits, Review videos) on Edits.
    static func onChats(_ row: ChatRow) -> Bool { row.route.isAssistant }

    /// A tab's badge: its rows that wait on the person.
    static func waiting(_ rows: [ChatRow], chats: Bool) -> Int {
        rows.filter { onChats($0) == chats && $0.status.waitsOnYou }.count
    }

    /// The page of the website a route stands for, and so its row's id.
    static func path(_ route: AppRoute) -> String {
        switch route {
        case .assistant: "/assistant"
        case .chat(let id): "/?chat=\(id)"
        case .edit(let id): "/editor/\(id)"
        case .review(let id, _): "/review/\(id)"
        case .session(let id): "/workshop/sessions/\(id)"
        case .finals: "/library"
        case .page(let path): path
        }
    }

    /// The assistant's chats, a row each, like any other conversation: the open one in play (its last words, and
    /// whether it asks for something or is writing), the earlier ones under Done, or under Working while a reply
    /// still runs there. An open chat with nothing in it has no row: the round button is the way to a new one.
    static func chats(_ view: AssistantView?) -> [ChatRow] {
        guard let view else { return [] }
        let open = view.messages.isEmpty ? [] : [chat(view)]
        return open + view.past.map { past in
            let route = AppRoute.chat(past.id)
            let at = date(ms: past.at)
            let working = past.working == true
            return ChatRow(id: path(route), route: route, title: past.title, detail: "",
                           status: working ? .working(since: at) : .time(at), at: at, shelf: working ? .working : .done)
        }
    }

    /// A chat's name, as the server gives an earlier one: its first message, on one line, 70 characters at most.
    static func title(_ messages: [AssistantMessage]) -> String {
        let first = (messages.first { $0.role == "user" }?.text ?? "").split(whereSeparator: \.isWhitespace).joined(separator: " ")
        let words = first.isEmpty ? "Conversation" : first
        return words.count > 70 ? String(words.prefix(69)) + "…" : words
    }

    /// The open chat's row: its last words, and whether it asks for something or is writing.
    static func chat(_ view: AssistantView) -> ChatRow {
        let messages = view.messages
        let last = messages.last { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let line = last?.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let status: RowStatus
        // it asks to be allowed something, or asks a yes-or-no before it deletes, publishes or sends
        if messages.contains(where: { $0.approvals?.contains { $0.status == "waiting" } == true
            || $0.confirms?.contains { $0.status == "waiting" } == true }) {
            status = .approval
        } else if let thinking = view.thinking {
            status = .working(since: date(ms: thinking.at))
        } else if let newest = messages.last {
            status = .time(date(ms: newest.at))
        } else {
            status = .none
        }
        let route = AppRoute.chat(view.id)
        var working = false
        if case .working = status { working = true }
        return ChatRow(id: path(route), route: route, title: title(messages),
                       detail: Markdown.plain(line), status: status,
                       at: messages.last.map { date(ms: $0.at) } ?? .distantPast, shelf: working ? .working : .active)
    }

    /// A Review video's row: Review while it waits for the person, under Done once approved.
    static func row(_ video: ReviewListItem) -> ChatRow {
        var words = [video.status == "changes" ? "Changes requested" : "V\(max(video.versions, 1))"]
        if video.newComments > 0 { words.append("\(video.newComments) new comment\(video.newComments == 1 ? "" : "s")") }
        let waits = video.status == "needs_review"
        let when = date(ms: video.at)
        return ChatRow(id: path(.review(video.id, version: nil)), route: .review(video.id, version: nil), title: video.name,
                       detail: words.joined(separator: " · "), status: waits ? .review : .time(when), at: when,
                       shelf: video.status == "approved" || (video.status == "none" && video.newComments == 0) ? .done : .active,
                       keys: waits ? ["\(video.id):v\(video.versions)"] : [], picture: video.picture)
    }

    /// The rows that are not the assistant's. A Review video made by something that has its own
    /// row (an edit's cut) is that row's business and gets none: the row shows its newest picture.
    static func merge(videos: [ReviewListItem], others: [ChatRow]) -> [ChatRow] {
        let have = Set(others.map(\.id))
        func maker(_ video: ReviewListItem) -> String? {
            video.source.flatMap(AppRoute.from(path:)).map(path).flatMap { have.contains($0) ? $0 : nil }
        }
        let newest = videos.filter { $0.picture != nil }.sorted { $0.at > $1.at }
        let rows = others.map { row in
            var row = row
            row.picture = newest.first { maker($0) == row.id }?.picture ?? row.picture
            return row
        }
        return rows + videos.filter { maker($0) == nil }.map(row)
    }

    /// A row he dismissed steps back under Done and says nothing, until something about it changes
    /// (`dismissed`: each row's own time when it was dismissed; a later time means news).
    static func settle(_ rows: [ChatRow], dismissed: [String: Double]) -> [ChatRow] {
        rows.map { row in
            guard let mark = dismissed[row.id], row.at.timeIntervalSince1970 <= mark, row.shelf != .working else { return row }
            var quiet = row
            quiet.shelf = .done
            quiet.status = .time(row.at)
            quiet.finished = nil
            quiet.detailIsError = false
            return quiet
        }
    }

    /// Top to bottom: the rows that wait on the person (newest first), the rest by newest activity,
    /// then the Working shelf and the Done shelf. The assistant's chats are rows like the others.
    /// A finished row says Done until it is opened (`opened`: when each row was last opened;
    /// `since`: when this phone first showed Chats, so old work is not news).
    static func arrange(rows: [ChatRow], opened: [String: Date] = [:], since: Date = .distantPast) -> [ChatRow] {
        let marked = rows.map { row -> ChatRow in
            guard row.shelf == .active, case .time = row.status, let finished = row.finished,
                  finished > (opened[row.id] ?? since) else { return row }
            var done = row
            done.status = .done
            return done
        }
        func newest(_ a: ChatRow, _ b: ChatRow) -> Bool { a.at != b.at ? a.at > b.at : a.id < b.id }
        let active = marked.filter { $0.shelf == .active }
        return active.filter(\.status.waitsOnYou).sorted(by: newest)
            + active.filter { !$0.status.waitsOnYou }.sorted(by: newest)
            + marked.filter { $0.shelf == .working }.sorted(by: newest)
            + marked.filter { $0.shelf == .done }.sorted(by: newest)
    }
}

/// The rows of Chats and of Edits, in one list: the badges, the notifications and the phone's last copy read it.
@MainActor
final class ChatsModel: ObservableObject {
    static let shared = ChatsModel()

    /// In the order of the screen (`ChatList.arrange`); each tab shows its own (`ChatList.onChats`).
    @Published private(set) var rows: [ChatRow] = []
    @Published private(set) var link = Link.ok
    @Published private(set) var offline = false
    /// The server has answered once since launch: an empty list is then really empty.
    @Published private(set) var loaded = false
    /// Something a part of the app says is off, shown above the edits ("MacBook is offline").
    @Published var notice: String?
    /// How many things of the last read this version of the app could not read (the server is
    /// newer than the app, or sends something unexpected). Counted while a read runs, shown after it.
    var unreadable = 0
    @Published private(set) var couldNotRead = 0

    /// Whether this phone is signed in to a computer, and whether that sign-in still holds.
    enum Link { case ok, none, expired }

    /// Rows from parts of the app this file doesn't know: each is asked on every load
    /// (the studio's AI Editor adds its edits this way). A row's id is the page it opens.
    /// Throwing means the server was not reached: the list then stays as it was.
    static var sources: [(ToolsetAPI) async throws -> [ChatRow]] = []
    /// "Mark read" on a row that came from a source: the source tells its server.
    static var markRead: ((ToolsetAPI, ChatRow) async -> Void)?
    /// The server said something changed (anything but the assistant's conversation):
    /// an open screen that shows such a thing reads it again.
    let changed = PassthroughSubject<Void, Never>()

    private var assistant: AssistantView?
    private var videos: [ReviewListItem] = []
    private var others: [ChatRow] = []
    private var opened: [String: Double]
    /// Rows he dismissed, each with the row's own time at that moment (`ChatList.settle`).
    private var dismissed: [String: Double]
    private let since: Date
    /// The account the rows belong to.
    private var key: String?
    private var loading = false
    private var again = false
    private var loadedAt = Date.distantPast
    private var watching: Task<Void, Never>?
    /// The account the change line and the assistant follow.
    private var watchingKey: String?
    private var observing = false
    private var soon: Task<Void, Never>?
    private var bag = Set<AnyCancellable>()

    private init() {
        let defaults = UserDefaults.standard
        opened = defaults.dictionary(forKey: "chats.opened") as? [String: Double] ?? [:]
        dismissed = defaults.dictionary(forKey: "chats.dismissed") as? [String: Double] ?? [:]
        if defaults.object(forKey: "chats.since") == nil { defaults.set(Date().timeIntervalSince1970, forKey: "chats.since") }
        since = Date(timeIntervalSince1970: defaults.double(forKey: "chats.since"))
        if let api = ToolsetAPI.current, debugArg("ChatsSignedOut") == nil {
            restore(api)
        } else {
            link = .none
        }
        AssistantModel.shared.$view.sink { [weak self] view in
            MainActor.assumeIsolated {
                self?.assistant = view
                self?.rebuild()
            }
        }.store(in: &bag)
        // a screen pushed on Chats or Edits is its row opened, and so is one he comes back from:
        // what finished while he watched is not news
        for stack in [AppNavigator.shared.$chats, AppNavigator.shared.$edits] {
            var open: [AppRoute] = []   // the screens open on that tab, as last seen
            stack.sink { [weak self] routes in
                MainActor.assumeIsolated {
                    let seen = open.filter { !routes.contains($0) } + [routes.last].compactMap { $0 }
                    open = routes
                    for route in seen { self?.markOpened(ChatList.path(route)) }
                }
            }.store(in: &bag)
        }
        // the phone's New edits: their rows move with every Start, answer and clip that lands (not with each byte)
        PhoneEdits.shared.objectWillChange.receive(on: DispatchQueue.main).sink { [weak self] _ in
            MainActor.assumeIsolated { self?.rebuild() }
        }.store(in: &bag)
        UploadEngine.shared.store.$items
            .map { $0.filter { $0.edit != nil }.map { "\($0.id) \($0.state.rawValue) \($0.uploadId ?? "")" } }
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in MainActor.assumeIsolated { self?.rebuild() } }
            .store(in: &bag)
        // another server picked (or the last one removed): its own conversation, change line and list
        Servers.shared.$currentId.dropFirst().removeDuplicates().receive(on: DispatchQueue.main).sink { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.watching != nil else { return }
                self.watch()
                Task { await self.load() }
            }
        }.store(in: &bag)
    }

    /// Follows the server for as long as the app runs: once now, on every change it tells of,
    /// and when the app comes back to the front. Another server in use starts it again, there.
    func watch() {
        let now = ToolsetAPI.current?.cacheKey
        guard watching == nil || watchingKey != now else { return }
        if watching != nil {
            watching?.cancel()
            AssistantModel.shared.reset()
        }
        watchingKey = now
        AssistantModel.shared.watch()
        watching = Task { [weak self] in
            await self?.load()
            for await event in ServerEvents.stream("/api/sync/events") {
                guard let self else { return }
                if event.name == "hello" {
                    // after every reconnect: a change may have been missed meanwhile
                    self.changed.send()
                    if Date().timeIntervalSince(self.loadedAt) > 3 { await self.load() }
                } else if event.name == "change", event.field("topic") != "assistant" {
                    self.changed.send()
                    self.loadSoon()
                }
            }
        }
        guard !observing else { return }
        observing = true
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, Date().timeIntervalSince(self.loadedAt) > 3 else { return }
                await self.load()
            }
        }
    }

    /// A job at work tells of every step, often twice in a row: one read for a burst.
    private func loadSoon() {
        soon?.cancel()
        soon = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            guard !Task.isCancelled else { return }
            await self?.load()
        }
    }

    func load() async {
        guard let api = ToolsetAPI.current, debugArg("ChatsSignedOut") == nil else {
            key = nil
            videos = []
            others = []
            notice = nil
            offline = false
            link = .none
            rebuild()
            return
        }
        if api.cacheKey != key { restore(api) }   // another computer picked: its own last copy, then its answer
        guard !loading else {
            again = true
            return
        }
        loading = true
        defer { loading = false }
        await PhoneEdits.shared.refresh()
        repeat {
            again = false
            unreadable = 0
            do {
                async let list: Tolerant<ReviewListItem> = orNothing(Tolerant()) { try await api.get("/api/review") }
                var fresh: [ChatRow] = []
                for source in Self.sources { fresh += try await source(api) }
                let read = try await list
                let seen = read.items
                guard api.cacheKey == key else { return }
                couldNotRead = unreadable + read.skipped
                videos = seen
                others = fresh
                offline = false
                link = .ok
                loaded = true
                loadedAt = Date()
                rebuild()
                DiskCache.write("chats-\(api.cacheKey)", ChatList.merge(videos: seen, others: fresh).map(SavedRow.init))
            } catch {
                // the list stays as it was
                let expired = (error as? ToolsetAPI.Failure)?.status == 401
                offline = !expired
                if expired { link = .expired }
            }
        } while again
    }

    private func markOpened(_ id: String) {
        guard rows.contains(where: { $0.id == id }) else { return }
        // ponytail: one small entry per thing ever opened, never pruned; prune to the rows on screen if it grows
        opened[id] = Date().timeIntervalSince1970
        UserDefaults.standard.set(opened, forKey: "chats.opened")
        rebuild()
    }

    /// The last copy from disk, shown at once.
    private func restore(_ api: ToolsetAPI) {
        key = api.cacheKey
        link = .ok
        videos = []
        others = (DiskCache.read("chats-\(api.cacheKey)", as: [SavedRow].self) ?? []).compactMap(\.row)
        rebuild()
    }

    private func rebuild() {
        let fresh = link == .none ? [] : ChatList.arrange(
            rows: ChatList.settle(ChatList.phone(PhoneEdits.shared.here, over: ChatList.merge(videos: videos, others: others),
                                                 opened: Set(opened.keys)), dismissed: dismissed) + ChatList.chats(assistant),
            opened: opened.mapValues(Date.init(timeIntervalSince1970:)), since: since)
        if fresh != rows { rows = fresh }
    }

    // MARK: Dismiss and delete

    /// Which rows a swipe can dismiss: everything in play but the assistant's chats.
    nonisolated static func canDismiss(_ row: ChatRow) -> Bool { !row.route.isAssistant && row.shelf == .active && row.phoneEdit == nil }

    /// Only a Review video can be deleted from here: it goes to Review's trash and can be brought back.
    nonisolated static func canDelete(_ row: ChatRow) -> Bool {
        if case .review = row.route, row.phoneEdit == nil { return true }
        return false
    }

    /// "Leave me alone with this": the server stops asking (a video that waits for his review goes back
    /// to no status; a source's row is marked read), and the row steps back under Done until it changes.
    func dismiss(_ rows: [ChatRow]) async {
        guard let api = ToolsetAPI.current else { return }
        for row in rows {
            markOpened(row.id)
            if case .review(let id, _) = row.route {
                if row.status == .review {
                    _ = try? await api.send("/api/review/assets/\(id)/approval", json: ["status": "none"])
                }
            } else if !row.keys.isEmpty {
                await Self.markRead?(api, row)
            }
        }
        await load()
        // the mark is the row's own time AFTER the server took it: only a later change brings it back
        let now = Dictionary(ChatList.merge(videos: videos, others: others).map { ($0.id, $0.at.timeIntervalSince1970) },
                             uniquingKeysWith: { first, _ in first })
        for row in rows { dismissed[row.id] = max(now[row.id] ?? 0, row.at.timeIntervalSince1970) }
        UserDefaults.standard.set(dismissed, forKey: "chats.dismissed")
        rebuild()
    }

    /// Deletes a Review video: into Review's trash, where it stays for 30 days.
    func delete(_ row: ChatRow) async {
        guard let api = ToolsetAPI.current, case .review(let id, _) = row.route else { return }
        do {
            try await api.send("/api/review/assets/\(id)", method: "DELETE")
            videos.removeAll { $0.id == id }
            rebuild()
            await load()
        } catch {
            notice = error.localizedDescription
        }
    }
}

/// A row as it is kept on disk between launches.
private struct SavedRow: Codable {
    var id: String
    var title: String
    var detail: String
    var error: Bool
    /// "yourGo", "review", "failed", "working" (with `date` when it started) or "time" (with `date`).
    var status: String
    var date: Double?
    var at: Double
    var shelf: String
    var keys: [String]
    var finished: Double?
    var picture: String?

    init(_ row: ChatRow) {
        id = row.id
        title = row.title
        detail = row.detail
        error = row.detailIsError
        at = row.at.timeIntervalSince1970
        shelf = row.shelf.rawValue
        keys = row.keys
        finished = row.finished?.timeIntervalSince1970
        picture = row.picture
        switch row.status {
        case .yourGo: status = "yourGo"
        case .approval: status = "approval"
        case .review: status = "review"
        case .failed: status = "failed"
        case .working(let since):
            status = "working"
            date = since?.timeIntervalSince1970
        case .time(let when):
            status = "time"
            date = when.timeIntervalSince1970
        case .done, .none: status = "none"
        }
    }

    var row: ChatRow? {
        guard let route = AppRoute.from(path: id) else { return nil }
        let when = date.map(Date.init(timeIntervalSince1970:))
        let status: RowStatus = switch self.status {
        case "yourGo": .yourGo
        case "approval": .approval
        case "review": .review
        case "failed": .failed
        case "working": .working(since: when)
        case "time": when.map(RowStatus.time) ?? .none
        default: .none
        }
        return ChatRow(id: id, route: route, title: title, detail: detail, detailIsError: error, status: status,
                       at: Date(timeIntervalSince1970: at), shelf: ChatRow.Shelf(rawValue: shelf) ?? .active, keys: keys,
                       finished: finished.map(Date.init(timeIntervalSince1970:)), picture: picture)
    }
}

/// Chats (the assistant's chats, one row each) or Edits (`edits`: every AI Editor edit and Review video,
/// as cards), the ones that wait on top.
struct ChatsView: View {
    var edits = false
    @ObservedObject private var model = ChatsModel.shared
    @ObservedObject private var access = ToolsetAccess.shared
    @State private var query = ""
    @AppStorage("chats.working.open") private var workingOpen = true
    @AppStorage("chats.done.open") private var doneOpen = false
    @State private var doneShown = 10
    @State private var signingIn = false
    @State private var deleting: ChatRow?
    @State private var askDismissAll = false
    /// `-newEdit YES` opens New edit at launch (simulator screenshots).
    @State private var newEdit = UserDefaults.standard.bool(forKey: "newEdit")
    /// A New edit that stopped: Try again or Remove.
    @State private var stopped: ChatRow?

    var body: some View {
        Group {
            if model.link == .none {
                WideButton(title: "Add a computer", systemImage: "desktopcomputer") { signingIn = true }
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                list
            }
        }
        .navigationTitle(edits ? "Edits" : "Chats")
        .task { model.watch() }
        .sheet(isPresented: $signingIn, onDismiss: {
            Task {
                await ToolsetAccess.shared.refresh()
                await model.load()
            }
        }) {
            SignInAgainView()
        }
    }

    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    /// This tab's rows that match the search.
    private var shown: [ChatRow] {
        let words = query.trimmingCharacters(in: .whitespaces).lowercased()
        return model.rows.filter { row in
            ChatList.onChats(row) != edits
                && (words.isEmpty || row.title.lowercased().contains(words) || row.detail.lowercased().contains(words))
        }
    }

    private var list: some View {
        let rows = shown
        return List {
            if model.link == .expired || model.offline || (edits && (model.notice != nil || model.couldNotRead > 0)) { header }
            if edits {
                work(rows)
            } else {
                // one kind of thing, one flat list: a chat that asks on top, then the newest
                ForEach(rows) { row in
                    opens(row) { ChatListRow(title: row.title, detail: row.detail, status: row.status) }
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 36)
        .searchable(text: $query, prompt: "Search")
        .refreshable { await model.load() }
        .overlay {
            if edits, model.loaded, rows.isEmpty, !searching {
                Text("No edits yet.").foregroundStyle(.secondary)
            }
        }
        .toolbar {
            if edits, access.allows("editor") {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New edit") { newEdit = true }
                }
            }
            // everything that waits for his review, in one go
            let reviews = rows.filter { $0.shelf == .active && $0.status == .review }
            if edits, reviews.count > 1 {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Dismiss all \(reviews.count) reviews", systemImage: "checkmark") { askDismissAll = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .confirmationDialog("Dismiss all \(reviews.count) reviews?", isPresented: $askDismissAll, titleVisibility: .visible) {
                        Button("Dismiss all") { Task { await model.dismiss(reviews) } }
                    }
                }
            }
        }
        .confirmationDialog("Delete “\(deleting?.title ?? "")”?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                            titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let row = deleting { Task { await model.delete(row) } }
            }
        } message: {
            Text("It stays in Review's trash for 30 days.")
        }
        .confirmationDialog(stopped?.title ?? "", isPresented: Binding(get: { stopped != nil }, set: { if !$0 { stopped = nil } }),
                            titleVisibility: .visible, presenting: stopped) { row in
            Button("Try again") { if let id = row.phoneEdit { Task { await PhoneEdits.shared.retry(id) } } }
            Button("Remove", role: .destructive) { if let id = row.phoneEdit { PhoneEdits.shared.forget(id) } }
        } message: { row in
            Text(row.detail)
        }
        .sheet(isPresented: edits ? $newEdit : .constant(false)) { NewEditView() }
        // on Chats the round New chat button sits over the end of the list
        .contentMargins(.bottom, edits ? 16 : 84, for: .scrollContent)
    }

    /// The edits and videos in play as cards, then the Working and Done shelves.
    @ViewBuilder private func work(_ rows: [ChatRow]) -> some View {
        let working = rows.filter { $0.shelf == .working }
        let done = rows.filter { $0.shelf == .done }
        ForEach(rows.filter { $0.shelf == .active }) { row in
            card(row)
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                    if let id = row.phoneEdit {
                        // off the phone's list; the edit stays on the server
                        Button("Remove", systemImage: "trash") { PhoneEdits.shared.forget(id) }.tint(.red)
                    }
                    if ChatsModel.canDismiss(row) {
                        Button("Dismiss", systemImage: "checkmark") { Task { await model.dismiss([row]) } }.tint(.gray)
                    }
                    if ChatsModel.canDelete(row) {
                        Button("Delete", systemImage: "trash") { deleting = row }.tint(.red)
                    }
                }
        }
        if !working.isEmpty {
            ShelfHeader(title: "Working", count: working.count, open: $workingOpen)
            if workingOpen || searching {
                ForEach(working, content: card)
            }
        }
        if !done.isEmpty {
            ShelfHeader(title: "Done", count: done.count, open: $doneOpen)
            if doneOpen || searching {
                ForEach(done.prefix(doneShown)) { row in
                    card(row)
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            if ChatsModel.canDelete(row) {
                                Button("Delete", systemImage: "trash") { deleting = row }.tint(.red)
                            }
                        }
                }
                if done.count > doneShown {
                    Button("Show more") { doneShown += 20 }
                        .font(.footnote.weight(.medium))
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .slimListRow()
                }
            }
        }
    }

    private func card(_ row: ChatRow) -> some View {
        opens(row) { WorkCard(row: row) }
            .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    /// What is off, when something is.
    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.link == .expired {
                Button("Sign in again") { signingIn = true }.font(.subheadline.weight(.semibold)).frame(minHeight: 44)
            } else if model.offline {
                QuietNotice(text: "No connection")
            } else if edits, let notice = model.notice {
                QuietNotice(text: notice)
            }
            if edits, model.couldNotRead > 0 {
                QuietNotice(text: "Some things could not be read. Update the app.")
            }
        }
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
    }

    /// A row that opens its screen the way a card or a notification does. No arrow at the right: the badge sits there.
    private func opens<Label: View>(_ row: ChatRow, @ViewBuilder label: () -> Label) -> some View {
        Button { tap(row) } label: { label() }.buttonStyle(.plain)
    }

    /// A New edit still starting has nothing to open yet, and one that stopped asks what to do.
    private func tap(_ row: ChatRow) {
        if let id = row.phoneEdit, let edit = PhoneEdits.shared.item(id) {
            switch PhoneEdits.shared.state(edit) {
            case .starting: return
            case .failed:
                stopped = row
                return
            default: break
            }
        }
        AppNavigator.shared.open(row.route)
    }
}

/// An edit or a Review video as a card: the picture of its newest cut (a quiet film tile until it has one),
/// its name, where it is, and the badge.
private struct WorkCard: View {
    let row: ChatRow

    var body: some View {
        HStack(spacing: 12) {
            Group {
                if let picture = row.picture {
                    ToolsetImage(path: picture, maxPixels: 240)
                } else {
                    Image(systemName: "film")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(.tertiary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(.tertiarySystemFill))
                }
            }
            .frame(width: 54, height: 72)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(row.title).font(.body.weight(.semibold)).lineLimit(2)
                if !row.detail.isEmpty {
                    Text(row.detail)
                        .font(.footnote)
                        .foregroundStyle(row.detailIsError ? Color.red : Color.secondary)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            RowBadge(status: row.status)
        }
        .padding(10)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
        .contentShape(RoundedRectangle(cornerRadius: 18))
    }
}

/// "Working (2)" with a hairline and an arrow: a tap folds the rows under it.
private struct ShelfHeader: View {
    let title: String
    let count: Int
    @Binding var open: Bool

    var body: some View {
        Button { open.toggle() } label: {
            HStack(spacing: 10) {
                Text("\(title) (\(count))").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                Rectangle().fill(Color(.separator)).frame(height: 0.5)
                Image(systemName: "chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(open ? 180 : 0))
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .slimListRow()
        .accessibilityLabel("\(title), \(count)")
        .accessibilityValue(open ? "Open" : "Closed")
    }
}

private extension View {
    /// A row of a shelf: close to its neighbours, no line between them.
    func slimListRow() -> some View {
        listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
    }
}
