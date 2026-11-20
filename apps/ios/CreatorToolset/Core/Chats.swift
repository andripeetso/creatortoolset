import Combine
import SwiftUI
import UIKit

/// One row of Chats (an assistant's chat) or of Edits (an edit, a Review video): a conversation or a piece
/// of work that talks back.
struct ChatRow: Identifiable, Hashable {
    /// The page of the website it opens ("/editor/<id>", "/review/<id>"): one row per thing.
    let id: String
    let route: AppRoute
    var title: String
    /// The line under the title: what happened last, or what it waits for.
    var detail: String
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
    /// The workspace it was read in: its picture and its screen ask there, whatever is picked since.
    var workspace: String?
    /// An assistant's chat put away on any device (`GET /api/assistant/chats`): it folds away in Chats, as on the desktop.
    var fold: Fold?
    /// Pinned on any device, and when (ms): at the top of Chats, the newest pin first.
    var pinned: Double?
    /// Snoozed until then: it is back in the list at that time.
    var snoozedUntil: Date?
    /// Settled on any device (folded only while it neither asks nor works).
    var settled = false
    /// The Review video its newest cut waits in: a tap opens it there, at the newest version.
    var review: String?

    /// Where a row sits: with the ones in play, under "Working" while a job runs, under "Done" when it is over.
    enum Shelf: String { case active, working, done }
    /// Snoozed (out of the list until a time) or settled (done with it, kept).
    enum Fold { case snoozed, settled }
}

/// A video in Review as the list sends it (`GET /api/review`): only what its row needs.
struct ReviewListItem: Decodable {
    var id: String
    var name: String
    /// "none", "in_progress", "needs_review", "changes", "rejected" or "approved".
    var status: String
    var versions: Int
    var newComments: Int
    /// Milliseconds since 1970.
    var at: Double
    /// The page of what made it, when something did (an edit made its cut).
    var source: String?
    /// The picture of its newest version that is ready.
    var picture: String?
    /// Its newest version: its number and length in seconds ("v2 is ready · 1:30").
    var newest: Int?
    var duration: Double?

    /// "v2 is ready · 1:30": the line of a video that waits for review.
    var ready: String {
        let n = newest ?? max(versions, 1)
        return "v\(n) is ready" + ((duration ?? 0) > 0 ? " · \(clock(duration ?? 0))" : "")
    }

    private enum Keys: String, CodingKey { case id, name, approval, versions, newComments, updatedAt, createdAt }
    private struct Approval: Decodable { var status: String? }
    /// Each field on its own: one odd value costs the picture, never the versions or what made them.
    private struct Version: Decodable {
        var n: Int?
        var status: String?
        var removed: Bool?
        var createdAt: Double?
        var duration: Double?
        var source: Source?
        struct Source: Decodable { var href: String? }

