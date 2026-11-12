import Foundation

/// A message written on the phone that has not gone yet, with what goes with it.
struct QueuedMessage: Codable, Equatable, Identifiable {
    var id = UUID().uuidString
    var text: String
    var images: [Picture] = []
    /// Videos already uploaded: the message names them by id.
    var files: [File] = []
    /// The highlighted text the message asks about (a failed reply's question sent again keeps it).
    var quote: String?
    /// Why the server would not take it. It stays, marked "Not sent", until he sends it again or removes it.
    var failed: String?
    /// The conversation's last message when this was first tried: tells a lost answer from a lost message.
    var triedAfter: String?

    /// A picture as it is sent: always JPEG.
    struct Picture: Codable, Equatable, Identifiable {
        var id = UUID().uuidString
        var name: String
        var jpeg: Data
    }

    struct File: Codable, Equatable, Identifiable {
        var id: String
        var name: String
    }

    /// "2 pictures, Clip.mov": what it carries besides its words.
    var attached: String {
        var parts = images.isEmpty ? [] : [images.count == 1 ? "1 picture" : "\(images.count) pictures"]
        parts += files.map(\.name)
        return parts.joined(separator: ", ")
    }
}

/// The messages that wait to go, oldest first, kept on disk so they survive the app closing.
/// Nothing queues on the server: the phone sends one when the assistant is free, then the next.
@MainActor
final class AssistantOutbox: ObservableObject {
    /// What became of one try.
    enum Outcome: Equatable {
        case sent
        /// No connection, or a reply is still being written: it goes later.
        case later
        /// The server will never take it as it is.
        case refused(String)
    }

    @Published private(set) var items: [QueuedMessage] = []
    /// The one on its way right now: drawn as a sent message, not as a queued one.
    @Published private(set) var sending: String?
    private var file: URL?

    /// Something can still go by itself.
    var waiting: Bool { items.contains { $0.failed == nil } }

    /// Each account on each computer has its own queue.
    static func file(for account: String) -> URL {
        let name = account.replacingOccurrences(of: "/", with: "-")
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("assistant-outbox", isDirectory: true)
            .appendingPathComponent(name + ".json")
    }

    /// Reads the queue kept in `file`; nil is no account: nothing queued, nothing saved.
    func open(_ file: URL?) {
        guard file != self.file else { return }
        self.file = file
        items = file.flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode([QueuedMessage].self, from: $0) } ?? []
    }

    func add(_ message: QueuedMessage) {
        items.append(message)
        save()
    }

    func remove(_ id: String) {
        items.removeAll { $0.id == id }
        save()
    }

    /// A message marked "Not sent" goes back in line.
    func retry(_ id: String) {
        change(id) { $0.failed = nil }
    }

    func tried(_ id: String, after mark: String) {
        change(id) { $0.triedAfter = mark }
    }

    /// Sends the oldest message that can still go: one per call, and never two at once.
    /// Answers what became of it; nil when nothing was tried.
    @discardableResult
    func drain(send: (QueuedMessage) async -> Outcome) async -> Outcome? {
        guard sending == nil, let next = items.first(where: { $0.failed == nil }) else { return nil }
        sending = next.id
        let outcome = await send(next)
        sending = nil
        switch outcome {
        case .sent: remove(next.id)
        case .later: break
        case .refused(let why): change(next.id) { $0.failed = why }
        }
        return outcome
    }

    private func change(_ id: String, _ edit: (inout QueuedMessage) -> Void) {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return }
        edit(&items[index])
        save()
    }

    // ponytail: the pictures sit inside the one JSON file (a few MB at most); a file each if the queue ever gets long
    private func save() {
        guard let file else { return }
        if items.isEmpty {
            try? FileManager.default.removeItem(at: file)
            return
        }
        guard let data = try? JSONEncoder().encode(items) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
}
