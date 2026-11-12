import Foundation
import UIKit

/// A message written on the phone that has not gone yet, with what goes with it.
struct QueuedMessage: Codable, Equatable, Identifiable {
    var id = UUID().uuidString
    var text: String
    var images: [Picture] = []
    /// Videos already uploaded: the message names them by id.
    var files: [File] = []
    /// Videos still to go up, in the order they were picked: the message waits for them.
    /// Never set on a message an older app saved.
    var videos: [Video]?
    /// The highlighted text the message asks about (a failed reply's question sent again keeps it).
    var quote: String?
    /// Why the server would not take it. It stays, marked "Not sent", until he sends it again or removes it.
    var failed: String?
    /// The conversation's last message when this was first tried: tells a lost answer from a lost message.
    var triedAfter: String?
    /// The server took it before its videos were up, and holds its reply until they are: that reply's id.
    /// It stays here only for those videos; the conversation shows it.
    var reply: String?

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

    /// A picked video until it is up.
    struct Video: Codable, Equatable, Identifiable {
        var id = UUID().uuidString
        var name: String
        /// Its copy out of Photos: the name of its folder in `AssistantPickedVideo.folder` (a name, not a
        /// path: the app's folders move when it is updated).
        var copy: String
        /// The server's id for it from the moment its upload began: a later try carries on from the parts the server has.
        var file: String?
        /// Photos is still handing it over (a big video, one kept in iCloud): its name and copy are not known
        /// yet, and nothing of it can go up until they are.
        var pending: Bool?
    }
}