        private enum Keys: String, CodingKey { case n, status, removed, createdAt, duration, source }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Keys.self)
            n = try? c.decode(Int.self, forKey: .n)
            status = try? c.decode(String.self, forKey: .status)
            removed = try? c.decode(Bool.self, forKey: .removed)
            createdAt = try? c.decode(Double.self, forKey: .createdAt)
            duration = try? c.decode(Double.self, forKey: .duration)
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
        newest = all.last?.n
        duration = all.last?.duration
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
    /// The tab a row is on: the assistant's chats on Chats, everything else (edits, Review videos) on Projects.
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
        let waits = video.status == "needs_review"
        var words = [video.status == "changes" ? "Changes requested" : video.status == "rejected" ? "Rejected" : waits ? video.ready : "v\(max(video.versions, 1))"]
        if video.newComments > 0 { words.append("\(video.newComments) new comment\(video.newComments == 1 ? "" : "s")") }
        let when = date(ms: video.at)
        return ChatRow(id: path(.review(video.id, version: nil)), route: .review(video.id, version: nil), title: video.name,
                       detail: words.joined(separator: " · "), status: waits ? .review : .time(when), at: when,
                       shelf: video.status == "approved" || video.status == "rejected" || (video.status == "none" && video.newComments == 0) ? .done : .active,
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
            // its cut waits in Review: the row opens the cut there and says which version is ready, not the file's name
            if row.status == .review, let video = videos.filter({ maker($0) == row.id }).max(by: { $0.at < $1.at }) {
                row.review = video.id
                row.detail = video.ready
            }
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

/// The rows of Chats and of Projects' edits, in one list: the badges, the notifications and the phone's last copy read it.
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
    /// Each chat's workspace (`GET /api/assistant/chats`), by chat id: each chat's row says its own.
    private var chatSpaces: [String: String] = [:]
    /// Each chat as the list of chats tells it (put away, pinned, its name), by chat id.
    private var chatInfo: [String: ChatSummary] = [:]
    /// When the list shown was asked for: an answer to an older ask is dropped.
    private var chatsAskedAt = Date.distantPast
    /// A re-read when the first snoozed chat is due back.
    private var wake: Task<Void, Never>?
    /// The workspace the edits and Review videos are of (the phone's pick when they were read).
    private var workspace: String?
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
        // a screen pushed on Chats or Projects is its row opened, and so is one he comes back from:
        // what finished while he watched is not news
        for stack in [AppNavigator.shared.$chats, AppNavigator.shared.$projects] {
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
        // the change line and the conversation are the account's, whatever workspace
        let now = ToolsetAPI.current?.accountKey
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
                } else if event.name == "change" {
                    self.foldsSoon()
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

    private var foldsTask: Task<Void, Never>?
    /// A chat that changed may be settled or snoozed no more, or newly: one read of the list of chats for a burst.
    private func foldsSoon() {
        foldsTask?.cancel()
        foldsTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled else { return }
            await self?.readChats()
        }
    }

    private func readChats() async {
        guard let api = ToolsetAPI.current, api.cacheKey == key else { return }
        let asked = Date()
        guard let list = (try? await api.get("/api/assistant/chats") as ChatSummary.List)?.chats.items,
              api.cacheKey == key else { return }
        take(chats: list, asked: asked)
    }

    /// The list of chats as asked for at `asked`; a snoozed chat is read again when it is due back.
    private func take(chats list: [ChatSummary], asked: Date) {
        guard asked >= chatsAskedAt else { return }
        chatsAskedAt = asked
        chatSpaces = ChatList.spaces(list)
        chatInfo = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        rebuild()
        wake?.cancel()
        guard let due = list.compactMap(\.snoozed).min() else { return }
        wake = Task { [weak self] in
            // a second past it: the server says it is back only once its time has gone
            try? await Task.sleep(for: .seconds(max(1, due / 1000 - Date().timeIntervalSince1970 + 1)))
            guard !Task.isCancelled else { return }
            await self?.readChats()
        }
    }

    /// A chat on screen here, with what ended in it: read on every device.
    func seen(_ id: String) async {
        guard let api = ToolsetAPI.current else { return }
        _ = try? await api.send("/api/assistant/chats/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)/seen")
        await readChats()
    }

    // MARK: A chat's own controls, as on the desktop

    /// The whole chat as text, as the desktop copies it: "Me:", "Assistant:" or "Note:" above each message.
    func text(of id: String) async throws -> String {
        guard let api = ToolsetAPI.current else { throw Refusal(text: "No computer is connected.") }
        let view: AssistantView = try await api.get("/api/assistant/chats/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)")
        return ChatList.text(view.messages)
    }

    /// The chat's address on its server, as the desktop's Copy → Chat link gives it.
    func link(of id: String) -> String? {
        guard let api = ToolsetAPI.current, let id = id.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) else { return nil }
        let url = api.url("/?chat=\(id)")
        // shortcut: the address this phone reaches the server at; one only the phone uses (a LAN or relay route) can differ
        // from the desktop's. Upgrade when the server says its own public address.
        return url.host?.hasSuffix(".invalid") == true ? nil : url.absoluteString
    }

    enum ChatAction { case settle(Bool), pin(Bool, at: Double? = nil), snooze(Date?), rename(String), unread, delete }
    struct Refusal: LocalizedError { let text: String; var errorDescription: String? { text } }

