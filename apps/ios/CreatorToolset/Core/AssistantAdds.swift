import Foundation

/// A file sent with a chat message is a Media Library add: it goes up the Upload tab's own road (`UploadEngine`,
/// `POST /api/library/here/uploads` in the chat's workspace), so it is held and blurred where the library blurs faces,
/// is not added again when the library has it, and keeps going with the phone locked or the app closed. The message
/// names the upload's id (`uploads`), and the server keeps its reply until every file is ready.
@MainActor
enum AssistantAdd {
    /// The file becomes one of the Upload tab's uploads (its copy is the upload's from here on) and starts. Answers
    /// the server's id for it, once it has one: with no connection that is when the connection is back.
    static func begin(_ video: QueuedMessage.Video) async throws -> String {
        let engine = UploadEngine.shared
        guard let id = UUID(uuidString: video.id) else { throw AssistantUpload.Unreadable(name: video.name) }
        if engine.store.item(id) == nil {
            let api = try AssistantUpload.api(for: video)
            let copy = video.url
            guard let server = Servers.shared.list.first(where: { $0.id == api.key }),
                  let size = (try? FileManager.default.attributesOfItem(atPath: copy.path))?[.size] as? NSNumber,
                  size.int64Value > 0 else { throw AssistantUpload.Unreadable(name: video.name) }
            try? FileManager.default.removeItem(at: AppFiles.upload(id))
            try FileManager.default.moveItem(at: copy, to: AppFiles.upload(id))
            queue(id, name: video.name, size: size.int64Value, server: server, workspace: video.workspace)
        }
        // one that failed starts over as a new upload: its message is told the new id
        if engine.store.item(id)?.state == .failed { await engine.restart([id]) }
        if engine.store.item(id)?.state == .picked { engine.retry(id) }
        return try await wait(for: id, name: video.name) { $0.uploadId }
    }

    /// Waits until the upload is in the library; `progress` 0…1 as its bytes go. One the queue no longer lists has
    /// landed and was cleared (the server says what became of it).
    static func send(_ video: QueuedMessage.Video, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        guard let id = UUID(uuidString: video.id), let file = video.file else { throw AssistantUpload.Unreadable(name: video.name) }
        let store = UploadEngine.shared.store
        guard store.item(id) != nil else { return file }
        return try await wait(for: id, name: video.name) { item in
            // sent again under another id (Try again in Activity, or the server dropped it): its message names the old one
            guard item.uploadId == file else { throw ToolsetAPI.Failure(status: 409, message: "\(video.name) started over") }
            if item.size > 0 { progress(Double(min(store.sentBytes(item), item.size)) / Double(item.size)) }
            return item.state == .done ? file : nil
        }
    }

    /// A photo sent with a message, as it was picked: into the Media Library of the chat's workspace, like a file
    /// picked on the Upload tab. The reply reads its JPEG and does not wait for this.
    static func photo(_ picture: QueuedMessage.Picture, api: ToolsetAPI?) {
        guard let copy = picture.copy else { return }
        let folder = AssistantPickedVideo.folder.appendingPathComponent(copy, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        guard let api, let server = Servers.shared.list.first(where: { $0.id == api.key }),
              let file = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil))?.first,
              let size = (try? FileManager.default.attributesOfItem(atPath: file.path))?[.size] as? NSNumber, size.int64Value > 0 else { return }
        let id = UUID()
        guard (try? FileManager.default.moveItem(at: file, to: AppFiles.upload(id))) != nil else { return }
        queue(id, name: file.lastPathComponent, size: size.int64Value, server: server, workspace: api.workspace)
        UploadEngine.shared.retry(id)
    }

    /// Its file is not wanted any more: an upload that is not in yet stops and leaves the queue.
    static func cancel(_ video: QueuedMessage.Video) {
        guard let id = UUID(uuidString: video.id), let item = UploadEngine.shared.store.item(id), !item.isFinished else { return }
        UploadEngine.shared.remove(id)
    }

    /// An upload of the Upload tab's, to the own library of the chat's workspace (the road was asked before: `AssistantModel.adds`).
    private static func queue(_ id: UUID, name: String, size: Int64, server: Server, workspace: String?) {
        let engine = UploadEngine.shared
        engine.add(id: id, filename: name, size: size, server: server)
        engine.store.update(id) {
            $0.workspace = workspace
            $0.route = .library
        }
    }

    /// Waits for what the upload has to tell (`done` answers once it does). A failed upload, or one taken off the
    /// queue, throws; with no connection it waits, as the upload does.
    private static func wait<T>(for id: UUID, name: String, _ done: (UploadItem) throws -> T?) async throws -> T {
        while true {
            try Task.checkCancellation()
            guard let item = UploadEngine.shared.store.item(id) else {
                throw ToolsetAPI.Failure(status: 410, message: "\(name) was taken off the uploads: add it again")
            }
            if let value = try done(item) { return value }
            if item.state == .failed { throw ToolsetAPI.Failure(status: 400, message: item.note ?? "Could not upload \(name)") }
            // shortcut: the queue is asked twice a second; follow its changes if a chat ever sends hundreds of files
            try await Task.sleep(for: .milliseconds(500))
        }
    }
}