/// The messages that wait to go, oldest first, kept on disk so they survive the app closing, and the
/// videos they carry, which go up from here one at a time. A message waits for its videos; the ones after
/// it wait behind it. A video in the message box goes nowhere: its upload starts when its message is sent.
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

    /// How a video goes up: `begin` gets the server's id for it, `send` sends its parts (from those the server
    /// has) and joins them, telling the id again if it had to start over (`begun`) and how far it is (0…1).
    /// `handOver` gives iOS all that is left of the videos named, to send by itself while the app is away.
    struct Uploader {
        var begin: (QueuedMessage.Video) async throws -> String
        var send: (QueuedMessage.Video, _ begun: @escaping @MainActor (String) -> Void,
                   _ progress: @escaping @Sendable (Double) -> Void) async throws -> String
        var handOver: ([QueuedMessage.Video]) async -> Void = { _ in }
    }

    @Published private(set) var items: [QueuedMessage] = []
    /// The one on its way right now: drawn as a sent message, not as a queued one.
    @Published private(set) var sending: String?
    /// How far each video going up right now has got, by its id: drawn on its message, never saved.
    @Published private(set) var progress: [String: Double] = [:]
    /// The server takes a message whose videos are still going up and holds its reply until they are in,
    /// and takes messages while a reply is being written (its view says `sendNow`). Not known yet, or an
    /// older server: a message waits on the phone for its videos and for the reply before it.
    var serverWaits = false
    private var file: URL?
    /// How the videos went up last: the same way takes them over when the app leaves the front.
    private var uploader: Uploader?
    private var uploading: Task<Void, Never>?
    private var beginning: Task<Void, Never>?
    /// The video going up, by its id.
    private var going: String?
    private var moment = UIBackgroundTaskIdentifier.invalid
    /// How far each video has ever got, by its id (`progress` is whole percents and goes when it stops).
    private var reached: [String: Double] = [:]
    /// Server errors in a row on a video that got no further, by its id: a server that answers but keeps
    /// failing the parts (its disk full) must not hold the line for ever.
    private var stalls: [String: (reached: Double, count: Int)] = [:]
    static let maxStalls = 4

    init() {
        // already as the app stops being in front: what iOS is handed once the app is in the background it may
        // keep for a better moment (power, Wi-Fi). Again in the background, for a video that got its id since.
        for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.leave() }
            }
        }
    }

    /// The app leaves the front (he locks the phone, opens another app): every video that has the server's
    /// id is handed to iOS as it stands, oldest message first, and goes on up without the app.
    // ponytail: a video with no id yet, or still coming from Photos, is not handed over: it goes when the app is open again
    func leave() {
        let videos = items.filter { $0.failed == nil }.flatMap { $0.videos ?? [] }.filter { $0.file != nil }
        guard let uploader, !videos.isEmpty else { return }
        let moment = UIApplication.shared.beginBackgroundTask()
        Task {
            await uploader.handOver(videos)
            UIApplication.shared.endBackgroundTask(moment)
        }
    }

    /// Something can still go by itself.
    var waiting: Bool { items.contains { $0.failed == nil } }

    /// What the feed draws: every message the conversation does not show yet.
    var shown: [QueuedMessage] { items.filter { $0.reply == nil || $0.failed != nil } }

    /// How far each video of a message the server already took has got, by the server's id for it.
    var carried: [String: Double] {
        var up: [String: Double] = [:]
        for message in items where message.reply != nil {
            for video in message.videos ?? [] { if let file = video.file { up[file] = progress[video.id] ?? 0 } }
        }
        return up
    }

    /// Whether a message can go to the server now, the one place that decides it: when every video it
    /// carries has the server's id, to a server that waits for them; when they are all up, to any other.
    nonisolated static func ready(_ message: QueuedMessage, serverWaits: Bool) -> Bool {
        let videos = message.videos ?? []
        return serverWaits ? videos.allSatisfy { $0.file != nil } : videos.isEmpty
    }

    /// Each account on each computer has its own queue.
    nonisolated static func file(for account: String) -> URL {
        let name = account.replacingOccurrences(of: "/", with: "-")
        return FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("assistant-outbox", isDirectory: true)
            .appendingPathComponent(name + ".json")
    }

    /// Reads the queue kept in `file`; nil is no account: nothing queued, nothing saved.
    func open(_ file: URL?) {
        guard file != self.file else { return }
        stopUploading()
        beginning?.cancel()
        beginning = nil
        serverWaits = false
        self.file = file
        items = (file.flatMap { try? Data(contentsOf: $0) }
            .flatMap { try? JSONDecoder().decode([QueuedMessage].self, from: $0) } ?? []).map(Self.afterRestart)
    }

    /// A video Photos was still handing over when the app closed never came: it leaves its message, which
    /// is marked Not sent and says so.
    nonisolated static func afterRestart(_ message: QueuedMessage) -> QueuedMessage {
        guard message.videos?.contains(where: { $0.pending == true }) == true else { return message }
        var message = message
        message.videos?.removeAll { $0.pending == true }
        if message.videos?.isEmpty == true { message.videos = nil }
        message.failed = "A video was still coming from Photos when the app closed: add it again"
        return message
    }

    func add(_ message: QueuedMessage) {
        items.append(message)
        save()
    }

    /// Out of the queue. Its videos keep their copies and their uploads: the message box may take them back.
    func remove(_ id: String) {
        items.removeAll { $0.id == id }
        save()
    }

    /// A video that left the box with its message before Photos had handed it over: now it has (it can go
    /// up), or it could not be read (it leaves the message, which is marked Not sent). One whose message
    /// is gone is thrown away.
    func handed(_ video: String, _ picked: AssistantPickedVideo?) {
        guard let message = holder(of: video) else {
            picked?.discard()
            return
        }
        change(message) { queued in
            guard let index = queued.videos?.firstIndex(where: { $0.id == video }) else { return }
            if let picked {
                queued.videos?[index].take(picked)
            } else {
                queued.videos?.remove(at: index)
                if queued.videos?.isEmpty == true { queued.videos = nil }
                queued.failed = "A video could not be read: add it again"
            }
        }
    }

    /// A message marked "Not sent" goes back in line.
    func retry(_ id: String) {
        items.first { $0.id == id }?.videos?.forEach { stalls[$0.id] = nil }
        change(id) { $0.failed = nil }
    }

    func tried(_ id: String, after mark: String) {
        change(id) { $0.triedAfter = mark }
    }

    /// The server took it and holds its reply until its videos are in: it stays for them, out of sight.
    func carry(_ id: String, reply: String) {
        change(id) { $0.reply = reply }
    }

    /// Its reply was stopped on the server: the message is the phone's again, to send anew.
    func detach(_ id: String) {
        change(id) { $0.reply = nil }
    }

    /// The server took it and its reply ended without its videos (he stopped it): they go up no more.
    func drop(_ id: String) {
        let videos = items.first { $0.id == id }?.videos ?? []
        remove(id)
        videos.forEach { $0.discard() }
    }

    /// Sends the oldest message that can still go: one per call, and never two at once. One that is not
    /// ready holds the line: nothing after it overtakes it.
    /// Answers what became of it; nil when nothing was tried.
    @discardableResult
    func drain(send: (QueuedMessage) async -> Outcome) async -> Outcome? {
        guard sending == nil, let next = items.first(where: { $0.failed == nil && $0.reply == nil }),
              Self.ready(next, serverWaits: serverWaits) else { return nil }
        sending = next.id
        let outcome = await send(next)
        sending = nil
        switch outcome {
        // one the server took before its videos were up stays for them
        case .sent: if items.first(where: { $0.id == next.id })?.reply == nil { remove(next.id) }
        case .later: break
        case .refused(let why): change(next.id) { $0.failed = why }
        }
        return outcome
    }

    // MARK: Videos going up

    /// Every waiting message's videos get the server's id first, in order (a quick call each), so a server
    /// that waits for them can take the message at once; then they go up one at a time, oldest message
    /// first. Nothing new when that is under way already. `moved` runs after each id given and each video
    /// up or failed: the first message in line may go now. No connection stops it until the next call.
    func upload(_ uploader: Uploader, moved: @escaping () -> Void) {
        self.uploader = uploader
        // the video going up was taken back, or its message's reply has ended: it stops, the next starts
        if let going, !holds(going) { stopUploading() }
        if beginning == nil, unbegun != nil {
            beginning = Task { [weak self] in
                while let self, !Task.isCancelled, let video = self.unbegun {
                    let result: Result<String, Error>
                    do { result = .success(try await uploader.begin(video)) } catch { result = .failure(error) }
                    if Task.isCancelled { return }
                    guard self.went(result, video, done: { self.begun(video.id, as: $0) }) else { break }
                    self.sendParts(uploader, moved: moved)
                    moved()
                }
                self?.beginning = nil
            }
        }
        sendParts(uploader, moved: moved)
    }

    /// Waits until nothing is going up (for a test).
    func settled() async {
        while beginning != nil || uploading != nil {
            await beginning?.value
            await uploading?.value
        }
    }

    private func sendParts(_ uploader: Uploader, moved: @escaping () -> Void) {
        guard uploading == nil, nextVideo != nil else { return }
        // leaving the app gives it a little longer, to see a video through. When iOS takes that back the
        // wait here stops (the parts iOS holds go on), and carries on when the app is open again.
        moment = UIApplication.shared.beginBackgroundTask { [weak self] in
            MainActor.assumeIsolated { self?.stopUploading() }
        }
        uploading = Task { [weak self] in
            while let self, !Task.isCancelled, let video = self.nextVideo {
                self.going = video.id
                let result: Result<String, Error>
                do {
                    result = .success(try await uploader.send(video, { [weak self] id in
                        self?.begun(video.id, as: id)
                    }, { [weak self] fraction in
                        Task { @MainActor in self?.advance(video.id, to: fraction) }
                    }))
                } catch {
                    result = .failure(error)
                }
                // taken back, or another account: whoever stopped it carries on
                if Task.isCancelled { return }
                guard self.went(result, video, done: { self.arrived(video, as: $0) }) else {
                    self.stopUploading()
                    return
                }
                moved()
            }
            self?.stopUploading()
        }
    }

    /// What one call for a video came to; false when it stops for want of a connection. A video that
    /// failed marks its message Not sent.
    private func went(_ result: Result<String, Error>, _ video: QueuedMessage.Video, done: (String) -> Void) -> Bool {
        switch result {
        case .success(let id):
            done(id)
        case .failure(let error) where AssistantUpload.waits(error) && !stalled(video.id, error):
            return false
        case .failure(let error):
            if let message = holder(of: video.id) {
                change(message) { $0.failed = error.localizedDescription }
            }
        }
        return true
    }

    /// The message that carries a video now: it may have been sent, or taken back, since its upload began.
    private func holder(of video: String) -> String? {
        items.first { $0.videos?.contains { $0.id == video } == true }?.id
    }

    /// The video is still wanted: a message carries it.
    private func holds(_ video: String) -> Bool {
        holder(of: video) != nil
    }

    /// The first video still to get the server's id: of the messages that can still go.
    /// One Photos is still handing over has to wait for that.
    private var unbegun: QueuedMessage.Video? {
        for message in items where message.failed == nil {
            if let video = message.videos?.first(where: { $0.file == nil && $0.pending != true }) { return video }
        }
        return nil
    }

    /// The first video with the server's id still to go up: of the oldest message that can still go.
    private var nextVideo: QueuedMessage.Video? {
        for message in items where message.failed == nil {
            if let video = message.videos?.first(where: { $0.file != nil }) { return video }
        }
        return nil
    }

    /// A server error, the video no further than at the last one: after a few in a row it counts as failed.
    /// No answer at all (no connection) never does.
    private func stalled(_ video: String, _ error: Error) -> Bool {
        guard ((error as? ToolsetAPI.Failure)?.status ?? 0) >= 500 else { return false }
        let now = reached[video] ?? 0
        let before = stalls[video]
        let count = now > (before?.reached ?? -1) ? 1 : (before?.count ?? 0) + 1
        stalls[video] = (now, count)
        return count >= Self.maxStalls
    }

    /// Whole percents only: the feed is drawn again on each.
    private func advance(_ video: String, to fraction: Double) {
        reached[video] = max(reached[video] ?? 0, fraction)
        let percent = (fraction * 100).rounded(.down) / 100
        if percent > progress[video] ?? -1 { progress[video] = percent }
    }

    /// The server gave the upload its id: kept on disk at once (for a message), so a later try carries on from there.
    private func begun(_ video: String, as file: String) {
        guard let message = holder(of: video) else { return }
        change(message) { queued in
            if let index = queued.videos?.firstIndex(where: { $0.id == video }) { queued.videos?[index].file = file }
        }
    }

    /// Up: the message names it by the server's id, and its copy on the phone goes. A message
    /// the server already took is done here once its last video is up.
    private func arrived(_ video: QueuedMessage.Video, as file: String) {
        progress[video.id] = nil
        reached[video.id] = nil
        stalls[video.id] = nil
        guard let message = holder(of: video.id) else { return }
        change(message) {
            $0.videos?.removeAll { $0.id == video.id }
            if $0.videos?.isEmpty == true { $0.videos = nil }
            $0.files.append(.init(id: file, name: video.name))
        }
        video.discard()
        if let done = items.first(where: { $0.id == message }), done.reply != nil, done.videos == nil { remove(message) }
    }

    private func stopUploading() {
        uploading?.cancel()
        uploading = nil
        going = nil
        progress = [:]
        if moment != .invalid {
            UIApplication.shared.endBackgroundTask(moment)
            moment = .invalid
        }
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
