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
        /// "language": analyze heard no word in the clips and asks which language they are in (`message` asks it);
        /// `choices` are the person's Voice languages, as two-letter codes.
        var ask: String?
        var choices: [String]?
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
                placed.append((job.at, 0, .failed(job, canRetry: !fixed(job, in: edit) && !noRetry.contains(job.kind))))
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

    /// The project page, newest first: a still-live error on top, the newest cut, what was said since it, the older cuts
    /// with the note each got, and History (finished steps, errors a later run fixed, what was said before).
    struct Page: Equatable {
        var live: [Item] = []
        var newest: EditorProject.Draft?
        var earlier: [(draft: EditorProject.Draft, note: String?)] = []
        var talk: [Item] = []
        var history: [Item] = []

        static func == (a: Page, b: Page) -> Bool {
            a.live == b.live && a.newest == b.newest && a.talk == b.talk && a.history == b.history
                && a.earlier.map(\.draft) == b.earlier.map(\.draft) && a.earlier.map(\.note) == b.earlier.map(\.note)
        }
    }

    static func page(_ edit: EditorProject, chat: [EditorChat.Message]) -> Page {
        let all = items(edit, chat: chat)
        var page = Page()
        let cuts = all.enumerated().compactMap { index, item -> (Int, EditorProject.Draft)? in
            if case .cut(let draft) = item { return (index, draft) }
            return nil
        }
        let newestAt = cuts.last?.0 ?? -1
        page.newest = cuts.last?.1
        // each older cut, newest first, with the first note said after it and before the next cut of its own variant
        // (a cut of another variant is another version, not the answer to its note)
        for (k, (index, draft)) in cuts.dropLast().enumerated().reversed() {
            let next = cuts[(k + 1)...].first { $0.1.variant == draft.variant }?.0
            let note = next.flatMap { next in
                all[(index + 1)..<next].compactMap { item -> String? in
                    if case .said(_, let text) = item { return text }
                    return nil
                }.first
            }
            page.earlier.append((draft, note))
        }
        for (index, item) in all.enumerated() {
            switch item {
            case .cut: continue
            case .failed(let job, _) where !fixed(job, in: edit): page.live.append(item)
            case .said, .reply: if index > newestAt { page.talk.append(item) } else { page.history.append(item) }
            default: page.history.append(item)
            }
        }
        page.history.reverse()
        return page
    }

    /// A failure the same step of the same version ran again after (put right, or failed anew and that one is on top):
    /// it goes to History. Not matched by draft name: every run is a new draft number (V5B failed, V6B is its retry).
    static func fixed(_ job: EditorProject.Job, in edit: EditorProject) -> Bool {
        edit.jobs.contains { $0.createdAt > job.createdAt && $0.kind == job.kind && $0.variant == job.variant }
    }

    /// The checks a cut failed, in plain words, once: "2 checks need a look: your voice is out of sync, you look away."
    static func checks(_ failed: [String]?) -> String? {
        let words = (failed ?? []).map { checkWords[$0] ?? $0.replacingOccurrences(of: "_", with: " ") }
        guard let first = words.first else { return nil }
        return words.count == 1 ? "1 check needs a look: \(first)." : "\(words.count) checks need a look: \(words.joined(separator: ", "))."
    }

    /// The editor's check ids in words (the worker's QA names them); an id not here is said as it is.
    static let checkWords: [String: String] = [
        "vo_linked": "your voice is out of sync", "look_away": "you look away", "cut_frames": "a cut is off by a frame",
        "on_screen": "something sits off the screen", "edges": "a shot shows its edges", "layers_visible": "a layer shows through",
        "restarts": "a sentence starts twice", "framing": "the framing is off", "short_visible_shots": "a shot is too short",
        "face_gaps": "your face leaves the frame", "broll_sources": "a B-roll clip is missing", "length": "the length is off",
        "frozen": "the picture freezes", "tail": "the end runs on", "dead_air": "there is a silence", "lanes": "clips overlap",
        "framing_axis": "the framing jumps", "loudness": "the sound is too loud or too quiet", "resolution": "the picture is low resolution",
        "flash_frames": "a flash frame", "still_cards": "a card stands still", "words": "the words on screen are off",
        "black_end": "it ends on black", "odd_frames": "an odd frame",
    ]

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
    /// The Review video of the newest cut: its approval and what approving starts.
    @Published private(set) var review: ReviewAsset?
    /// Sent from this screen to a server that doesn't say which edit a message is about.
    private var mine: Set<String> = []
    private var loading = false
    /// Another read was asked for while one ran: it reads once more.
    private var again = false
    /// Counts send()'s answers: a chat read that began before one is older than it.
    private var sends = 0

    /// The server and workspace this edit was opened in (its row's workspace, else the phone's): every request,
    /// player and picture of this screen asks there.
    let api: API?

    init(id: String, api: API? = nil) {
        self.id = id
        self.api = api ?? API.current(in: ChatsModel.shared.rows.first { $0.id == ChatList.path(.edit(id)) }?.workspace)
    }

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

    var page: EditFeed.Page { edit.map { EditFeed.page($0, chat: messages) } ?? EditFeed.Page() }

    func load() async {
        guard !loading else {
            again = true
            return
        }
        guard let api else {
            error = "Not signed in"
            return
        }
        #if DEBUG
        if PhoneDemo.on {
            edit = PhoneDemo.project
            review = PhoneDemo.review?.asset
            return
        }
        #endif
        loading = true
        defer { loading = false }
        repeat {
            again = false
            let before = sends
            do {
                async let talk: EditorChat? = try? api.get("/api/editor/chat?edit=\(id)")
                let fresh: EditorProject = try await api.get("/api/editor/\(id)")
                if fresh != edit { edit = fresh }
                if let ref = fresh.drafts.last?.review, let detail: ReviewDetail = try? await api.get("/api/review/assets/\(ref.asset)") {
                    if detail.asset != review { review = detail.asset }
                }
                if let said = await talk, before == sends, said != chat { chat = said }
                error = nil
            } catch {
                if edit == nil { self.error = error.localizedDescription }
            }
        } while again
    }

    /// True when the message went.
    func send(_ text: String) async -> Bool {
        guard let api else { return false }
        sending = true
        defer { sending = false }
        do {
            let answer = try JSONDecoder().decode(EditorChat.self, from: try await api.send("/api/editor/chat", json: ["text": text, "edit": id]))
            if let sent = answer.messages.last(where: { $0.role == "user" && $0.text == text }), sent.edit == nil { mine.insert(sent.id) }
            chat = answer
            sends += 1
            notice = nil
            return true
        } catch {
            notice = error.localizedDescription   // 409: "Still answering your last message"
            return false
        }
    }

    /// "Looks good, carry on".
    /// His go on a waiting job; `language` answers analyze's question (the clips are listened to again in it).
    func go(_ job: EditorProject.Job, language: String? = nil) async {
        await act { try await $0.send("/api/editor/\(self.id)/jobs/\(job.id)/go", json: language.map { ["language": $0] as [String: Any] } ?? [:]) }
    }

    /// Approve on the newest cut's Review video (that version only). Nil when it went, else the server's question
    /// before its owner approves a cut whose faces aren't blurred.
    @discardableResult
    func approve(_ ref: EditorProject.Draft.ReviewRef, asFilmed: Bool = false) async -> String? {
        guard let api else { return nil }
        var asked: String?
        await act { api in
            if case .ask(let line) = try await ReviewApproval.send(api, asset: ref.asset, .approved, asFilmed: asFilmed, version: ref.n) {
                asked = line
            }
        }
        return asked
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
        guard let api else { return }
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
    /// The server's question before approving a cut with unblurred faces, and the cut it asked about.
    @State private var asFilmedAsk: (line: String, ref: EditorProject.Draft.ReviewRef)?
    @State private var earlierOpen = false
    @State private var historyOpen = false
    /// Request changes: the box takes the keyboard.
    @State private var focus = 0
    @StateObject private var voice = VoiceInput()

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
            .alert(asFilmedAsk?.line ?? "", isPresented: Binding(get: { asFilmedAsk != nil }, set: { if !$0 { asFilmedAsk = nil } })) {
                Button("Approve as filmed") {
                    if let ref = asFilmedAsk?.ref { Task { await model.approve(ref, asFilmed: true) } }
                }
                Button("Cancel", role: .cancel) {}
            }
            .onDisappear { voice.cancel() }
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
                let page = model.page
                LazyVStack(alignment: .leading, spacing: 14) {
                    // only an error that is still a problem, with its one action; fixed ones are in History
                    ForEach(page.live) { item in row(item) }
                    // a question only he can answer; a pass waits for Approve on its cut, not for a go here
                    ForEach(model.waiting) { job in
                        if job.ask == "language" {
                            LanguageCard(job: job) { await model.go(job, language: $0) }
                        } else if job.sheet != nil {
                            GoCard(editId: id, job: job, api: model.api) { await model.go(job) }
                        }
                    }
                    if let newest = page.newest { newestCut(newest) }
                    ForEach(page.talk) { item in row(item) }
                    if !page.earlier.isEmpty {
                        ShelfHeader(title: "Earlier drafts", count: page.earlier.count, open: $earlierOpen)
                        if earlierOpen {
                            ForEach(page.earlier, id: \.draft.name) { earlier in earlierCut(earlier.draft, note: earlier.note) }
                        }
                    }
                    if !page.history.isEmpty {
                        ShelfHeader(title: "History", count: page.history.count, open: $historyOpen)
                        if historyOpen { ForEach(page.history) { item in row(item) } }
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
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
                    Button("Retry") { Task { await model.retry(job) } }
                        .buttonStyle(.bordered)
                        .tint(.red)
                        .frame(minHeight: 44)
                }
            }
            .foregroundStyle(.red)
            .frame(maxWidth: .infinity, alignment: .leading)
        case .cut(let draft):
            CutCard(editId: id, draft: draft, api: model.api) { await model.sendToReview(draft) }
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
            if let notice = voice.notice { QuietNotice(text: notice).padding(.horizontal, 20) }
            ChatComposer(text: $text, placeholder: model.edit?.drafts.last.map { "Notes for \(name($0))" } ?? "Say what to change",
                         working: model.turn != nil, sending: model.sending || model.busy, autofocus: focus > 0,
                         mic: ComposerMic(phase: voice.phase) {
                             // the cut waits, and the note says the moment it was spoken at
                             let at = CutCard.playing.flatMap { player -> Double? in
                                 player.pause()
                                 let t = player.currentTime().seconds
                                 return t.isFinite && t > 0 ? t : nil
                             }
                             voice.toggle { words in text = VoiceInput.appended(at.map { "At \(clock($0)): \(words)" } ?? words, to: text) }
                         },
                         onSend: send) { EmptyView() }
                .id(focus)
        }
    }

    /// The version number he sees: the cut's version in Review, else its own.
    static func number(_ draft: EditorProject.Draft) -> Int { draft.review?.n ?? draft.n }

    /// "Draft 2", with "· Version B" when the edit's rounds have several versions (the variant's last letter).
    private func name(_ draft: EditorProject.Draft) -> String {
        let several = Set(model.edit?.drafts.map(\.variant) ?? []).count > 1
        return ReviewAsset.draftName(Self.number(draft), version: several ? draft.variant.last.map(String.init) : nil)
    }

    /// The newest cut on top: its state in words, the two buttons (Approve left, Request changes right), and its checks
    /// once, in plain words.
    private func newestCut(_ draft: EditorProject.Draft) -> some View {
        // the Review video's approval is about its newest version: this cut's only while it is that one
        let status = model.review.flatMap { $0.latest?.n == draft.review?.n ? ReviewStatus(rawValue: $0.approval.status) : nil }
        let state = model.running.map { "Being cut · \(EditorWords.doing($0.kind))" }
            ?? (!model.queued.isEmpty ? "Being cut"
            : draft.review == nil ? "Not in Review yet"
            : status == .approved ? "Approved" : status == .changes ? "Changes asked" : "Waiting for your review")
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text("\(name(draft)) · \(clock(draft.durationS))").font(.subheadline.weight(.semibold))
                Text(state).font(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                Spacer(minLength: 8)
                if let ref = draft.review {
                    Button {
                        AppNavigator.shared.open(.review(ref.asset, version: ref.n))
                    } label: {
                        HStack(spacing: 3) {
                            Text("Review")
                            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                        }
                        .font(.subheadline.weight(.semibold))
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(Color("AccentColor"))
                }
            }
            CutCard(editId: id, draft: draft, api: model.api) { await model.sendToReview(draft) }
            if let ref = draft.review, status != .approved, model.running == nil, model.queued.isEmpty {
                HStack(spacing: 10) {
                    WideButton(title: ReviewAsset.approveTitle(model.review?.latest?.next), systemImage: "checkmark") {
                        Task { asFilmedAsk = await model.approve(ref).map { ($0, ref) } }
                    }
                    WideButton(title: "Request changes", kind: .plain) { focus += 1 }
                }
            }
            if let checks = EditFeed.checks(draft.failed) {
                Text(checks).font(.footnote).foregroundStyle(.orange)
            }
        }
    }

    /// An older cut, folded under Earlier drafts: its number, length and the note it got; a tap opens it in Review.
    private func earlierCut(_ draft: EditorProject.Draft, note: String?) -> some View {
        Button {
            if let ref = draft.review { AppNavigator.shared.open(.review(ref.asset, version: ref.n)) }
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(name(draft)) · \(clock(draft.durationS))").font(.subheadline.weight(.semibold))
                if let note { Text("Changes asked · “\(note)”").font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(draft.review == nil)
    }

    private func send() {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !message.isEmpty else { return }
        Task {
            if await model.send(message) { text = "" }
        }
    }
}

/// The newest cut's preview, playing in place (its name, state and Review › are the line above it); Send to Review
/// under it while it is not there.
private struct CutCard: View {
    let editId: String
    let draft: EditorProject.Draft
    let api: API?
    let sendToReview: () async -> Void
    @State private var player: AVPlayer?
    @State private var busy = false
    /// The cut on the page: the note box's mic pauses it.
    /// shortcut: one cut plays on the page (the newest); a list of players needs one per card
    static weak var playing: AVPlayer?

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
                    if player == nil, let api {
                        player = api.player("/api/editor/\(editId)/drafts/\(pathPiece(draft.name))/preview")
                    }
                    Self.playing = player
                }
                .onDisappear { player?.pause() }
            }
            if draft.review == nil, draft.preview == true {
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
    }
}

