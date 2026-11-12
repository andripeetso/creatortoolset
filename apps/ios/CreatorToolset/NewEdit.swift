import PhotosUI
import SwiftUI
import UIKit

/// A New edit made on the phone: clips picked from Photos, one Start. The edit is made on the server from the clips'
/// uploads before their bytes go (`POST /api/editor` with `uploads`), and the server starts it when the last byte is in,
/// so the phone can be put away.
struct PhoneEdit: Codable, Identifiable, Hashable {
    let id: UUID
    let server: String
    var name: String
    /// The clips' `UploadItem` ids, in the order picked.
    var clips: [UUID]
    /// The server's edit, once Start made it.
    var editId: String?
    /// Why Start did not get as far as the edit.
    var problem: String?
    /// When Start was pressed (its place in Chats); nil for one made before this was kept.
    var made: Date?
}

/// The edit as `GET /api/editor/:id` answers, only what the row needs.
struct RemoteEdit: Decodable, Equatable {
    struct Upload: Decodable, Equatable {
        let id: String
        let version: String?
    }
    struct Job: Decodable, Equatable {
        let kind: String
        let state: String
        let error: String?
    }
    struct Preview: Decodable, Equatable {
        let assetId: String
        let n: Int
    }
    let sources: [String]?
    let uploads: [Upload]?
    let jobs: [Job]?
    let previews: [String: Preview]?
}

/// What the row says.
enum EditState: Equatable {
    case starting
    case uploading(done: Int, of: Int)
    /// A clip did not get there, or Start stopped: Try again.
    case failed(String)
    case editing
    /// A step failed or needs a key: the edit's page says what.
    case stuck(String)
    /// The first version's preview in Review.
    case ready(path: String)

    static func of(_ edit: PhoneEdit, clips: [UUID: UploadItem], remote: RemoteEdit?, starting: Bool) -> EditState {
        if starting { return .starting }
        guard edit.editId != nil else { return .failed(edit.problem ?? "Not started") }
        if let remote {
            if let first = remote.previews?.min(by: { $0.key < $1.key })?.value {
                return .ready(path: "/review/\(first.assetId)?v=\(first.n)")
            }
            if !(remote.sources ?? []).isEmpty {
                if let last = remote.jobs?.last, last.state == "failed" || last.state == "needs_key" {
                    return .stuck(last.error ?? "Stopped")
                }
                return .editing
            }
        } else if edit.clips.allSatisfy({ clips[$0] == nil }) {
            // the copies are cleared once the edit has started; the server's answer is still on its way
            return .editing
        }
        // the server's word decides: a clip that failed here may have landed (its answer was lost)
        let landed = Set((remote?.uploads ?? []).filter { $0.version != nil }.map(\.id))
        var done = 0
        for id in edit.clips {
            let item = clips[id]
            if item?.state == .done || item?.uploadId.map(landed.contains) == true {
                done += 1
            } else if remote != nil && (item == nil || item?.state == .failed) {
                return .failed("A clip didn't upload")
            }
        }
        return .uploading(done: done, of: edit.clips.count)
    }
}

/// The phone's New edits, saved as JSON next to the uploads.
@MainActor
final class PhoneEdits: ObservableObject {
    static let shared = PhoneEdits()

    /// Newest first.
    @Published private(set) var list: [PhoneEdit] = []
    @Published private(set) var remote: [UUID: RemoteEdit] = [:]
    @Published private(set) var starting: Set<UUID> = []

    private let file = AppFiles.root.appendingPathComponent("edits.json")
    private var engine: UploadEngine { .shared }

    init() {
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([PhoneEdit].self, from: data) {
            list = saved
        }
    }

    func item(_ id: UUID) -> PhoneEdit? { list.first { $0.id == id } }

    func state(_ edit: PhoneEdit) -> EditState {
        let clips = Dictionary(uniqueKeysWithValues: engine.store.items.filter { $0.edit == edit.id }.map { ($0.id, $0) })
        return .of(edit, clips: clips, remote: remote[edit.id], starting: starting.contains(edit.id))
    }

