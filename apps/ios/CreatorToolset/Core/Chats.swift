import Combine
import SwiftUI
import UIKit

/// One row of Chats: a conversation or a piece of work that talks back.
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

    private enum Keys: String, CodingKey { case id, name, approval, versions, newComments, updatedAt, createdAt }
    private struct Approval: Decodable { var status: String? }
    private struct Version: Decodable {
        var source: Source?
        struct Source: Decodable { var href: String? }
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        id = try c.decode(String.self, forKey: .id)
        name = (try? c.decode(String.self, forKey: .name)) ?? ""
        status = (try? c.decode(Approval.self, forKey: .approval))?.status ?? "none"
        let all = (try? c.decode([Version].self, forKey: .versions)) ?? []
        versions = all.count
        source = all.last?.source?.href
        newComments = (try? c.decode(Int.self, forKey: .newComments)) ?? 0
        at = (try? c.decode(Double.self, forKey: .updatedAt)) ?? (try? c.decode(Double.self, forKey: .createdAt)) ?? 0
    }
}

/// The chips under the search field.
enum ChatFilter: String, CaseIterable, Identifiable {
    case all, edits, review, assistant

    var id: String { rawValue }
    var title: String {
        switch self {
        case .all: "All"
        case .edits: "Edits"
        case .review: "Review"
        case .assistant: "Assistant"
        }
    }

