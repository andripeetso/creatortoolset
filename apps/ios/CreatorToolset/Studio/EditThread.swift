import AVKit
import SwiftUI

/// One edit as the server sends it (`GET /api/editor/:id`): what its thread shows.
struct EditorProject: Decodable, Hashable {
    let id: String
    let name: String
    let jobs: [Job]
    let drafts: [Draft]
    let usage: EditorUsage?
    /// His notes for new versions, each with the editor's answer once it has one.
    var feedback: [Note]?

    struct Job: Decodable, Identifiable, Hashable {
        let id: String
        let kind: String
        let variant: String?
        let draft: String?
        /// "queued", "running", "waiting" (for his go), "done" or "error".
        let status: String
        let progress: Double
        let message: String?
        let error: String?
        let createdAt: Double
        var startedAt: Double?
        var finishedAt: Double?
        /// A pass of "Edit in passes" that waits for his go.
        var hold: Bool?
        /// A look sheet that waits for his go.
        var sheet: Sheet?
        var note: String?
        var gen: String?
        var versions: Int?

        struct Sheet: Decodable, Hashable {
            var plan: String?
            var at: Double?
        }

        /// When it last moved.
        var at: Double { finishedAt ?? startedAt ?? createdAt }
    }

    /// A cut.
    struct Draft: Decodable, Identifiable, Hashable {
        let name: String
        let variant: String
        let n: Int
        let createdAt: Double
        let pass: Bool
        let durationS: Double
        /// The checks it failed.
        let failed: [String]?
        let preview: Bool?
        let review: ReviewRef?
        /// The kind of job that made it.
        var made: String?
        var id: String { name }

        struct ReviewRef: Decodable, Hashable {
            let asset: String
            let n: Int
        }
    }

    struct Note: Decodable, Identifiable, Hashable {
        var id: String
        var at: Double
        var text: String
        /// The job it started.
        var job: String?
        var reply: String?
    }
}

/// The AI Editor's chat (`GET /api/editor/chat?edit=<id>`): one conversation for all edits on the
/// Mac, of which a thread shows the messages about its own edit.
struct EditorChat: Decodable, Hashable {
    let messages: [Message]
    /// The message being answered now, when it is one of this thread's.
    let turn: Turn?
    /// The editor is answering a message of another edit: one sent now would be refused.
    var busy: Bool?

    struct Message: Decodable, Identifiable, Hashable {
        let id: String
        let role: String
        let text: String
        var at: Double?
        let steps: [String]?
        let usage: EditorUsage?
        let error: Bool?
        /// The edit it is about. An older server never says.
        var edit: String?
    }

    struct Turn: Decodable, Hashable {
        let claimed: Bool
        let steps: [String]
        var at: Double?
    }
}

/// An edit's thread, oldest at the top: what the editor did, its cuts, what was said.
enum EditFeed {
    enum Item: Identifiable, Hashable {
        /// A finished job, as one folded line.
        case done(EditorProject.Job)
        case failed(EditorProject.Job, canRetry: Bool)
        case cut(EditorProject.Draft)
        /// His note or message.
        case said(id: String, text: String)
        /// The editor's answer.
        case reply(id: String, text: String, steps: [String], failed: Bool)

        var id: String {
            switch self {
            case .done(let job), .failed(let job, _): "job-\(job.id)"
            case .cut(let draft): "cut-\(draft.name)"
            case .said(let id, _): "said-\(id)"
            case .reply(let id, _, _, _): "reply-\(id)"
            }
        }
    }

    /// Jobs that need more than their own fields to run again (a file he exported, an editor he picked).
    private static let noRetry: Set<String> = ["save_edit", "next_round", "handover", "import_resolve"]

    /// By time. A cut sits right under the job that made it (the server stamps the cut a moment
    /// before the job's end), and an answer to a note comes after the cut it led to.
    static func items(_ edit: EditorProject, chat: [EditorChat.Message]) -> [Item] {
        var placed: [(at: Double, rank: Int, item: Item)] = []
        for job in edit.jobs {
            if job.status == "done" {
                placed.append((job.at, 0, .done(job)))
            } else if job.status == "error" {
                // tried again since: the old failure keeps its words, not its button
                let again = edit.jobs.contains { $0.createdAt > job.createdAt && $0.kind == job.kind && $0.variant == job.variant && $0.draft == job.draft }
                placed.append((job.at, 0, .failed(job, canRetry: !again && !noRetry.contains(job.kind))))
            }
        }
        for draft in edit.drafts {
            let maker = edit.jobs.last { $0.status == "done" && $0.draft == draft.name && $0.kind == draft.made }
            placed.append((max(draft.createdAt, maker?.finishedAt ?? 0), 1, .cut(draft)))
        }
        for note in edit.feedback ?? [] {
            placed.append((note.at, 2, .said(id: note.id, text: note.text)))
            if let reply = note.reply, !reply.isEmpty {
                let job = edit.jobs.first { $0.id == note.job }
                placed.append((job?.finishedAt ?? note.at, 3, .reply(id: note.id, text: reply, steps: [], failed: false)))
            }
        }
        for message in chat {
            placed.append(message.role == "user"
                ? (message.at ?? 0, 2, .said(id: message.id, text: message.text))
                : (message.at ?? 0, 3, .reply(id: message.id, text: message.text, steps: message.steps ?? [], failed: message.error == true)))
        }
        return placed.enumerated()
            .sorted { a, b in (a.element.at, a.element.rank, a.offset) < (b.element.at, b.element.rank, b.offset) }
            .map(\.element.item)
    }

