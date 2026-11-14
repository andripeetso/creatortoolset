import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Face Blur on the phone (the plug-in `blur-faces`, apps/captions/editor-steps/blur-faces/README.md): photos and videos
/// from Photos, the faces found and covered on this iPhone by the engine in FaceBlur/ (the same files as the Mac app's),
/// the covered copy saved to Photos. In "Only some faces" the server's `/pick` asks the person's AI which faces match.
/// Shows in More only on a server that has the plug-in, for an account it is on for.
struct FaceBlurView: View {
    static let plugin = "blur-faces"

    /// More's tile: the server has the plug-in and the account may use it.
    static func shows(plugins: [String], me: ToolsetAccess.Me?) -> Bool {
        plugins.contains(plugin) && ToolsetAccess.allows(plugin, me: me)
    }

    @StateObject private var model = FaceBlurModel()
    @State private var picked: [PhotosPickerItem] = []
    @State private var who = ""

    var body: some View {
        List {
            if let error = model.error {
                Text(error).foregroundStyle(.red)
            }
            if let settings = model.settings {
                Section("What to cover") {
                    Picker("Faces", selection: binding(\.mode, settings)) {
                        Text("Every face").tag(FaceBlurSettings.Mode.all)
                        Text("Only some faces").tag(FaceBlurSettings.Mode.some)
                    }
                    if settings.mode == .some {
                        VStack(alignment: .leading, spacing: 4) {
                            TextField("Which faces", text: $who)
                                .onSubmit { model.save { $0.who = who } }
                            Text("Your AI looks at each face and picks the ones that match").font(.footnote).foregroundStyle(.secondary)
                        }
                    }
                    Picker("Look", selection: binding(\.look, settings)) {
                        Text("Blur").tag(CoverLook.blur)
                        Text("Mosaic").tag(CoverLook.mosaic)
                        Text("Solid").tag(CoverLook.solid)
                    }
                }
                Section {
                    PhotosPicker(selection: $picked, matching: .any(of: [.images, .videos]), preferredItemEncoding: .current) {
                        Label("Choose photos and videos", systemImage: "photo.on.rectangle")
                    }
                }
            } else if model.error == nil {
                ProgressView()
            }
            if !model.items.isEmpty {
                Section("Files") {
                    ForEach(model.items) { item in FaceBlurRow(item: item, model: model) }
                }
            }
        }
        .navigationTitle("Face Blur")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            await model.load()
            who = model.settings?.who ?? ""
        }
        .onChange(of: picked) { _, items in
            guard !items.isEmpty else { return }
            picked = [] // so the same ones can be picked again
            model.add(items)
        }
    }

    private func binding<T>(_ key: WritableKeyPath<FaceBlurSettings, T>, _ settings: FaceBlurSettings) -> Binding<T> {
        Binding(get: { model.settings?[keyPath: key] ?? settings[keyPath: key] }, set: { value in model.save { $0[keyPath: key] = value } })
    }
}

private struct FaceBlurRow: View {
    let item: FaceBlurModel.Item
    @ObservedObject var model: FaceBlurModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(item.name).lineLimit(1).truncationMode(.middle)
                Spacer()
                Text(item.stage == .done && !item.saved ? "Nothing written" : item.stage.label)
                    .font(.subheadline).foregroundStyle(item.stage == .failed ? .red : .secondary)
            }
            if item.stage == .scanning || item.stage == .writing {
                ProgressView(value: item.progress)
            }
            if let error = item.error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            if let note = item.note {
                Text(note).font(.footnote).foregroundStyle(.secondary)
            }
            if item.stage == .done || (item.stage == .failed && item.scan != nil) {
                if !item.faces.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 12) {
                            ForEach(item.faces) { face in
                                VStack(spacing: 6) {
                                    if let data = Data(base64Encoded: face.picture), let image = UIImage(data: data) {
                                        Image(uiImage: image).resizable().scaledToFit().frame(height: 56)
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                    }
                                    Toggle("Cover", isOn: Binding(get: { face.blur }, set: { model.flip(item.id, face: face.id, to: $0) }))
                                        .labelsHidden()
                                        .accessibilityLabel("Cover \(face.note)")
                                }
                            }
                        }
                    }
                    Button("Blur again") { model.again(item.id) }
                        .buttonStyle(.bordered)
                        .disabled(model.busy)
                }
            }
        }
        .padding(.vertical, 4)
    }
}

