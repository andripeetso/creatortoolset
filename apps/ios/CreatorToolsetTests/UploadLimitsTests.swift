import XCTest
@testable import CreatorToolset

/// A pick of many camera-roll clips holds at most `UploadEngine.copiesAtOnce` copies on the phone, and the saved queue
/// neither keeps every finished clip nor is rewritten at every chunk.
@MainActor
final class UploadLimitsTests: XCTestCase {
    /// Takes every request and never answers.
    private final class NeverAnswers: URLProtocol {
        override class func canInit(with request: URLRequest) -> Bool { true }
        override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
        override func startLoading() {}
        override func stopLoading() {}
    }

    private var folder: URL!
    private var transfers: Transfers!
    /// Refuses at once: a clip's step after its copy waits to be tried again, holding its copy.
    private let server = Server(url: URL(string: "http://127.0.0.1:9/")!, username: "sam")
    private var made: [UUID] = []

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("upload-limits-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [NeverAnswers.self]
        transfers = Transfers(configuration: config)
        Servers.shared.add(server, cookie: nil)
    }

    override func tearDown() async throws {
        Servers.shared.remove(server.id)
        transfers.session.invalidateAndCancel()
        for id in made {
            try? FileManager.default.removeItem(at: AppFiles.upload(id))
            AppFiles.removeSlices(of: id)
        }
        try? FileManager.default.removeItem(at: folder)
    }

    private var file: URL { folder.appendingPathComponent("uploads.json") }

    /// The queue as a run of the app finds it in `file`, copying a clip out of "Photos" as a small file. A copy is
    /// never made while three are held.
    private func engine() -> UploadEngine {
        let engine = UploadEngine(transfers: transfers, store: UploadStore(file: file))
        engine.copyOut = { [unowned self] _, to in
            XCTAssertLessThan(copies(), UploadEngine.copiesAtOnce, "a copy made while three are held")
            try Data("tinyacrobatics".utf8).write(to: to)
            return (14, "IMG_0001.MOV")
        }
        return engine
    }

    /// Camera-roll clips, their route decided already (so the step after the copy is this server's upload start).
    private func clips(_ n: Int, state: UploadItem.State = .picked) -> [UploadItem] {
        (0 ..< n).map {
            var clip = UploadItem(asset: "A/L0/\($0)", filename: "IMG_\($0).MOV", isVideo: true, capturedAt: nil, server: server.id,
                                  state: state)
            clip.route = .library
            made.append(clip.id)
            return clip
        }
    }

    private func hasCopy(_ id: UUID) -> Bool { FileManager.default.fileExists(atPath: AppFiles.upload(id).path) }
    private func copies() -> Int { made.filter(hasCopy).count }

    private func wait(_ what: String, _ done: () -> Bool) async throws {
        for _ in 0 ..< 250 where !done() { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(done(), what)
    }

    private func saved() throws -> [UploadItem] {
        UploadStore.disk.sync {}
        return try JSONDecoder().decode([UploadItem].self, from: Data(contentsOf: file))
    }

    func testTenPickedClipsHoldThreeCopiesAndTheRestWaitInPhotos() async throws {
        let engine = engine()
        let picked = clips(10)
        engine.store.add(picked)
        engine.uploadAll()
        await engine.reconcile()
        try await wait("three copies") { copies() == 3 }
        func waiting() -> [UploadItem] { picked.filter { !hasCopy($0.id) }.compactMap { engine.store.item($0.id) }.filter { $0.state == .preparing } }
        XCTAssertEqual(waiting().count, 7)
        XCTAssertTrue(waiting().allSatisfy { $0.assetId != nil }, "the rest are Photos references")

        // one lands: the next is copied
        let first = try XCTUnwrap(picked.first { hasCopy($0.id) }).id
        engine.landed(first, duplicate: false)
        try await wait("the next one copied") { copies() == 3 && waiting().count == 6 }
        XCTAssertEqual(engine.store.item(first)?.state, .done)

        // one fails for good: its copy goes, and the next is copied
        let second = try XCTUnwrap(picked.first { hasCopy($0.id) && $0.id != first }).id
        engine.fail(second, "The server refused it")
        try await wait("the next one copied after a failure") { copies() == 3 && waiting().count == 5 }
        XCTAssertEqual(engine.store.item(second)?.state, .failed)
    }

    func testARelaunchResumesTheClipsWaitingInPhotos() async throws {
        // what a run that stopped left: five clips on their way, none copied yet
        let waiting = clips(5, state: .preparing)
        try JSONEncoder().encode(waiting).write(to: file)

        let engine = engine()
        await engine.reconcile()
        try await wait("three copies after the relaunch") { copies() == 3 }
        let still = try saved().filter { !hasCopy($0.id) }
        XCTAssertEqual(still.count, 2)
        XCTAssertTrue(still.allSatisfy { $0.state == .preparing && $0.assetId != nil }, "still saved as references")
    }

    func testFinishedClipsLeaveTheSavedQueue() async throws {
        let now = Date()
        func done(_ age: TimeInterval, edit: UUID? = nil) -> UploadItem {
            var item = UploadItem(id: UUID(), filename: "a.mov", size: 10, server: server.id, state: .done)
            item.finishedAt = now.addingTimeInterval(-age)
            item.edit = edit
            return item
        }
        let recent = (0 ..< 35).map { done(Double($0)) }
        let old = done(2 * 86_400)
        let editClip = done(2 * 86_400, edit: UUID())
        let failed = UploadItem(id: UUID(), filename: "b.mov", size: 10, server: server.id, state: .failed)
        try JSONEncoder().encode(recent + [old, editClip, failed]).write(to: file)

        // on launch: the 30 newest of the last day stay for Activity, a New edit's clip and a failed one stay
        let engine = engine()
        let kept = Set(try saved().map(\.id))
        XCTAssertEqual(kept, Set(recent.prefix(30).map(\.id) + [editClip.id, failed.id]))

        // the last clip on its way lands: an older finished one goes, the one that landed stays
        let older = done(2 * 86_400)
        let sending = UploadItem(id: UUID(), filename: "c.mov", size: 10, server: server.id, state: .sending)
        engine.store.add([older, sending])
        engine.landed(sending.id, duplicate: false)
        let after = Set(try saved().map(\.id))
        XCTAssertFalse(after.contains(older.id))
        XCTAssertTrue(after.contains(sending.id))
    }

    func testChunkProgressIsWrittenAtMostOnceAWindow() async throws {
        let store = UploadStore(file: file)
        store.throttle = 0.3
        var item = UploadItem(id: UUID(), filename: "a.mov", size: 1000, server: "s", state: .sending)
        item.uploadId = "u1"
        store.add(item)
        let start = store.writes
        for n in 1 ... 50 {
            store.move(item.id, to: .sending) { $0.sent = Int64(n * 10) }
            store.update(item.id) {
                $0.attempts = 0
                $0.note = nil
            }
        }
        XCTAssertEqual(store.writes, start, "progress waits for the window")
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertEqual(store.writes, start + 1, "one write for the window")
        XCTAssertEqual(try saved().first?.sent, 500)

        // anything else is written at once
        store.update(item.id) { $0.uploadId = "u2" }
        XCTAssertEqual(store.writes, start + 2)
        store.move(item.id, to: .finishing)
        XCTAssertEqual(store.writes, start + 3)
        // progress held back is written as the app goes to the background
        store.update(item.id) { $0.sent = 1000 }
        store.flush()
        XCTAssertEqual(store.writes, start + 4)
        XCTAssertEqual(try saved().first?.sent, 1000)
    }
}