    func add(_ edit: PhoneEdit) {
        list.insert(edit, at: 0)
        save()
    }

    /// Off the phone's list; the edit stays on the server.
    func forget(_ id: UUID) {
        for clip in item(id)?.clips ?? [] { engine.remove(clip) }
        list.removeAll { $0.id == id }
        remote[id] = nil
        save()
    }

    /// Start's order, the point of it all: every clip's upload made, then the edit from their ids, then the bytes.
    static func run(prepare: () async throws -> [String], makeEdit: ([String]) async throws -> Void,
                    send: () -> Void) async throws {
        let uploads = try await prepare()
        try await makeEdit(uploads)
        send()
    }

    /// `beforeBytes` runs between the edit and its bytes (the server tests look at the waiting edit there).
    func start(_ id: UUID, beforeBytes: () async throws -> Void = {}) async {
        guard let edit = item(id), let server = Servers.shared.list.first(where: { $0.id == edit.server }) else { return }
        let api = API(server: server.url, cookie: Keychain.get(server.id))
        starting.insert(id)
        // the phone locked right after Start: iOS gives the app the moment it needs to make the edit and hand over the bytes
        let background = UIApplication.shared.beginBackgroundTask(withName: "New edit")
        defer {
            starting.remove(id)
            UIApplication.shared.endBackgroundTask(background)
        }
        do {
            try await Self.run(
                prepare: { try await engine.prepare(edit.clips) },
                makeEdit: { uploads in
                    guard uploads.count == edit.clips.count else { throw APIError.server(0, "A clip has no upload") }
                    struct Made: Decodable { let id: String }
                    let made = try JSONDecoder().decode(Made.self, from: try await api.send(
                        "/api/editor", json: ["name": edit.name, "uploads": uploads]))
                    update(id) {
                        $0.editId = made.id
                        $0.problem = nil
                    }
                    try await beforeBytes()
                },
                send: { engine.send(edit.clips) })
        } catch {
            update(id) { $0.problem = error.localizedDescription }
        }
    }

    /// A fresh edit from the clips still on the phone: the old one goes to the trash, every clip is sent again (one
    /// the library has already counts as itself).
    func retry(_ id: UUID) async {
        // starting the whole time: a second tap, or a refresh in between, leaves it alone
        guard let edit = item(id), !starting.contains(id) else { return }
        starting.insert(id)
        defer { starting.remove(id) }
        if let old = edit.editId {
            if let server = Servers.shared.list.first(where: { $0.id == edit.server }) {
                _ = try? await API(server: server.url, cookie: Keychain.get(server.id)).send("/api/editor/\(old)", method: "DELETE")
            }
            let kept = edit.clips.filter {
                engine.store.item($0) != nil && FileManager.default.fileExists(atPath: AppFiles.upload($0).path)
            }
            for clip in edit.clips where !kept.contains(clip) { engine.remove(clip) }
            await engine.restart(kept)
            remote[id] = nil
            update(id) {
                $0.editId = nil
                $0.clips = kept
                $0.problem = kept.isEmpty ? "The clips are gone from the phone" : nil
            }
            if kept.isEmpty { return }
        }
        await start(id)
    }

    /// The edits of the server in use, as it sees them. Clips a Start left unsent go now; once an edit has started,
    /// its copies on the phone are cleared.
    func refresh() async {
        for edit in list where edit.editId != nil && !starting.contains(edit.id) {
            let unsent = edit.clips.filter { engine.store.item($0)?.state == .picked }
            if !unsent.isEmpty { engine.send(unsent) }
        }
        guard let api = Servers.shared.api, let current = Servers.shared.currentId else { return }
        for edit in list where edit.server == current && !starting.contains(edit.id) {
            guard let editId = edit.editId else { continue }
            if case .ready = state(edit) { continue }
            // an answer about an edit that Try again replaced in the meantime is dropped
            let still = { self.item(edit.id)?.editId == editId && !self.starting.contains(edit.id) }
            do {
                let answer: RemoteEdit = try await api.get("/api/editor/\(editId)")
                guard still() else { continue }
                remote[edit.id] = answer
                if !(answer.sources ?? []).isEmpty {
                    for clip in edit.clips where engine.store.item(clip) != nil { engine.remove(clip) }
                }
            } catch APIError.server(404, _) {
                // deleted (or trashed) on the computer
                if still() { forget(edit.id) }
            } catch {}
        }
    }