/// The account's Face Blur settings (`GET/PUT /api/x/blur-faces/settings`).
struct FaceBlurSettings: Codable, Equatable {
    enum Mode: String, Codable { case all, some }
    var mode: Mode
    var who: String
    var look: CoverLook
}

@MainActor
final class FaceBlurModel: ObservableObject {
    enum Stage: Equatable {
        case queued, scanning, choosing, writing, done, failed
        var label: String {
            switch self {
            case .queued: "Waiting"
            case .scanning: "Finding faces"
            case .choosing: "Your AI is choosing the faces"
            case .writing: "Writing the copy"
            case .done: "Saved to Photos"
            case .failed: "Failed"
            }
        }
    }

    struct Face: Identifiable, Equatable {
        let id: String
        let picture: String
        let note: String
        var blur: Bool
    }

    struct Item: Identifiable {
        let id = UUID()
        var name: String
        var source: URL?
        var stage = Stage.queued
        var progress = 0.0
        var scan: FaceScan?
        var faces: [Face] = []
        var error: String?
        /// the last run saved a copy to Photos
        var saved = false
        /// copies of it in Photos so far
        var saves = 0
        /// "No face found, nothing written", or that an earlier copy is still in Photos
        var note: String?
    }

    @Published private(set) var settings: FaceBlurSettings?
    @Published private(set) var items: [Item] = []
    @Published private(set) var error: String?
    /// One file at a time, in the order picked.
    @Published private(set) var busy = false
    private var waiting: [UUID] = []

    /// Where the picked files are while the screen is open. A copy leaves as soon as it is in Photos; the picked files
    /// go when the screen closes and its work is done (the work holds this model), and any left by a crash when it opens.
    nonisolated static let folder = FileManager.default.temporaryDirectory.appendingPathComponent("face-blur", isDirectory: true)

    init() { try? FileManager.default.removeItem(at: Self.folder) }
    deinit { try? FileManager.default.removeItem(at: Self.folder) }

    private static let path = "/api/x/blur-faces"