    /// "Sorted the footage · 3m": what a finished job did and how long it took.
    static func line(_ job: EditorProject.Job) -> String {
        guard let start = job.startedAt, let end = job.finishedAt, end - start >= 1000 else { return EditorWords.did(job.kind) }
        let seconds = Int((end - start) / 1000)
        let took = seconds < 60 ? "\(seconds)s" : seconds < 3600 ? "\(Int((Double(seconds) / 60).rounded()))m" : "\(seconds / 3600)h \(seconds / 60 % 60)m"
        return "\(EditorWords.did(job.kind)) · \(took)"
    }
}

@MainActor
final class EditThreadModel: ObservableObject {
    let id: String
    @Published private(set) var edit: EditorProject?
    @Published private(set) var chat: EditorChat?
    /// Why nothing could be shown.
    @Published private(set) var error: String?
    /// The server's words when it refused something he pressed.
    @Published var notice: String?
    @Published private(set) var sending = false
    /// Sent from this screen to a server that doesn't say which edit a message is about.
    private var mine: Set<String> = []
    private var loading = false

    init(id: String) { self.id = id }

    var running: EditorProject.Job? { edit?.jobs.first { $0.status == "running" } }
    var queued: [EditorProject.Job] { edit?.jobs.filter { $0.status == "queued" } ?? [] }
    var waiting: [EditorProject.Job] { edit?.jobs.filter { $0.status == "waiting" } ?? [] }

    /// The chat's messages about this edit.
    var messages: [EditorChat.Message] {
        guard let all = chat?.messages else { return [] }
        return all.enumerated().filter { index, message in
            message.edit == id || mine.contains(message.id)
                || (message.role == "assistant" && index > 0 && mine.contains(all[index - 1].id))
        }.map(\.element)
    }

    /// The answer being written to this thread's last message.
    var turn: EditorChat.Turn? {
        guard let chat, let last = chat.messages.last, last.edit == id || mine.contains(last.id) else { return nil }
        return chat.turn
    }

    /// The editor is answering something else: a message sent now would be refused.
    var busy: Bool { chat?.busy == true || (chat?.turn != nil && turn == nil) }

    /// Something moves by itself: the screen reads again every few seconds.
    var active: Bool { running != nil || !queued.isEmpty || turn != nil }

    var feed: [EditFeed.Item] { edit.map { EditFeed.items($0, chat: messages) } ?? [] }

    func load() async {
        guard !loading else { return }
        guard let api = ToolsetAPI.current else {
            error = "Not signed in"
            return
        }
        loading = true
        defer { loading = false }
        do {
            async let talk: EditorChat? = try? api.get("/api/editor/chat?edit=\(id)")
            let fresh: EditorProject = try await api.get("/api/editor/\(id)")
            if fresh != edit { edit = fresh }
            if let said = await talk, said != chat { chat = said }
            error = nil
        } catch {
            if edit == nil { self.error = error.localizedDescription }
        }
    }

    /// True when the message went.
    func send(_ text: String) async -> Bool {
        guard let api = ToolsetAPI.current else { return false }
        sending = true
        defer { sending = false }
        do {
            let answer = try JSONDecoder().decode(EditorChat.self, from: try await api.send("/api/editor/chat", json: ["text": text, "edit": id]))
            if let sent = answer.messages.last(where: { $0.role == "user" && $0.text == text }), sent.edit == nil { mine.insert(sent.id) }
            chat = answer
            notice = nil
            return true
        } catch {
            notice = error.localizedDescription   // 409: "Still answering your last message"
            return false
        }
    }

    /// "Looks good, carry on".
    func go(_ job: EditorProject.Job) async {
        await act { try await $0.send("/api/editor/\(self.id)/jobs/\(job.id)/go", json: [String: Any]()) }
    }