    func has(_ row: ChatRow) -> Bool {
        switch (self, row.route) {
        case (.all, _), (.edits, .edit), (.review, .review), (.assistant, .assistant): true
        default: false
        }
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

/// What Chats shows, worked out from what the server said: which rows, in which order.
enum ChatList {
    /// The page of the website a route stands for, and so its row's id.
    static func path(_ route: AppRoute) -> String {
        switch route {
        case .assistant: "/assistant"
        case .edit(let id): "/editor/\(id)"
        case .review(let id, _): "/review/\(id)"
        case .session(let id): "/workshop/sessions/\(id)"
        case .finals: "/library"
        case .page(let path): path
        }
    }

    /// The assistant's row: its last words, and whether it asks for something or is writing.
    static func assistant(_ view: AssistantView?) -> ChatRow {
        let messages = view?.messages ?? []
        let last = messages.last { !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let line = last?.text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        let status: RowStatus
        // it asks to be allowed something, or asks a yes-or-no before it deletes, publishes or sends
        if messages.contains(where: { $0.approvals?.contains { $0.status == "waiting" } == true
            || $0.confirms?.contains { $0.status == "waiting" } == true }) {
            status = .approval
        } else if let thinking = view?.thinking {
            status = .working(since: date(ms: thinking.at))
        } else if let newest = messages.last {
            status = .time(date(ms: newest.at))
        } else {
            status = .none
        }
        return ChatRow(id: path(.assistant), route: .assistant, title: "Assistant",
                       detail: Markdown.plain(line), status: status,
                       at: messages.last.map { date(ms: $0.at) } ?? .distantPast)
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
                       keys: waits ? ["\(video.id):v\(video.versions)"] : [])
    }

    /// The rows that are not the assistant's. A Review video made by something that has its own
    /// row (an edit's cut) is that row's business and gets none.
    static func merge(videos: [ReviewListItem], others: [ChatRow]) -> [ChatRow] {
        let have = Set(others.map(\.id))
        let loose = videos.filter { video in
            guard let made = video.source.flatMap(AppRoute.from(path:)) else { return true }
            return !have.contains(path(made))
        }
        return others + loose.map(row)
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

    /// Top to bottom: the assistant, the rows that wait on the person (newest first), the rest by
    /// newest activity, then the Working shelf and the Done shelf.
    /// A finished row says Done until it is opened (`opened`: when each row was last opened;
    /// `since`: when this phone first showed Chats, so old work is not news).
    static func arrange(assistant: ChatRow, rows: [ChatRow], opened: [String: Date] = [:], since: Date = .distantPast) -> [ChatRow] {
        let marked = rows.map { row -> ChatRow in
            guard row.shelf == .active, case .time = row.status, let finished = row.finished,
                  finished > (opened[row.id] ?? since) else { return row }
            var done = row
            done.status = .done
            return done
        }
        func newest(_ a: ChatRow, _ b: ChatRow) -> Bool { a.at != b.at ? a.at > b.at : a.id < b.id }
        let active = marked.filter { $0.shelf == .active }
        return [assistant]
            + active.filter(\.status.waitsOnYou).sorted(by: newest)
            + active.filter { !$0.status.waitsOnYou }.sorted(by: newest)
            + marked.filter { $0.shelf == .working }.sorted(by: newest)
            + marked.filter { $0.shelf == .done }.sorted(by: newest)
    }
}

/// The rows of Chats and how many of them wait on the person (the tab's badge).
@MainActor
final class ChatsModel: ObservableObject {
    static let shared = ChatsModel()

    /// In the order of the screen (`ChatList.arrange`), the assistant's row first.
    @Published private(set) var rows: [ChatRow] = []
    @Published private(set) var link = Link.ok
    @Published private(set) var offline = false
    /// Something a part of the app says is off, shown above the list ("MacBook is offline").
    @Published var notice: String?
    /// How many things of the last read this version of the app could not read (the server is
    /// newer than the app, or sends something unexpected). Counted while a read runs, shown after it.
    var unreadable = 0
    @Published private(set) var couldNotRead = 0

    var waiting: Int { rows.filter(\.status.waitsOnYou).count }

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
    private var soon: Task<Void, Never>?
    /// The screens open on Chats, as last seen: one that is left was looked at until then.
    private var open: [AppRoute] = []
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
        // a screen pushed on Chats is its row opened, and so is one he comes back from:
        // what finished while he watched is not news
        AppNavigator.shared.$chats.sink { [weak self] routes in
            MainActor.assumeIsolated {
                guard let self else { return }
                let seen = self.open.filter { !routes.contains($0) } + [routes.last].compactMap { $0 }
                self.open = routes
                for route in seen { self.markOpened(ChatList.path(route)) }
            }
        }.store(in: &bag)
    }

    /// Follows the server for as long as the app runs: once now, on every change it tells of,
    /// and when the app comes back to the front.
    func watch() {
        guard watching == nil else { return }
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
            assistant: ChatList.assistant(assistant),
            rows: ChatList.settle(ChatList.merge(videos: videos, others: others), dismissed: dismissed),
            opened: opened.mapValues(Date.init(timeIntervalSince1970:)), since: since)
        if fresh != rows { rows = fresh }
    }

    // MARK: Dismiss and delete

    /// Which rows a swipe can dismiss: everything in play but the assistant.
    nonisolated static func canDismiss(_ row: ChatRow) -> Bool { row.route != .assistant && row.shelf == .active }

    /// Only a Review video can be deleted from here: it goes to Review's trash and can be brought back.
    nonisolated static func canDelete(_ row: ChatRow) -> Bool {
        if case .review = row.route { return true }
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

    init(_ row: ChatRow) {
        id = row.id
        title = row.title
        detail = row.detail
        error = row.detailIsError
        at = row.at.timeIntervalSince1970
        shelf = row.shelf.rawValue
        keys = row.keys
        finished = row.finished?.timeIntervalSince1970
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
                       finished: finished.map(Date.init(timeIntervalSince1970:)))
    }
}

/// The first screen: every chat and every piece of work, the ones that wait on top.
struct ChatsView: View {
    @ObservedObject private var model = ChatsModel.shared
    @State private var query = ""
    @State private var filter = debugArg("ChatsFilter").flatMap(ChatFilter.init(rawValue:)) ?? .all
    @AppStorage("chats.working.open") private var workingOpen = true
    @AppStorage("chats.done.open") private var doneOpen = false
    @State private var doneShown = 10
    @State private var signingIn = false
    @State private var deleting: ChatRow?
    @State private var askDismissAll = false

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
        .navigationTitle("Creator Toolset")
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

    private var shown: [ChatRow] {
        let words = query.trimmingCharacters(in: .whitespaces).lowercased()
        let picked = filters.contains(filter) ? filter : .all
        return model.rows.filter { row in
            picked.has(row) && (words.isEmpty || row.title.lowercased().contains(words) || row.detail.lowercased().contains(words))
        }
    }

    /// A chip that would show nothing is left out.
    private var filters: [ChatFilter] {
        ChatFilter.allCases.filter { chip in chip == .all || model.rows.contains(where: chip.has) }
    }