    func load() async {
        guard settings == nil, let api = API.current else { return }
        do {
            settings = try await api.get("\(Self.path)/settings")
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func save(_ change: (inout FaceBlurSettings) -> Void) {
        guard let before = settings, let api = API.current else { return }
        var next = before
        change(&next)
        guard next != before else { return }
        settings = next
        Task {
            do {
                let body = try JSONSerialization.jsonObject(with: JSONEncoder().encode(next))
                settings = try JSONDecoder().decode(FaceBlurSettings.self, from: try await api.send("\(Self.path)/settings", method: "PUT", json: body))
            } catch {
                settings = before
                self.error = error.localizedDescription
            }
        }
    }

    func add(_ picked: [PhotosPickerItem]) {
        for p in picked {
            var item = Item(name: "From Photos")
            let id = item.id
            item.stage = .queued
            items.append(item)
            waiting.append(id)
            Task {
                do {
                    guard let file = try await p.loadTransferable(type: PickedMedia.self) else { throw MediaError.unreadable }
                    update(id) { $0.source = file.url; $0.name = file.url.lastPathComponent }
                } catch {
                    update(id) { $0.stage = .failed; $0.error = "Couldn't get it from Photos." }
                    waiting.removeAll { $0 == id }
                }
                next()
            }
        }
    }

    func flip(_ id: UUID, face: String, to on: Bool) {
        update(id) { item in
            if let i = item.faces.firstIndex(where: { $0.id == face }) { item.faces[i].blur = on }
        }
    }

    func again(_ id: UUID) {
        guard !waiting.contains(id) else { return }
        update(id) { $0.stage = .queued; $0.error = nil; $0.note = nil }
        waiting.append(id)
        next()
    }

    private func update(_ id: UUID, _ change: (inout Item) -> Void) {
        if let i = items.firstIndex(where: { $0.id == id }) { change(&items[i]) }
    }

    private func item(_ id: UUID) -> Item? { items.first { $0.id == id } }

    /// Starts the first waiting file whose copy out of Photos is in, when nothing runs.
    private func next() {
        guard !busy, let id = waiting.first(where: { item($0)?.source != nil }), let settings else { return }
        waiting.removeAll { $0 == id }
        busy = true
        Task {
            await run(id, settings: settings)
            busy = false
            next()
        }
    }

    private func run(_ id: UUID, settings: FaceBlurSettings) async {
        guard let source = item(id)?.source else { return }
        do {
            var scan = item(id)?.scan
            if scan == nil {
                update(id) { $0.stage = .scanning; $0.progress = 0 }
                let found = try await CoverPipeline.scan(source, preset: LookPreset(look: settings.look)) { p in
                    Task { @MainActor in self.update(id) { $0.progress = p } }
                }
                scan = found
                var blur = Set(found.faces.map(\.id))
                if settings.mode == .some, !found.faces.isEmpty {
                    update(id) { $0.stage = .choosing }
                    blur = try await pick(found.faces, who: settings.who)
                }
                update(id) { item in
                    item.scan = found
                    item.faces = found.faces.map { Face(id: $0.id, picture: $0.picture, note: $0.note, blur: blur.contains($0.id)) }
                }
            }
            guard let scan, let faces = item(id)?.faces else { return }
            update(id) { $0.stage = .writing; $0.progress = 0 }
            let folder = Self.folder.appendingPathComponent(id.uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let out = CoverPipeline.outputURL(for: folder.appendingPathComponent(source.lastPathComponent), kind: scan.kind, exists: { _ in false })
            try? FileManager.default.removeItem(at: out)
            try await CoverPipeline.write(scan, from: source, blur: Set(faces.filter(\.blur).map(\.id)), to: out) { p in
                Task { @MainActor in self.update(id) { $0.progress = p } }
            }
            try await SaveToPhotos.add([out])
            try? FileManager.default.removeItem(at: out)
            update(id) { item in
                item.stage = .done
                item.progress = 1
                item.saved = true
                item.saves += 1
                item.note = item.saves > 1 ? "Saved again, the earlier copy is still in Photos" : nil
            }
        } catch let nothing as CoverPipeline.NothingToCover {
            update(id) { item in
                item.stage = .done
                item.progress = 1
                item.saved = false
                item.note = item.saves > 0 ? "\(nothing.why), the earlier copy is still in Photos" : nothing.why
            }
        } catch is CancellationError {
            update(id) { $0.stage = .failed; $0.error = "Stopped" }
        } catch {
            update(id) { $0.stage = .failed; $0.error = error.localizedDescription }
        }
    }

    /// The person's AI picks the faces that match `who`. Throws the server's sentence when it can't: nothing is written.
    private func pick(_ faces: [ScannedFace], who: String) async throws -> Set<String> {
        guard let api = API.current else { throw APIError.signedOut }
        struct Picked: Decodable { let blur: [String] }
        let body: [String: Any] = ["who": who, "faces": faces.map { ["id": $0.id, "picture": $0.picture, "note": $0.note] }]
        let answer = try JSONDecoder().decode(Picked.self, from: try await api.send("\(Self.path)/pick", json: body))
        return Set(answer.blur)
    }
}

/// A photo or a video from Photos, copied as it is (HEIC, HEVC) into Face Blur's folder.
struct PickedMedia: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { try copy($0.file) }
        FileRepresentation(importedContentType: .image) { try copy($0.file) }
    }

    private static func copy(_ file: URL) throws -> PickedMedia {
        let folder = FaceBlurModel.folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let copy = folder.appendingPathComponent(file.lastPathComponent)
        try FileManager.default.copyItem(at: file, to: copy)
        return PickedMedia(url: copy)
    }
}