    func sendToReview(_ draft: EditorProject.Draft) async {
        await act { try await $0.send("/api/editor/\(self.id)/drafts/\(pathPiece(draft.name))/review") }
    }

    /// The same job once more.
    func retry(_ job: EditorProject.Job) async {
        await act { api in
            if job.kind == "revise", let draft = job.draft {
                try await api.send("/api/editor/\(self.id)/drafts/\(pathPiece(draft))/revise")
                return
            }
            var body: [String: Any] = ["kind": job.kind]
            body["variant"] = job.variant
            body["draft"] = job.draft
            body["gen"] = job.gen
            body["note"] = job.note
            body["versions"] = job.versions
            try await api.send("/api/editor/\(self.id)/jobs", json: body)
        }
    }

    func openInResolve() async {
        guard let draft = edit?.drafts.last else { return }
        await act { try await $0.send("/api/editor/\(self.id)/jobs", json: ["kind": "open_in_resolve", "draft": draft.name]) }
    }

    private func act(_ work: (ToolsetAPI) async throws -> Void) async {
        guard let api = ToolsetAPI.current else { return }
        do {
            try await work(api)
            notice = nil
        } catch {
            notice = error.localizedDescription
        }
        await load()
        await ChatsModel.shared.load()
    }
}

/// One AI Editor edit as a thread: what the editor did, its cuts, and what it waits for.
/// The box at the bottom talks to the editor about this edit.
struct EditThreadView: View {
    let id: String
    @StateObject private var model: EditThreadModel
    @State private var text = ""
    @State private var askResolve = false

    init(id: String) {
        self.id = id
        _model = StateObject(wrappedValue: EditThreadModel(id: id))
    }

    private var name: String {
        model.edit?.name ?? ChatsModel.shared.rows.first { $0.id == ChatList.path(.edit(id)) }?.title ?? ""
    }