/// What waits for his go, at the end of the thread: the next pass, or the look sheet with its picture.
private struct GoCard: View {
    let editId: String
    let job: EditorProject.Job
    let api: API?
    let go: () async -> Void
    @State private var busy = false

    var body: some View {
        AskCard(eyebrow: "Waiting for you", title: job.sheet != nil ? "Look sheet" : "Next: \(EditorWords.pass(job.kind))") {
            if let sheet = job.sheet {
                // the picture's address carries the sheet's time: a sheet made again is another picture
                SheetPicture(path: "/api/editor/\(editId)/jobs/\(job.id)/sheet.jpg?c=\(Int(sheet.at ?? 0))", api: api)
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

/// Analyze heard no word in the clips: which language he speaks in them. His Voice languages first, any other in a menu.
private struct LanguageCard: View {
    let job: EditorProject.Job
    let answer: (String) async -> Void
    @State private var busy = false
    /// The languages a project or an edit offers (contracts/voice.ts SPOKEN_LANGUAGES).
    static let spoken = ["en", "et", "fi", "sv", "no", "da", "de", "nl", "fr", "es", "pt", "it", "pl", "cs", "lv", "lt", "ru",
                         "uk", "tr", "el", "hu", "ro", "bg", "hi", "ja", "ko", "zh", "id", "vi", "th"]
    static func name(_ code: String) -> String { Locale(identifier: "en").localizedString(forLanguageCode: code) ?? code }

    var body: some View {
        AskCard(eyebrow: "Waiting for you", title: "Which language?") {
            Text(job.message ?? "I heard no speech in these clips. What language do you speak in them?").font(.subheadline)
            ForEach(job.choices ?? [], id: \.self) { code in
                WideButton(title: Self.name(code), busy: busy) { pick(code) }
            }
            Menu {
                ForEach(Self.spoken, id: \.self) { code in Button(Self.name(code)) { pick(code) } }
            } label: {
                Text("Other…").frame(maxWidth: .infinity)
            }
            .disabled(busy)
        }
    }

    private func pick(_ code: String) {
        Task {
            busy = true
            await answer(code)
            busy = false
        }
    }
}

/// The look sheet's picture across the card, in its own shape.
private struct SheetPicture: View {
    let path: String
    let api: API?
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
        .task(id: path) { image = await ToolsetImages.shared.image(path, maxPixels: 1400, api: api) }
    }
}
