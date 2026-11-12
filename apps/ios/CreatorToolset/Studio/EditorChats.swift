import Combine
import SwiftUI

// The studio plug-in's AI Editor on Edits: one card per edit, saying what it waits for. The heavy work
// runs on the Mac; the phone reads the server's list and its to-do (`/api/editor`, `/api/editor/todo`).
// Only on a server with the plug-in, for an admin (`EditorChats.on`).

/// An edit as the list sends it (`GET /api/editor`).
struct EditorSummary: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let updatedAt: Double
    let drafts: Int
    let busy: Bool
    let usage: EditorUsage?
    /// "editing", "toPost" or "published".
    var stage: String?
}

struct EditorUsage: Codable, Hashable {
    let calls: Int
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    let costUsd: Double

    enum CodingKeys: String, CodingKey {
        case calls, input, output
        case cacheRead = "cache_read", cacheWrite = "cache_write", costUsd = "cost_usd"
    }
}

/// What waits, runs and failed across the edits (`GET /api/editor/todo`). A list the server
/// leaves out or changes reads as empty.
struct EditorTodo: Decodable {
    var worker: Worker?
    /// Videos in Review that wait for him.
    var review: [Video] = []
    var changes: [Change] = []
    var running: [Job] = []
    var queued: [Job] = []
    /// Every job that waits for his go: a held pass of "Edit in passes", or a look sheet.
    var sheets: [Job] = []
    var failed: [Job] = []

    struct Worker: Decodable, Equatable {
        var online: Bool
        var host: String?
    }

    struct Video: Decodable {
        var key: String
        var asset: String
        var name: String
        var ai: Made?

        struct Made: Decodable { var edit: String }
    }

    struct Change: Decodable {
        var key: String
        var edit: String
        var draft: String?
    }

    struct Job: Decodable {
        /// "j:<edit>:<job>".
        var key: String
        var edit: String
        var kind: String
        var error: String?
        /// Milliseconds since 1970: when it started, or was queued.
        var at: Double
        /// true = a held pass. Absent on a look sheet, and on every row of an older server.
        var hold: Bool?
        /// 0 to 1, while it runs.
        var progress: Double?

        var job: String { key.split(separator: ":").last.map(String.init) ?? "" }
    }

    private enum Keys: String, CodingKey { case worker, review, changes, running, queued, sheets, failed }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        func list<T: Decodable>(_ key: Keys) -> [T] { (try? c.decode([T].self, forKey: key)) ?? [] }
        worker = try? c.decode(Worker.self, forKey: .worker)
        review = list(.review)
        changes = list(.changes)
        running = list(.running)
        queued = list(.queued)
        sheets = list(.sheets)
        failed = list(.failed)
    }
}

/// A job of the AI Editor in plain words.
enum EditorWords {
    private static let table: [String: (short: String, doing: String, did: String)] = [
        "analyze": ("Sorting", "Sorting the footage", "Sorted the footage"),
        "script": ("Script", "Writing the script", "Wrote the script"),
        "draft": ("Cut", "Cutting a draft", "Cut a draft"),
        "preview": ("Preview", "Rendering the preview", "Rendered the preview"),
        "camera": ("Camera view", "Rendering the camera view", "Rendered the camera view"),
        "broll": ("B-roll", "Adding B-roll", "Added B-roll"),
        "graphics": ("Graphics", "Adding graphics", "Added graphics"),
        "music": ("Music", "Adding music", "Added music"),
        "revise": ("Revising", "Revising from the comments", "Revised from the comments"),
        "import_resolve": ("Resolve", "Bringing back the Resolve edit", "Brought back the Resolve edit"),
        "save_edit": ("Saving", "Saving the edit", "Saved the edit"),
        "open_in_resolve": ("Resolve", "Opening in Resolve", "Opened in Resolve"),
        "package": ("Package", "Making the Resolve package", "Made the Resolve package"),
        "merge": ("Passes", "Putting the passes together", "Put the passes together"),
        "takes": ("Takes", "Cutting the takes to watch", "Cut the takes to watch"),
        "voice": ("Voice", "Blending the voices", "Blended the voices"),
        "handover": ("Handover", "Handing over to your editor", "Handed over to your editor"),
        "next_round": ("Next round", "Starting the next round", "Started the next round"),
    ]