    /// What the desktop's menu on a chat does, from the phone. The server tells every device's list.
    func act(_ action: ChatAction, on id: String) async throws {
        guard let api = ToolsetAPI.current else { return }
        let chat = "/api/assistant/chats/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)"
        switch action {
        case .settle(let on): _ = try await api.send("\(chat)/settle", json: ["settled": on])
        case .pin(let on, let at): _ = try await api.send("\(chat)/pin", json: at.map { ["pinned": on, "at": $0] } ?? ["pinned": on])
        case .snooze(let until):
            _ = try await api.send("\(chat)/snooze", json: ["until": until.map { ($0.timeIntervalSince1970 * 1000).rounded() as Any } ?? NSNull()])
        case .rename(let name): _ = try await api.send("\(chat)/title", json: ["title": name])
        case .unread: _ = try await api.send("\(chat)/unread")
        case .delete:
            // only an earlier chat can be deleted: the open one is put among them first, as New chat does
            if AssistantModel.shared.view?.id == id {
                guard !AssistantModel.shared.unsent else { throw Refusal(text: "A message in this chat hasn't gone yet. It can be deleted once it has.") }
                await AssistantModel.shared.newChat()
            }
            _ = try await api.send("/api/assistant/past/\(id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id)", method: "DELETE")
            await AssistantModel.shared.load()
        }
        await readChats()
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
        #if DEBUG
        if PhoneDemo.on { return demo(api) }
        #endif
        if api.cacheKey != key { restore(api) }   // another computer or workspace picked: its own last copy, then its answer
        guard !loading else {
            again = true
            return
        }
        loading = true
        defer {
            loading = false
            // another computer was picked during the read: its own read was put off until this one ended, so it goes now
            if key != nil, api.cacheKey != key { Task { await load() } }
        }
        await PhoneEdits.shared.refresh()
        repeat {
            again = false
            unreadable = 0
            do {
                async let list: Tolerant<ReviewListItem> = orNothing(Tolerant()) { try await api.get("/api/review") }
                // an older server has no list of chats: then every chat shows
                let asked = Date()
                async let chats = (try? await api.get("/api/assistant/chats") as ChatSummary.List)?.chats.items
                var fresh: [ChatRow] = []
                for source in Self.sources { fresh += try await source(api) }
                let read = try await list
                let seen = read.items
                let spaces = await chats
                guard api.cacheKey == key else { return }
                if let spaces { take(chats: spaces, asked: asked) }
                couldNotRead = unreadable + read.skipped
                videos = seen
                others = fresh
                offline = false
                link = .ok
                loaded = true
                loadedAt = Date()
                rebuild()
                DiskCache.write("chats-\(api.cacheKey)", ChatList.merge(videos: seen, others: fresh).map(SavedRow.init))
                Task { await Workspaces.shared.look() }
            } catch {
                // the list stays as it was
                guard api.cacheKey == key else { return }   // the computer that was left did not answer: nothing to say about this one
                let expired = (error as? ToolsetAPI.Failure)?.status == 401
                offline = !expired
                if expired { link = .expired }
            }
        } while again
    }

