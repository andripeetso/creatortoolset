import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Pick clips (Photos or Files), then one Upload button. They go to the Media Library of the server in use.
struct UploadView: View {
    @EnvironmentObject private var servers: Servers
    @EnvironmentObject private var engine: UploadEngine
    @EnvironmentObject private var store: UploadStore
    @State private var picks: [PhotosPickerItem] = []
    @State private var copying = 0
    @State private var importing = false
    @State private var problem: String?

    private var waiting: Int { store.items.filter { $0.state == .picked || $0.state == .failed }.count }

    var body: some View {
        List {
            if let problem { Problem(text: problem) }
            if copying > 0 {
                Label("Copying \(copying) from Photos…", systemImage: "hourglass").foregroundStyle(.secondary)
            }
            ForEach(store.items.reversed()) { item in
                UploadRow(item: item, live: store.liveBytes[item.id])
                    .swipeActions { Button("Remove", role: .destructive) { engine.remove(item.id) } }
            }
        }
        .overlay {
            if store.items.isEmpty && copying == 0 {
                ContentUnavailableView("Nothing picked", systemImage: "arrow.up.circle",
                                       description: Text("Pick clips from Photos or Files."))
            }
        }
        .safeAreaInset(edge: .bottom) {
            if waiting > 0 {
                Button { engine.uploadAll() } label: {
                    Text(waiting == 1 ? "Upload 1 file" : "Upload \(waiting) files").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .padding()
                .background(.bar)
            }
        }
        .navigationTitle("Upload")
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                if store.items.contains(where: { $0.state == .done }) {
                    Button("Clear") { engine.clearDone() }
                }
                Button { importing = true } label: { Image(systemName: "folder") }
                    .accessibilityLabel("Pick from Files")
                PhotosPicker(selection: $picks, matching: .any(of: [.videos, .images]), preferredItemEncoding: .current) {
                    Image(systemName: "plus")
                }
                .accessibilityLabel("Pick from Photos")
            }
        }
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            picks = []
            Task { await copy(items) }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.movie, .image, .audio, .item],
                      allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls { keep(url, name: url.lastPathComponent, scoped: true) }
        }
    }

    /// Each pick is copied into the app first: then it uploads with the app closed.
    private func copy(_ items: [PhotosPickerItem]) async {
        copying += items.count
        for item in items {
            defer { copying -= 1 }
            do {
                guard let file = try await item.loadTransferable(type: PickedFile.self) else { continue }
                add(file.url, name: file.name)
            } catch {
                problem = "Couldn't copy a clip from Photos: \(error.localizedDescription)"
            }
        }
    }

    private func keep(_ url: URL, name: String, scoped: Bool) {
        let ok = scoped ? url.startAccessingSecurityScopedResource() : false
        defer { if ok { url.stopAccessingSecurityScopedResource() } }
        let id = UUID()
        do {
            try FileManager.default.copyItem(at: url, to: AppFiles.upload(id))
            add(id: id, name: name)
        } catch {
            problem = "Couldn't copy \(name): \(error.localizedDescription)"
        }
    }

    private func add(_ file: URL, name: String) {
        // PickedFile already put it at AppFiles.upload(id); its name is the id
        guard let id = UUID(uuidString: file.lastPathComponent) else { return }
        add(id: id, name: name)
    }

    private func add(id: UUID, name: String) {
        guard let server = servers.current else { return }
        let size = ((try? FileManager.default.attributesOfItem(atPath: AppFiles.upload(id).path)[.size]) as? NSNumber)?.int64Value ?? 0
        guard size > 0 else {
            try? FileManager.default.removeItem(at: AppFiles.upload(id))
            problem = "\(name) is empty"
            return
        }
        problem = nil
        engine.add(id: id, filename: name, size: size, server: server)
    }
}

/// A clip from the Photos picker, moved into the app's upload folder under a fresh id.
struct PickedFile: Transferable {
    let url: URL
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in try take(received.file) }
        FileRepresentation(importedContentType: .image) { received in try take(received.file) }
    }

    private static func take(_ file: URL) throws -> PickedFile {
        let dest = AppFiles.upload(UUID())
        do {
            try FileManager.default.moveItem(at: file, to: dest)
        } catch {
            try FileManager.default.copyItem(at: file, to: dest)
        }
        return PickedFile(url: dest, name: file.lastPathComponent)
    }
}

struct UploadRow: View {
    let item: UploadItem
    let live: Int64?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(item.filename).lineLimit(1)
                Spacer()
                Text(label).font(.caption).foregroundStyle(item.state == .failed ? .orange : .secondary)
            }
            if item.isWorking {
                ProgressView(value: Double(live ?? item.sent), total: Double(max(item.size, 1)))
            }
            if let note = item.note { Text(note).font(.caption).foregroundStyle(.secondary) }
        }
    }

    private var label: String {
        switch item.state {
        case .picked: return ByteCountFormatter.string(fromByteCount: item.size, countStyle: .file)
        case .sending: return "\(Int(100 * Double(live ?? item.sent) / Double(max(item.size, 1))))%"
        case .finishing: return "Finishing"
        case .done: return item.duplicate ? "Already in the library" : "In the library"
        case .failed: return "Failed"
        }
    }
}