    var body: some View {
        content
            .safeAreaInset(edge: .bottom) { bottom }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(name).font(.subheadline.weight(.semibold)).lineLimit(1)
                        Text("AI Editor").font(.caption2).foregroundStyle(.secondary)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    if model.edit?.drafts.isEmpty == false {
                        Menu {
                            Button("Open in Resolve on the Mac", systemImage: "film.stack") { askResolve = true }
                        } label: {
                            Image(systemName: "ellipsis")
                        }
                    }
                }
            }
            .confirmationDialog("Open \(model.edit?.drafts.last?.name ?? "the cut") in Resolve on the Mac?", isPresented: $askResolve, titleVisibility: .visible) {
                Button("Open in Resolve") { Task { await model.openInResolve() } }
            }
            .task {
                ChatsModel.shared.watch()
                await model.load()
            }
            // a job or an answer on its way: every 3 s; otherwise when the server says something changed
            .task(id: model.active) {
                while model.active, !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(3))
                    await model.load()
                }
            }
            .onReceive(ChatsModel.shared.changed) { _ in Task { await model.load() } }
    }

    @ViewBuilder private var content: some View {
        if model.edit != nil {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    ForEach(model.feed) { item in row(item) }
                    ForEach(model.waiting) { job in
                        GoCard(editId: id, job: job) { await model.go(job) }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
            .defaultScrollAnchor(.bottom)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await model.load() }
        } else if let error = model.error {
            VStack(spacing: 14) {
                Text(error).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                WideButton(title: "Try again", kind: .plain) { Task { await model.load() } }
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder private func row(_ item: EditFeed.Item) -> some View {
        switch item {
        case .done(let job):
            StepsFold(title: EditFeed.line(job), steps: [job.message].compactMap { $0 })
        case .failed(let job, let canRetry):
            VStack(alignment: .leading, spacing: 4) {
                Text("\(EditorWords.doing(job.kind)) failed").font(.subheadline.weight(.semibold))
                Text(job.error ?? "").font(.subheadline)
                if canRetry {
                    Button("Try again") { Task { await model.retry(job) } }
                        .buttonStyle(.bordered)
                        .tint(.red)
                        .frame(minHeight: 44)
                }
            }
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .cut(let draft):
            CutCard(editId: id, draft: draft) { await model.sendToReview(draft) }
        case .said(_, let text):
            UserBubble(text: text)
        case .reply(_, let text, let steps, let failed):
            VStack(alignment: .leading, spacing: 6) {
                if !steps.isEmpty { StepsFold(title: "\(steps.count) step\(steps.count == 1 ? "" : "s")", steps: steps) }
                MarkdownText(text: text).foregroundStyle(failed ? Color.red : Color.primary)
            }
        }
    }

    /// Over the message box: what the server refused, the Mac that is away, and what is at work.
    private var bottom: some View {
        VStack(spacing: 6) {
            Group {
                if let notice = model.notice {
                    Text(notice).font(.footnote).foregroundStyle(.red).frame(maxWidth: .infinity, alignment: .leading)
                } else if model.busy {
                    Text("Answering another edit").font(.footnote).foregroundStyle(.secondary).frame(maxWidth: .infinity, alignment: .leading)
                } else if model.active, let offline = EditorChats.offline {
                    QuietNotice(text: offline).fixedSize()
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 4)
            if let job = model.running {
                if let message = job.message, !message.isEmpty {
                    Text(message).font(.caption).foregroundStyle(.secondary).lineLimit(1).padding(.horizontal, 20)
                }
                WorkingCapsule(label: EditorWords.doing(job.kind), since: job.startedAt.map { date(ms: $0) })
            } else if let job = model.queued.first, model.waiting.isEmpty {
                WorkingCapsule(label: "Queued: \(EditorWords.short(job.kind))", since: nil)
            }
            if let turn = model.turn {
                if let step = turn.steps.last {
                    Text(step).font(.caption).foregroundStyle(.secondary).lineLimit(1).padding(.horizontal, 20)
                }
                WorkingCapsule(label: turn.claimed ? "Answering" : "Waiting for the Mac", since: turn.at.map { date(ms: $0) })
            }
            ChatComposer(text: $text, placeholder: "Say what to change", working: model.turn != nil,
                         sending: model.sending || model.busy, onSend: send)
        }
    }

    private func send() {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        Task {
            if await model.send(message) { text = "" }
        }
    }
}

/// A cut in the thread: its preview plays in place; under it its name, and at the right
/// the way into Review.
private struct CutCard: View {
    let editId: String
    let draft: EditorProject.Draft
    let sendToReview: () async -> Void
    @State private var player: AVPlayer?
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if draft.preview == true {
                ZStack {
                    Color(.secondarySystemBackground)
                    if let player { NativePlayer(player: player) }
                }
                .frame(width: 180, height: 320)
                .clipShape(RoundedRectangle(cornerRadius: 14))
                .onAppear {
                    if player == nil, let api = ToolsetAPI.current {
                        player = api.player("/api/editor/\(editId)/drafts/\(pathPiece(draft.name))/preview")
                    }
                }
                .onDisappear { player?.pause() }
            }
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(draft.name).font(.subheadline.weight(.semibold))
                    Text(clock(draft.durationS)).font(.footnote.monospacedDigit()).foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                if let review = draft.review {
                    Button {
                        AppNavigator.shared.open(.review(review.asset, version: review.n))
                    } label: {
                        HStack(spacing: 3) {
                            Text("In Review")
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color("AccentColor"))
                } else if draft.preview == true {
                    Button {
                        Task {
                            busy = true
                            await sendToReview()
                            busy = false
                        }
                    } label: {
                        Text("Send to Review").font(.subheadline.weight(.semibold)).frame(minHeight: 30)
                    }
                    .buttonStyle(.bordered)
                    .disabled(busy)
                }
            }
            // as wide as the video, wider only for a long name
            .frame(minWidth: 180)
            .fixedSize(horizontal: true, vertical: false)
            if let failed = draft.failed, !failed.isEmpty {
                Text("Checks failed: \(failed.map { $0.replacingOccurrences(of: "_", with: " ") }.joined(separator: ", "))")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
    }
}

/// What waits for his go, at the end of the thread: the next pass, or the look sheet with its picture.
private struct GoCard: View {
    let editId: String
    let job: EditorProject.Job
    let go: () async -> Void
    @State private var busy = false

    var body: some View {
        AskCard(eyebrow: "Waiting for you", title: job.sheet != nil ? "Look sheet" : "Next: \(EditorWords.pass(job.kind))") {
            if let sheet = job.sheet {
                // the picture's address carries the sheet's time: a sheet made again is another picture
                SheetPicture(path: "/api/editor/\(editId)/jobs/\(job.id)/sheet.jpg?c=\(Int(sheet.at ?? 0))")
                if let plan = sheet.plan, !plan.isEmpty { MarkdownText(text: plan).font(.subheadline) }
            }
            WideButton(title: "Looks good, carry on", busy: busy) {
                Task {
                    busy = true
                    await go()
                    busy = false
                }
            }
        }
    }
}

/// The look sheet's picture across the card, in its own shape.
private struct SheetPicture: View {
    let path: String
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Color(.tertiarySystemFill).aspectRatio(4 / 5, contentMode: .fit)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .task(id: path) { image = await ToolsetImages.shared.image(path, maxPixels: 1400) }
    }
}