    #if DEBUG
    /// `-PhoneDemo`: the demo's rows, whatever server.
    private func demo(_ api: ToolsetAPI) {
        restore(api)
        let demo = PhoneDemo.edits()
        videos = demo.videos
        others = demo.others
        chatSpaces = demo.spaces
        loaded = true
        rebuild()
    }
    #endif

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
        workspace = api.workspace
        link = .ok
        videos = []
        others = (DiskCache.read("chats-\(api.cacheKey)", as: [SavedRow].self) ?? []).compactMap(\.row)
        rebuild()
    }

    private func rebuild() {
        let work = ChatList.settle(ChatList.phone(PhoneEdits.shared.here, over: ChatList.merge(videos: videos, others: others),
                                                  opened: Set(opened.keys)), dismissed: dismissed)
        let edits = work.map { row in
            var row = row
            row.workspace = workspace
            return row
        }
        // every workspace's chats, each in its own
        let fresh: [ChatRow] = link == .none ? [] : ChatList.arrange(
            rows: edits + ChatList.placed(ChatList.chats(assistant), spaces: chatSpaces, chats: chatInfo, open: assistant),
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

/// Chats: the assistant's chats of every workspace, one row each saying its workspace, the ones that ask on top.
struct ChatsView: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var model = ChatsModel.shared
    @ObservedObject private var workspaces = Workspaces.shared
    @State private var query = ""
    @AppStorage("chats.snoozed.open") private var snoozedOpen = false
    @AppStorage("chats.settled.open") private var settledOpen = false
    @State private var signingIn = false
    @State private var snoozing: ChatRow?
    @State private var renaming: ChatRow?
    @State private var name = ""
    @State private var deleting: ChatRow?
    @State private var failed: String?
    @State private var customSnooze: ChatRow?
    @State private var customWhen = Date()
    /// What was just done, said at the bottom for a few seconds, with Undo when it can be taken back.
    @State private var done: Done?

    struct Done: Equatable {
        let id = UUID()
        let text: String
        var back: (() async throws -> Void)? = nil
        static func == (a: Done, b: Done) -> Bool { a.id == b.id }
    }

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
        .navigationTitle("Chats")
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

    /// The chats that match the search.
    private var shown: [ChatRow] {
        let words = query.trimmingCharacters(in: .whitespaces).lowercased()
        return model.rows.filter { row in
            ChatList.onChats(row) && (words.isEmpty || row.title.lowercased().contains(words) || row.detail.lowercased().contains(words))
        }
    }

    private var list: some View {
        // one workspace on this computer: naming it on every row says nothing
        let many = (workspaces.lists[servers.currentId ?? ""]?.count ?? 0) > 1
        return List {
            if model.link == .expired { header }
            // one kind of thing, one flat list: pinned ones first, then a chat that asks, then the newest; a search finds every chat
            let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
            let row = { (row: ChatRow) in chatRow(row, many: many) }
            let main = searching ? shown : shown.filter { $0.fold == nil }
            let pinned = main.filter { $0.pinned != nil }.sorted { ($0.pinned ?? 0) > ($1.pinned ?? 0) }
            ForEach(pinned + main.filter { $0.pinned == nil }, content: row)
            // put away on any device: folded under Snoozed and Settled, as on the desktop
            if !searching {
                let snoozed = shown.filter { $0.fold == .snoozed }
                let settled = shown.filter { $0.fold == .settled }
                if !snoozed.isEmpty {
                    ShelfHeader(title: "Snoozed", count: snoozed.count, open: $snoozedOpen)
                    if snoozedOpen { ForEach(snoozed, content: row) }
                }
                if !settled.isEmpty {
                    ShelfHeader(title: "Settled", count: settled.count, open: $settledOpen)
                    if settledOpen { ForEach(settled, content: row) }
                }
            }
        }
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 36)
        .searchable(text: $query, prompt: "Search")
        .refreshable { await model.load() }
        // the round New chat button sits over the end of the list
        .contentMargins(.bottom, 84, for: .scrollContent)
        .confirmationDialog("Snooze until", isPresented: Binding(get: { snoozing != nil }, set: { if !$0 { snoozing = nil } }),
                            titleVisibility: .visible, presenting: snoozing) { row in
            ForEach(SnoozeChoice.all(), id: \.label) { choice in
                Button("\(choice.label) · \(choice.when)") { snooze(row, until: choice.until) }
            }
            Button("Custom…") {
                // a sheet asked for while the dialog is still closing may not show
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { custom(row) }
            }
        }
        .sheet(item: $customSnooze) { row in
            NavigationStack {
                DatePicker("Snooze until", selection: $customWhen, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    .datePickerStyle(.graphical)
                    .padding()
                    .navigationTitle("Snooze until")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { customSnooze = nil } }
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Snooze") {
                                customSnooze = nil
                                snooze(row, until: customWhen)
                            }
                        }
                    }
            }
            .presentationDetents([.large])
        }
        .overlay(alignment: .bottom) {
            if let done {
                HStack(spacing: 12) {
                    Text(done.text).font(.subheadline.weight(.medium)).lineLimit(1)
                    if let back = done.back {
                        Button("Undo") {
                            self.done = nil
                            Task {
                                do { try await back() } catch { failed = error.localizedDescription }
                            }
                        }
                        .font(.subheadline.weight(.semibold))
                    }
                }
                .padding(.horizontal, 18)
                .frame(minHeight: 44)
                .background(.regularMaterial, in: Capsule())
                .overlay(Capsule().strokeBorder(Color(.separator), lineWidth: 0.5))
                .shadow(color: .black.opacity(0.1), radius: 8, y: 3)
                .padding(.bottom, 90)
                .transition(.move(edge: .bottom).combined(with: .opacity))
                .task(id: done.id) {
                    try? await Task.sleep(for: .seconds(5))
                    if self.done?.id == done.id { self.done = nil }
                }
            }
        }
        .animation(.easeOut(duration: 0.2), value: done)
        .alert("Rename chat", isPresented: Binding(get: { renaming != nil }, set: { if !$0 { renaming = nil } }), presenting: renaming) { row in
            TextField("Name", text: $name)
            Button("Save") {
                let words = name.split(whereSeparator: \.isWhitespace).joined(separator: " ")
                if !words.isEmpty, words != row.title { act(.rename(words), row) }
            }
            Button("Cancel", role: .cancel) {}
        }
        .alert(deleting.map { "Delete \"\($0.title)\"?" } ?? "Delete chat?",
               isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { row in
            Button("Delete", role: .destructive) { act(.delete, row) }
            Button("Cancel", role: .cancel) {}
        } message: { _ in
            Text("The chat and its pictures are deleted.")
        }
        .alert("Couldn't change the chat", isPresented: Binding(get: { failed != nil }, set: { if !$0 { failed = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(failed ?? "")
        }
    }

    /// A chat's row, with the desktop's controls. Swipe left: Settle (a full swipe) or Delete. Swipe right: Snooze and Pin.
    /// A long press: the desktop's whole menu (New chat, Pin, Settle, Snooze, Rename, Mark unread, Copy, Workspace settings,
    /// Delete). Settle, Snooze and Unpin can be taken back for a few seconds.
    private func chatRow(_ row: ChatRow, many: Bool) -> some View {
        var working = false
        if case .working = row.status { working = true }
        let id: String = { if case .chat(let id) = row.route { return id } else { return "" } }()
        let open = AssistantModel.shared.view?.id == id
        let detail = row.snoozedUntil.map { "Snoozed until \(SnoozeChoice.when($0))" } ?? row.detail
        return Button { AppNavigator.shared.open(row.route) } label: {
            ChatListRow(title: row.title, detail: detail, status: row.status,
                        workspace: many ? workspaces.entry(row.workspace) : nil) {
                if row.pinned != nil {
                    Image(systemName: "pin.fill").font(.caption).foregroundStyle(.orange).accessibilityLabel("Pinned")
                }
            }
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
        .swipeActions(edge: .trailing, allowsFullSwipe: !working) {
            if row.settled {
                Button("Un-settle", systemImage: "arrow.uturn.backward") { act(.settle(false), row) }.tint(.blue)
            } else if !working {
                // a chat with a reply being written can't be settled
                Button("Settle", systemImage: "checkmark") { settle(row) }.tint(.green)
            }
            Button("Delete", systemImage: "trash") { deleting = row }.tint(.red)
        }
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if row.snoozedUntil != nil {
                Button("Wake", systemImage: "alarm") { act(.snooze(nil), row) }.tint(.indigo)
            } else if !row.settled, !row.status.waitsOnYou {
                // one that asks is back the moment it is put away
                Button("Snooze", systemImage: "clock") { snoozing = row }.tint(.indigo)
            }
            Button(row.pinned == nil ? "Pin" : "Unpin", systemImage: row.pinned == nil ? "pin" : "pin.slash") { pin(row) }
                .tint(.orange)
        }
        .contextMenu {
            Button("New chat", systemImage: "square.and.pencil") { AppNavigator.shared.newChat() }
            Button(row.pinned == nil ? "Pin chat" : "Unpin chat", systemImage: row.pinned == nil ? "pin" : "pin.slash") { pin(row) }
            if row.settled {
                Button("Un-settle chat", systemImage: "arrow.uturn.backward") { act(.settle(false), row) }
            } else if !working {
                Button("Settle chat", systemImage: "checkmark") { settle(row) }
            }
            if row.snoozedUntil != nil {
                Button("Wake chat", systemImage: "alarm") { act(.snooze(nil), row) }
            } else if !row.status.waitsOnYou {
                Menu("Snooze", systemImage: "clock") {
                    ForEach(SnoozeChoice.all(), id: \.label) { choice in
                        Button("\(choice.label) · \(choice.when)") { snooze(row, until: choice.until) }
                    }
                    Divider()
                    Button("Custom…") { custom(row) }
                }
            }
            Divider()
            Button("Rename chat", systemImage: "pencil") {
                name = row.title
                renaming = row
            }
            // the open chat is being looked at: it cannot be not looked at
            if !open, !working, row.status != .done {
                Button("Mark unread", systemImage: "circlebadge") { act(.unread, row) }
            }
            Divider()
            Menu("Copy", systemImage: "doc.on.doc") {
                if let link = model.link(of: id) {
                    Button("Chat link") { copy(link, "Chat link") }
                }
                Button("Chat ID") { copy(id, "Chat ID") }
                Button("Whole chat") {
                    Task {
                        do { copy(try await model.text(of: id), "Whole chat") } catch { failed = error.localizedDescription }
                    }
                }
            }
            Button("Workspace settings", systemImage: "gearshape") {
                let ws = row.workspace?.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
                AppNavigator.shared.open(.page(ws.map { "/projects?edit=\($0)" } ?? "/projects"))
            }
            Divider()
            Button("Delete chat", systemImage: "trash", role: .destructive) { deleting = row }
        }
    }

    private func copy(_ text: String, _ what: String) {
        UIPasteboard.general.string = text
        done = Done(text: "\(what) copied")
    }

    private func custom(_ row: ChatRow) {
        customWhen = Date().addingTimeInterval(3600)
        customSnooze = row
    }

    /// Settled, and its pin and snooze with it; Undo gives them back.
    private func settle(_ row: ChatRow) {
        act(.settle(true), row, done: "Chat settled") { [model] id in
            try await model.act(.settle(false), on: id)
            if let at = row.pinned { try await model.act(.pin(true, at: at), on: id) }
            if let until = row.snoozedUntil, until > Date() { try await model.act(.snooze(until), on: id) }
        }
    }

    private func snooze(_ row: ChatRow, until: Date) {
        guard until > Date() else { return failed = "That time has passed." }
        act(.snooze(until), row, done: "Snoozed until \(SnoozeChoice.when(until))") { [model] id in
            try await model.act(.snooze(row.snoozedUntil.flatMap { $0 > Date() ? $0 : nil }), on: id)
        }
    }

    private func pin(_ row: ChatRow) {
        guard let at = row.pinned else { return act(.pin(true), row) }
        act(.pin(false), row, done: "Chat unpinned") { [model] id in try await model.act(.pin(true, at: at), on: id) }
    }

    /// `done` and `back`: what is said at the bottom once it went, and how Undo takes it back.
    private func act(_ action: ChatsModel.ChatAction, _ row: ChatRow, done text: String? = nil,
                     back: ((String) async throws -> Void)? = nil) {
        guard case .chat(let id) = row.route else { return }
        Task {
            do {
                try await model.act(action, on: id)
                if let text {
                    var undo: (() async throws -> Void)?
                    if let back { undo = { try await back(id) } }
                    done = Done(text: text, back: undo)
                }
            } catch {
                failed = error.localizedDescription
            }
        }
    }

    /// The sign-in has run out (a dropped connection is the banner under the bar).
    private var header: some View {
        Button("Sign in again") { signingIn = true }.font(.subheadline.weight(.semibold)).frame(minHeight: 44)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
    }
}

/// Edits and Review videos as cards, the ones in play first (a swipe dismisses, removes or deletes one), then the
/// Working and Done shelves. The rows of a `List`: a project's on its page, the ones of no project at the end of
/// Projects. The list they are in asks about a delete and a stopped New edit (`editDialogs`).
struct EditRows: View {
    let rows: [ChatRow]
    /// Words are being searched for: the shelves show open.
    var searching = false
    @Binding var deleting: ChatRow?
    /// A New edit that stopped: Try again or Remove.
    @Binding var stopped: ChatRow?
    @ObservedObject private var model = ChatsModel.shared
    @AppStorage("chats.working.open") private var workingOpen = true
    @AppStorage("chats.done.open") private var doneOpen = false
    @State private var doneShown = 10

    var body: some View {
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
        Button { tap(row) } label: { WorkCard(row: row) }
            .buttonStyle(.plain)
            .contextMenu {
                if row.review != nil, case .edit = row.route {
                    Button("Open project", systemImage: "chevron.right") { AppNavigator.shared.open(row.route) }
                }
            }
            .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
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
        // a cut that waits for review opens in Review at its newest version; Open project is the long press
        if row.status == .review, let asset = row.review {
            AppNavigator.shared.open(.review(asset, version: nil))
            return
        }
        AppNavigator.shared.open(row.route)
    }
}

extension View {
    /// The questions `EditRows` asks: delete an edit or a video, and what to do with a New edit that stopped.
    func editDialogs(deleting: Binding<ChatRow?>, stopped: Binding<ChatRow?>) -> some View {
        confirmationDialog("Delete “\(deleting.wrappedValue?.title ?? "")”?",
                           isPresented: Binding(get: { deleting.wrappedValue != nil }, set: { if !$0 { deleting.wrappedValue = nil } }),
                           titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                if let row = deleting.wrappedValue { Task { await ChatsModel.shared.delete(row) } }
            }
        } message: {
            Text("It stays in Review's trash for 30 days.")
        }
        .confirmationDialog(stopped.wrappedValue?.title ?? "",
                            isPresented: Binding(get: { stopped.wrappedValue != nil }, set: { if !$0 { stopped.wrappedValue = nil } }),
                            titleVisibility: .visible, presenting: stopped.wrappedValue) { row in
            Button("Try again") { if let id = row.phoneEdit { Task { await PhoneEdits.shared.retry(id) } } }
            Button("Remove", role: .destructive) { if let id = row.phoneEdit { PhoneEdits.shared.forget(id) } }
        } message: { row in
            Text(row.detail)
        }
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
                    ToolsetImage(path: picture, maxPixels: 240, api: API.current(in: row.workspace))
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
struct ShelfHeader: View {
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

/// The times a chat can be snoozed until, as on the desktop: in 1 and 3 hours, this evening at six, tomorrow at nine and
/// next Monday at nine; ones already past are left out, and two at the same minute are one.
struct SnoozeChoice {
    let label: String
    let until: Date
    var when: String { Self.when(until) }

    static func all(now: Date = Date(), calendar: Calendar = .current) -> [SnoozeChoice] {
        func day(_ ahead: Int, _ hour: Int) -> Date {
            let date = calendar.date(byAdding: .day, value: ahead, to: now) ?? now
            return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: date) ?? date
        }
        // weekday: 1 is Sunday; next Monday is 1 to 7 days on
        let monday = (9 - calendar.component(.weekday, from: now)) % 7
        let all = [SnoozeChoice(label: "In 1 hour", until: now.addingTimeInterval(3600)),
                   SnoozeChoice(label: "In 3 hours", until: now.addingTimeInterval(3 * 3600)),
                   SnoozeChoice(label: "This evening", until: day(0, 18)),
                   SnoozeChoice(label: "Tomorrow", until: day(1, 9)),
                   SnoozeChoice(label: "Next week", until: day(monday == 0 ? 7 : monday, 9))]
        var minutes = Set<Int>()
        return all.filter { $0.until > now }.sorted { $0.until < $1.until }
            .filter { minutes.insert(Int($0.until.timeIntervalSince1970 / 60)).inserted }
    }

    /// Its clock time, with the weekday when it is not today.
    static func when(_ date: Date, now: Date = Date()) -> String {
        Calendar.current.isDate(date, inSameDayAs: now)
            ? date.formatted(date: .omitted, time: .shortened)
            : date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
    }
}