    private var list: some View {
        let rows = shown
        let working = rows.filter { $0.shelf == .working }
        let done = rows.filter { $0.shelf == .done }
        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        return List {
            if model.link == .expired || model.offline || model.notice != nil || model.couldNotRead > 0 || filters.count > 2 { header }
            ForEach(rows.filter { $0.shelf == .active }) { row in
                opens(row) {
                    ChatListRow(title: row.title, detail: row.detail, detailIsError: row.detailIsError, status: row.status) {
                        RowTile(route: row.route)
                    }
                }
                .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                .swipeActions(edge: .trailing, allowsFullSwipe: true) {
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
                    ForEach(working) { row in
                        opens(row) { SlimRow(row: row) }.slimListRow()
                    }
                }
            }
            if !done.isEmpty {
                ShelfHeader(title: "Done", count: done.count, open: $doneOpen)
                if doneOpen || searching {
                    ForEach(done.prefix(doneShown)) { row in
                        opens(row) { SlimRow(row: row) }.slimListRow()
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
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 36)
        .searchable(text: $query, prompt: "Search")
        .refreshable { await model.load() }
        .toolbar {
            // everything that waits for his review, in one go
            let reviews = rows.filter { $0.shelf == .active && $0.status == .review }
            if reviews.count > 1 {
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
        // the round New-message button and the tab bar sit over the end of the list
        .contentMargins(.bottom, 84, for: .scrollContent)
    }

    /// What is off, when something is, and the chips.
    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            if model.link == .expired {
                Button("Sign in again") { signingIn = true }.font(.subheadline.weight(.semibold)).frame(minHeight: 44)
            } else if model.offline {
                QuietNotice(text: "No connection")
            } else if let notice = model.notice {
                QuietNotice(text: notice)
            }
            if model.couldNotRead > 0 {
                QuietNotice(text: "Some things could not be read. Update the app.")
            }
            if filters.count > 2 {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(filters) { chip in
                            let on = chip == (filters.contains(filter) ? filter : .all)
                            Button { filter = chip } label: {
                                Text(chip.title)
                                    .font(.subheadline.weight(on ? .semibold : .regular))
                                    .foregroundStyle(on ? Color(.systemBackground) : Color.primary)
                                    .padding(.horizontal, 14)
                                    .frame(height: 32)
                                    .background(on ? Color.primary : Color(.secondarySystemBackground), in: Capsule())
                                    .frame(minHeight: 44)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
    }

    /// A row that opens its screen the way a card or a notification does. No arrow at the right: the badge sits there.
    private func opens<Label: View>(_ row: ChatRow, @ViewBuilder label: () -> Label) -> some View {
        Button { AppNavigator.shared.open(row.route) } label: { label() }.buttonStyle(.plain)
    }
}

/// The small square in front of a row: the assistant's in the app's colour, the others quiet.
private struct RowTile: View {
    let route: AppRoute

    var body: some View {
        let assistant = route == .assistant
        Image(systemName: symbol)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(assistant ? Color.white : Color.secondary)
            .frame(width: 34, height: 34)
            .background(assistant ? Color("AccentColor") : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 9))
    }

    private var symbol: String {
        switch route {
        case .assistant: "sparkles"
        case .edit: "film"
        case .review: "play.rectangle"
        default: "doc.text"
        }
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

/// A row of a shelf: one line. Working: a dashed ring, the name, the job and how long it has run.
/// Done: the name and how long ago.
private struct SlimRow: View {
    let row: ChatRow

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: row.shelf == .working ? "circle.dashed" : "checkmark.circle")
                .font(.footnote.weight(.semibold))
                .foregroundStyle(row.shelf == .working ? Color.cyan : Color.secondary)
            Text(row.title).font(.subheadline).lineLimit(1)
            Spacer(minLength: 8)
            Group {
                if case .working(let since) = row.status {
                    TimelineView(.periodic(from: .now, by: 1)) { context in
                        Text([row.detail, since.map { runningFor(context.date.timeIntervalSince($0)) } ?? "queued"]
                            .filter { !$0.isEmpty }.joined(separator: " · "))
                    }
                } else {
                    Text(shortAgo(row.at))
                }
            }
            .font(.footnote.monospacedDigit())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .layoutPriority(1)
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

private extension View {
    /// A row of a shelf: close to its neighbours, no line between them.
    func slimListRow() -> some View {
        listRowSeparator(.hidden).listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
    }
}