    /// A job the phone has no words for yet reads as its own name.
    private static func plain(_ kind: String) -> String {
        let words = kind.replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// "Graphics": for a row of the Working shelf.
    static func short(_ kind: String) -> String { table[kind]?.short ?? plain(kind) }
    /// "Adding graphics": while it runs.
    static func doing(_ kind: String) -> String { table[kind]?.doing ?? plain(kind) }
    /// "Added graphics": once it is done.
    static func did(_ kind: String) -> String { table[kind]?.did ?? plain(kind) }
    /// A pass of "Edit in passes" as the server names it: "B-roll", "graphics", "music".
    static func pass(_ kind: String) -> String { kind == "broll" ? "B-roll" : kind.replacingOccurrences(of: "_", with: " ") }
    /// The line of an edit whose next pass waits for the go.
    static func held(_ kind: String) -> String {
        "\(kind == "broll" ? "First cut" : "Cut") is ready · next: \(pass(kind))"
    }
}

/// The AI Editor's part of Chats: its rows, "Mark read", the Mac that is offline, and its button under a Review video.
@MainActor
enum EditorChats {
    /// The Mac that does the editing, as the to-do last said.
    private(set) static var worker: EditorTodo.Worker?
    /// Older servers don't say which waiting job is a held pass: asked from the edit once per job.
    private static var heldJobs: [String: Bool] = [:]

    /// Registered once at launch, for every server: each part checks `on` itself, so another server (or an account
    /// that isn't an admin) gets nothing from here.
    static func register() {
        ChatsModel.sources.append { api in
            guard on else {
                worker = nil
                ChatsModel.shared.notice = nil
                return []
            }
            return try await rows(from: api)
        }
        ChatsModel.markRead = { api, row in
            guard on else { return }
            _ = try? await api.send("/api/editor/todo/read", json: ["keys": row.keys])
        }
        ReviewExtras.actions = { asset, comments in
            on ? AnyView(ReviseFromComments(asset: asset, comments: comments)) : AnyView(EmptyView())
        }
        // the plug-in list or the account arrives after Chats' first read (a first sign-in): read again
        ServerPlugins.shared.$known.map { $0.plugins.contains(Studio.plugin) }
            .combineLatest(ToolsetAccess.shared.$me.map { ToolsetAccess.allows(nil, me: $0) })
            .removeDuplicates { $0 == $1 }
            .dropFirst()
            .sink { _ in Task { await ChatsModel.shared.load() } }
            .store(in: &bag)
    }

    /// The AI Editor is the studio plug-in's, and admins only.
    static var on: Bool { ServerPlugins.shared.studio && ToolsetAccess.shared.allows(nil) }

    private static var bag = Set<AnyCancellable>()

    /// "<Mac> is offline", or nil while it answers.
    static var offline: String? {
        guard let worker, !worker.online else { return nil }
        return "\(worker.host ?? "The Mac") is offline"
    }

    private static func rows(from api: ToolsetAPI) async throws -> [ChatRow] {
        async let list: Tolerant<EditorSummary> = orNothing(Tolerant()) { try await api.get("/api/editor") }
        async let waits: EditorTodo = orNothing(EditorTodo()) { try await api.get("/api/editor/todo") }
        let (read, todo) = try await (list, waits)
        let edits = read.items
        ChatsModel.shared.unreadable += read.skipped
        for job in todo.sheets where job.hold == nil && heldJobs[job.key] == nil {
            let edit: EditorProject? = try? await api.get("/api/editor/\(job.edit)")
            heldJobs[job.key] = edit?.jobs.first { $0.id == job.job }?.hold == true
        }
        worker = todo.worker
        ChatsModel.shared.notice = edits.isEmpty ? nil : offline
        return rows(edits: edits, todo: todo, held: Set(heldJobs.filter(\.value).keys))
    }