    private func update(_ id: UUID, _ change: (inout PhoneEdit) -> Void) {
        guard let i = list.firstIndex(where: { $0.id == id }) else { return }
        change(&list[i])
        save()
    }

    private func save() {
        try? JSONEncoder().encode(list).write(to: file, options: .atomic)
    }
}

/// Pick the clips (videos from Photos, in the order picked), then Start.
struct NewEditView: View {
    struct Clip: Identifiable {
        let id: UUID
        let name: String
        let size: Int64
    }

    static let maxClips = 50

    @EnvironmentObject private var servers: Servers
    @EnvironmentObject private var engine: UploadEngine
    @EnvironmentObject private var edits: PhoneEdits
    @Environment(\.dismiss) private var dismiss
    @State private var clips: [Clip] = []
    @State private var picks: [PhotosPickerItem] = []
    @State private var picking = false
    @State private var copying = 0
    @State private var started = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            List {
                if let problem { Problem(text: problem) }
                ForEach(clips) { clip in
                    HStack {
                        Text(clip.name).lineLimit(1)
                        Spacer()
                        Text(ByteCountFormatter.string(fromByteCount: clip.size, countStyle: .file))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
                .onDelete { rows in
                    for i in rows { try? FileManager.default.removeItem(at: AppFiles.upload(clips[i].id)) }
                    clips.remove(atOffsets: rows)
                }
                if copying > 0 {
                    Label("Copying \(copying) from Photos…", systemImage: "hourglass").foregroundStyle(.secondary)
                }
            }
            .overlay {
                if clips.isEmpty && copying == 0 {
                    Button("Pick clips", systemImage: "photo.on.rectangle") { picking = true }
                        .buttonStyle(.bordered)
                        .controlSize(.large)
                }
            }
            .safeAreaInset(edge: .bottom) {
                if !clips.isEmpty {
                    Button(action: start) { Text("Start").frame(maxWidth: .infinity) }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.large)
                        .disabled(copying > 0)
                        .padding()
                        .background(.bar)
                }
            }
            .navigationTitle("New edit")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { picking = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add clips")
                        .disabled(clips.count >= Self.maxClips)
                }
            }
            .photosPicker(isPresented: $picking, selection: $picks, maxSelectionCount: max(1, Self.maxClips - clips.count),
                          selectionBehavior: .ordered, matching: .videos, preferredItemEncoding: .current)
        }
        .interactiveDismissDisabled(!clips.isEmpty)
        .onAppear {
            #if DEBUG
            // `-newEditFiles a.mp4,b.mp4` picks those files (simulator screenshots: nothing to tap there)
            if let paths = UserDefaults.standard.string(forKey: "newEditFiles") {
                for path in paths.split(separator: ",").map(String.init) {
                    let id = UUID()
                    if (try? FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: AppFiles.upload(id))) != nil {
                        keep(id, name: (path as NSString).lastPathComponent)
                    }
                }
                return
            }
            #endif
            if clips.isEmpty { picking = true }
        }
        .onDisappear {
            if !started { for clip in clips { try? FileManager.default.removeItem(at: AppFiles.upload(clip.id)) } }
        }
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            picks = []
            Task { await copy(items) }
        }
    }

    /// One at a time, so the clips keep the order they were picked in.
    private func copy(_ items: [PhotosPickerItem]) async {
        copying += items.count
        for item in items {
            defer { copying -= 1 }
            do {
                guard let file = try await item.loadTransferable(type: PickedFile.self),
                      let id = UUID(uuidString: file.url.lastPathComponent) else { continue }
                keep(id, name: file.name)
            } catch {
                problem = "Couldn't copy a clip from Photos: \(error.localizedDescription)"
            }
        }
    }

    private func keep(_ id: UUID, name: String) {
        let size = ((try? FileManager.default.attributesOfItem(atPath: AppFiles.upload(id).path)[.size]) as? NSNumber)?.int64Value ?? 0
        guard size > 0, clips.count < Self.maxClips else {
            try? FileManager.default.removeItem(at: AppFiles.upload(id))
            return
        }
        clips.append(Clip(id: id, name: name, size: size))
    }

    private func start() {
        guard let server = servers.current else { return }
        let id = UUID()
        for clip in clips { engine.add(id: clip.id, filename: clip.name, size: clip.size, server: server, edit: id) }
        let name = "Phone edit, " + Date().formatted(date: .abbreviated, time: .shortened)
        edits.add(PhoneEdit(id: id, server: server.id, name: name, clips: clips.map(\.id), made: Date()))
        started = true
        dismiss()
        Task { await edits.start(id) }
    }
}