    /// One row per edit. What it says, first that applies: a job waits for his go; its video waits
    /// in Review; a job failed; a job runs or is queued (the Working shelf); he asked for changes;
    /// it is ready to post or published (the Done shelf); otherwise how many cuts it has.
    /// `held`: the to-do keys of waiting jobs known to be held passes (for a server that doesn't say).
    nonisolated static func rows(edits: [EditorSummary], todo: EditorTodo, held: Set<String> = []) -> [ChatRow] {
        edits.map { edit in
            let when = date(ms: edit.updatedAt)
            let sheets = todo.sheets.filter { $0.edit == edit.id }
            let review = todo.review.filter { $0.ai?.edit == edit.id }
            let failed = todo.failed.filter { $0.edit == edit.id }
            let keys = (sheets.map(\.key) + review.map(\.key) + failed.map(\.key))
            func row(_ detail: String, _ status: RowStatus, error: Bool = false, shelf: ChatRow.Shelf = .active, finished: Date? = nil) -> ChatRow {
                ChatRow(id: "/editor/\(edit.id)", route: .edit(edit.id), title: edit.name, detail: detail, detailIsError: error,
                        status: status, at: when, shelf: shelf, keys: keys, finished: finished)
            }
            if let job = sheets.first {
                return row(job.hold ?? held.contains(job.key) ? EditorWords.held(job.kind) : "Look sheet is ready", .yourGo)
            }
            if let video = review.first { return row("\(video.name) is in Review", .review) }
            if let job = failed.first { return row(job.error ?? "\(EditorWords.doing(job.kind)) failed", .failed, error: true) }
            if let job = todo.running.first(where: { $0.edit == edit.id }) {
                let done = Int((job.progress ?? 0) * 100)
                return row(EditorWords.short(job.kind) + (done > 0 ? " \(done)%" : ""), .working(since: date(ms: job.at)), shelf: .working)
            }
            if let job = todo.queued.first(where: { $0.edit == edit.id }) {
                return row(EditorWords.short(job.kind), .working(since: nil), shelf: .working)
            }
            if let change = todo.changes.first(where: { $0.edit == edit.id }) {
                return row(["Changes requested", change.draft].compactMap { $0 }.joined(separator: " on "), .time(when))
            }
            let cuts = edit.drafts == 0 ? "" : "\(edit.drafts) cut\(edit.drafts == 1 ? "" : "s")"
            if edit.stage == "published" || edit.stage == "toPost" { return row(cuts, .time(when), shelf: .done) }
            // ponytail: "finished" is the edit's last change with cuts and nothing running; a rename on the Mac reads as Done once more
            return row(cuts, .time(when), finished: edit.drafts > 0 ? when : nil)
        }
    }
}

/// Under a Review video that an edit made: "Revise from 2 comments". The editor makes the next
/// cut from the open comments, and the edit's thread opens to follow it.
private struct ReviseFromComments: View {
    let asset: ReviewAsset
    let comments: [ReviewComment]
    @State private var made: Made?
    @State private var busy = false
    @State private var error: String?

    /// The newest version an edit made: which edit, which of its cuts.
    struct Made: Equatable {
        var edit: String
        var draft: String
        var version: Int
    }

    private struct Detail: Decodable {
        var asset: Video
        struct Video: Decodable { var versions: [Version] }
        struct Version: Decodable {
            var n: Int
            var edit: Edit?
        }
        struct Edit: Decodable {
            var project: String
            var draft: String
        }
    }

    private var open: Int {
        comments.filter { $0.version == made?.version && $0.parentId == nil && $0.resolved != true }.count
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let made, open > 0 {
                WideButton(title: "Revise from \(open) comment\(open == 1 ? "" : "s")", systemImage: "wand.and.stars", kind: .plain, busy: busy) {
                    Task { await revise(made) }
                }
            }
            if let error { Text(error).font(.footnote).foregroundStyle(.red) }
        }
        .task(id: asset.versions.count) {
            guard let api = ToolsetAPI.current,
                  let detail: Detail = try? await api.get("/api/review/assets/\(asset.id)"),
                  let newest = detail.asset.versions.last, let edit = newest.edit else { return }
            made = Made(edit: edit.project, draft: edit.draft, version: newest.n)
        }
    }

    private func revise(_ made: Made) async {
        guard let api = ToolsetAPI.current else { return }
        busy = true
        defer { busy = false }
        do {
            try await api.send("/api/editor/\(made.edit)/drafts/\(pathPiece(made.draft))/revise")
            error = nil
            AppNavigator.shared.open(.edit(made.edit))
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// A name as one piece of a path ("V1A 2" → "V1A%202").
func pathPiece(_ name: String) -> String {
    name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? name
}