/// One New edit in Chats: how far it is, and the way into it (its Review video once ready, else its page).
struct PhoneEditRow: View {
    let edit: PhoneEdit
    @EnvironmentObject private var servers: Servers
    @EnvironmentObject private var edits: PhoneEdits
    @EnvironmentObject private var store: UploadStore

    var body: some View {
        let state = edits.state(edit)
        if let api = servers.api, let path = path(state) {
            NavigationLink {
                WebAppView(api: api, path: path).ignoresSafeArea(edges: .bottom).navigationBarTitleDisplayMode(.inline)
            } label: {
                card(state)
            }
            .buttonStyle(.plain)
        } else {
            card(state)
        }
    }

    private func path(_ state: EditState) -> String? {
        switch state {
        case .ready(let path): return path
        case .starting, .failed: return nil
        case .uploading, .editing, .stuck: return edit.editId.map { "/editor/\($0)" }
        }
    }

    private func card(_ state: EditState) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Image(systemName: "film").foregroundStyle(.secondary)
                Text(edit.name).lineLimit(1)
                Spacer()
                status(state)
            }
            if case .uploading = state { ProgressView(value: sentFraction) }
            if case .failed(let why) = state {
                HStack {
                    Text(why).font(.caption).foregroundStyle(.orange)
                    Spacer()
                    Button("Try again") { Task { await edits.retry(edit.id) } }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                }
            }
            if case .stuck(let why) = state { Text(why).font(.caption).foregroundStyle(.orange).lineLimit(2) }
        }
        .padding(12)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
        .contextMenu { Button("Remove", systemImage: "trash", role: .destructive) { edits.forget(edit.id) } }
    }

    @ViewBuilder private func status(_ state: EditState) -> some View {
        switch state {
        case .starting: Text("Starting…").font(.caption).foregroundStyle(.secondary)
        case .uploading(let done, let of): Text("\(done) of \(of) uploaded").font(.caption).foregroundStyle(.secondary)
        case .failed, .stuck: Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.orange)
        case .editing: Text("Editing").font(.caption).foregroundStyle(.secondary)
        case .ready: Text("Ready to review").font(.caption.weight(.semibold)).foregroundStyle(Color.accentColor)
        }
    }

    private var sentFraction: Double {
        let items = store.items.filter { $0.edit == edit.id }
        let total = items.reduce(Int64(0)) { $0 + $1.size }
        let sent = items.reduce(Int64(0)) { $0 + ($1.state == .done ? $1.size : store.liveBytes[$1.id] ?? $1.sent) }
        return total > 0 ? Double(sent) / Double(total) : 0
    }
}
