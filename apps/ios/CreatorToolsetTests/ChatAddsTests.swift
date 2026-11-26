import XCTest
@testable import CreatorToolset

/// A file sent with a chat message is a Media Library add (`AssistantAdd`): it goes up the Upload tab's road, the
/// message names its upload, and each file says where it is, as the library's intake has it.
@MainActor
final class ChatAddsTests: XCTestCase {
    private func video(_ name: String, file: String? = nil, add: Bool? = nil) -> QueuedMessage.Video {
        .init(name: name, copy: "copy-\(name)", file: file, add: add)
    }

    // MARK: The message

    func testAMessagesAddsGoAsUploadsAndItsReplyIsNotStartedEarly() {
        let message = QueuedMessage(
            text: "Edit a short video of these",
            files: [.init(id: "u1", name: "Pier.mov", add: true), .init(id: "f1", name: "Old.mov")],
            videos: [video("Beach.mov", file: "u2", add: true)])
        let body = AssistantModel.body(message, timezone: "UTC")
        XCTAssertEqual(body["uploads"] as? [String], ["u1", "u2"])
        XCTAssertEqual(body["files"] as? [String], ["f1"])
        // `later` starts the reply before its videos are in: never for a file the reply has to wait for
        XCTAssertNil(body["later"])

        let own = AssistantModel.body(QueuedMessage(text: "Caption this", videos: [video("Clip.mov", file: "f2")]), timezone: "UTC")
        XCTAssertEqual(own["files"] as? [String], ["f2"])
        XCTAssertNil(own["uploads"])
        XCTAssertEqual(own["later"] as? Bool, true)
    }

    func testAVideoHasNoRoadAtSendAndOneThatBeganKeepsItsOwn() {
        let stamped = AssistantUpload.stamped([video("New.mov"), video("Begun.mov", file: "f1"), video("Add.mov", file: "u1", add: true)], api: nil)
        // one that began keeps its road (the chat's own upload, an add taken back and sent again)
        XCTAssertEqual(stamped?.map(\.add), [nil, nil, true])
        // taken back before its upload began and sent again, maybe in another workspace: asked again
        XCTAssertEqual(AssistantUpload.stamped([video("Back.mov", add: false)], api: nil)?.map(\.add), [nil])
    }

    // MARK: The road is asked when the upload begins

    /// A server as the model sees it: `online` says whether it answers, `adds` whether it takes Media Library adds.
    /// `began` hears each video as its upload begins.
    private func server(adds: Bool = true, online: @escaping @MainActor () -> Bool = { true },
                        began: @escaping @MainActor (QueuedMessage.Video) -> Void) -> AssistantServer {
        AssistantServer(queue: nil, call: { @MainActor _, _, _ in
            guard online() else { throw ToolsetAPI.Failure.offline }
            return Data(#"{"id":"c1","provider":"claude","sendNow":true,"adds":\#(adds),"messages":[]}"#.utf8)
        }, uploader: .init(begin: { @MainActor video in
            began(video)
            return "u-" + video.name
        }, send: { video, _, _ in video.file ?? "" }))
    }

    private func until(_ what: String, _ done: () -> Bool) async {
        for _ in 0..<500 where !done() { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(done(), what)
    }

    func testAFileSentBeforeTheServerAnsweredWaitsForItsRoad() async {
        // written with no connection right after the app opened: nothing is known of the server yet
        var online = false
        var began: [Bool?] = []
        let model = AssistantModel()
        model.ownLibrary = { _ in true }
        model.server = { self.server(online: { online }) { began.append($0.add) } }
        await model.load()
        model.send(QueuedMessage(text: "Edit this", videos: [video("Beach.mov")]))
        await model.outbox.settled()
        // nothing of it goes up on the chat's own road meanwhile: it waits, as any queued message does, and says so
        XCTAssertTrue(began.isEmpty)
        XCTAssertTrue(model.offline)
        XCTAssertEqual(model.outbox.shown.map(\.failed), [nil])
        XCTAssertEqual(model.outbox.items.first?.videos?.map(\.add), [nil])
        // the connection is back: the server takes adds and the workspace's uploads go to its own library
        online = true
        await model.load()
        await until("it began as a Media Library add") { began == [true] }
    }

    func testAnOlderServerAndAPlugInsLibraryAreAnswersAndTakeTheChatsOwnRoad() async {
        var began: [Bool?] = []
        var asked = 0
        // an older server takes no adds: the workspace is not even asked about
        let older = AssistantModel()
        older.ownLibrary = { _ in
            asked += 1
            return true
        }
        older.server = { self.server(adds: false) { began.append($0.add) } }
        await older.load()
        older.send(QueuedMessage(text: "Caption this", videos: [video("Clip.mov")]))
        await until("it began as the chat's own upload") { began == [false] }
        XCTAssertEqual(asked, 0)
        // a workspace whose uploads go to a plug-in's library
        let plugin = AssistantModel()
        plugin.ownLibrary = { _ in false }
        plugin.server = { self.server { began.append($0.add) } }
        await plugin.load()
        plugin.send(QueuedMessage(text: "Caption this", videos: [video("Other.mov")]))
        await until("it began as the chat's own upload") { began == [false, false] }
    }

    func testAFileNeverWaitsForEverForItsRoad() async {
        var began = 0
        // a refusal that says nothing of the road (signed out): Not sent, with the reason and Try again
        let refused = AssistantModel()
        refused.ownLibrary = { _ in throw ToolsetAPI.Failure.signedOut }
        refused.server = { self.server { _ in began += 1 } }
        await refused.load()
        refused.send(QueuedMessage(text: "Edit this", videos: [video("Beach.mov")]))
        await until("it is marked Not sent") { refused.outbox.items.first?.failed != nil }
        XCTAssertEqual(refused.outbox.items.first?.failed, ToolsetAPI.Failure.signedOut.message)
        // a server that keeps failing the question: asked again a few times, then Not sent
        let failing = AssistantModel()
        failing.ownLibrary = { _ in throw ToolsetAPI.Failure(status: 503, message: "The server is restarting") }
        failing.server = { self.server { _ in began += 1 } }
        await failing.load()
        failing.send(QueuedMessage(text: "Edit this", videos: [video("Pier.mov")]))
        await failing.outbox.settled()
        XCTAssertEqual(failing.outbox.shown.map(\.failed), [nil])
        for _ in 1..<AssistantOutbox.maxStalls {
            await failing.load()
            await failing.outbox.settled()
        }
        XCTAssertEqual(failing.outbox.items.first?.failed, "The server is restarting")
        XCTAssertEqual(began, 0)
    }

    // MARK: A file taken off the uploads

    func testAFileTakenOffTheUploadsIsNotTakenForOneThatLanded() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("chat-adds-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let transfers = Transfers(configuration: .ephemeral)
        defer {
            transfers.session.invalidateAndCancel()
            try? FileManager.default.removeItem(at: folder)
        }
        let engine = UploadEngine(transfers: transfers, store: UploadStore(file: folder.appendingPathComponent("uploads.json")))
        func add(_ id: UUID, upload: String) -> QueuedMessage.Video {
            .init(id: id.uuidString, name: "Beach.mov", copy: "copy", file: upload, add: true)
        }
        /// In the queue in `state`, then removed as Activity removes it.
        func removed(_ state: UploadItem.State, upload: String) async throws -> UUID {
            var item = UploadItem(id: UUID(), filename: "Beach.mov", size: 200, server: "s", state: state)
            item.uploadId = upload
            engine.store.add(item)
            engine.remove(item.id)
            for _ in 0..<500 where engine.store.item(item.id) != nil { try await Task.sleep(for: .milliseconds(10)) }
            return item.id
        }
        // one that landed is cleared from the queue: the message names it, and the server says what became of it
        let cleared = try await AssistantAdd.send(add(UUID(), upload: "u1"), engine: engine) { _ in }
        XCTAssertEqual(cleared, "u1")
        // Stop and remove in Activity, on a file the chat is not waiting on yet: it never landed
        let stopped = try await removed(.sending, upload: "u2")
        do {
            _ = try await AssistantAdd.send(add(stopped, upload: "u2"), engine: engine) { _ in }
            XCTFail("a file taken off the uploads counted as landed")
        } catch let failure as ToolsetAPI.Failure {
            XCTAssertEqual(failure.status, 410)
            XCTAssertEqual(failure.message, "Beach.mov was taken off the uploads: add it again")
        }
        // it is still known after the app closed
        XCTAssertTrue(UploadEngine(transfers: transfers, store: engine.store).removed.contains(stopped.uuidString))
        // one removed from Recently uploaded did land
        let landed = try await removed(.done, upload: "u3")
        let named = try await AssistantAdd.send(add(landed, upload: "u3"), engine: engine) { _ in }
        XCTAssertEqual(named, "u3")
    }

    func testTryAgainAsksForAnAddsUploadAgain() {
        let outbox = AssistantOutbox()
        var message = QueuedMessage(text: "Edit these", videos: [video("Add.mov", file: "u1", add: true), video("Own.mov", file: "f1")])
        message.failed = "Add.mov started over"
        outbox.add(message)
        outbox.retry(message.id)
        // the add's upload may have a new id by now: it is asked for again; the chat's own upload carries on from its parts
        XCTAssertEqual(outbox.items.first?.videos?.map(\.file), [nil, "f1"])
        XCTAssertNil(outbox.items.first?.failed)
    }

    func testAnAddsCopyIsNeverTheFolderOfAllUploads() throws {
        // its copy is the upload's once that began: taking it off must not reach for that file's folder
        let id = UUID()
        try Data("clip".utf8).write(to: AppFiles.upload(id))
        defer { try? FileManager.default.removeItem(at: AppFiles.upload(id)) }
        let add = QueuedMessage.Video(id: id.uuidString, name: "Add.mov", copy: "copy-\(id.uuidString)", add: true)
        XCTAssertEqual(add.url, AppFiles.upload(id))
        XCTAssertTrue(add.readable)
        add.discard()
        XCTAssertTrue(FileManager.default.fileExists(atPath: AppFiles.upload(id).path))
    }

    // MARK: What the server sends

    func testTheServersAddsAndAFailedFileRead() throws {
        let json = #"""
        {"id":"c1","provider":"claude","aiName":"Claude Code","sendNow":true,"videosLater":true,"adds":true,"messages":[
          {"id":"m1","role":"user","text":"Edit these","at":1,"adds":[{"id":"u1","name":"Pier.mov","libraryId":"lib_a","assetId":"a1"},{"id":"u2","name":"Beach.mov","libraryId":"lib_a"}]},
          {"id":"m2","role":"assistant","text":"","at":2,"status":"thinking","wait":{"for":"files","text":"Could not blur \"Pier.mov\": The video could not be read","failed":{"part":"blur","libraryId":"lib_a","assetId":"a1","versionId":"v1"}}}
        ],"past":[]}
        """#
        let view = try JSONDecoder().decode(AssistantView.self, from: Data(json.utf8))
        XCTAssertTrue(view.adds)
        XCTAssertEqual(view.messages[0].adds?.map(\.assetId), ["a1", nil])
        XCTAssertEqual(view.messages[1].wait?.failed, .init(part: "blur", libraryId: "lib_a", assetId: "a1", versionId: "v1"))
        // an older server says nothing of it: the files go up as the chat's own
        XCTAssertFalse(try JSONDecoder().decode(AssistantView.self, from: Data(#"{"id":"c1","provider":"claude","messages":[]}"#.utf8)).adds)
    }

    // MARK: Where a file is

    private func intake(_ json: String) throws -> Intake {
        try JSONDecoder().decode(Intake.self, from: Data(json.utf8))
    }

    func testEachStepOfTheIntakeHasItsLineAndAReadyFileHasNone() throws {
        XCTAssertEqual(try intake(#"{"assetId":"a","versionId":"v","step":"held","waiting":true}"#).line, "Waiting for the main computer")
        XCTAssertEqual(try intake(#"{"assetId":"a","versionId":"v","step":"held"}"#).line, "Copying to the main computer")
        XCTAssertEqual(try intake(#"{"assetId":"a","versionId":"v","step":"computer","waiting":true}"#).line, "Waiting to blur")
        XCTAssertEqual(try intake(#"{"assetId":"a","versionId":"v","step":"blurring"}"#).line, "Blurring")
        XCTAssertEqual(try intake(#"{"assetId":"a","versionId":"v","step":"failed","failed":"blur","error":"x"}"#).line, "Could not blur")
        XCTAssertEqual(try intake(#"{"assetId":"a","versionId":"v","step":"failed","failed":"copy","error":"x"}"#).line, "Could not copy to the main computer")
        XCTAssertNil(try intake(#"{"assetId":"a","versionId":"v","step":"done","result":"blurred"}"#).line)
    }

    func testAChatFileSaysUploadingThenWhatTheIntakeSays() throws {
        let up = AssistantMessage.Add(id: "u1", name: "Pier.mov", libraryId: "lib_a", assetId: nil)
        XCTAssertEqual(AssistantAddChip.line(up, step: nil, upload: nil, sent: { _ in 0 }), "Uploading") // sent from another phone
        let item = UploadItem(id: UUID(), filename: "Pier.mov", size: 200, server: "s", state: .sending)
        XCTAssertEqual(AssistantAddChip.line(up, step: nil, upload: item, sent: { _ in 80 }), "Uploading · 40%")
        let landed = AssistantMessage.Add(id: "u1", name: "Pier.mov", libraryId: "lib_a", assetId: "a1")
        XCTAssertEqual(AssistantAddChip.line(landed, step: try intake(#"{"assetId":"a1","versionId":"v","step":"blurring"}"#), upload: nil, sent: { _ in 0 }), "Blurring")
        XCTAssertNil(AssistantAddChip.line(landed, step: try intake(#"{"assetId":"a1","versionId":"v","step":"done"}"#), upload: nil, sent: { _ in 0 }))
    }

    func testTheUploadTabsFileSaysTheSameUntilItIsReady() throws {
        var item = UploadItem(id: UUID(), filename: "Pier.mov", size: 200, server: "s", state: .done)
        item.intake = Intake.Held(finish: Data(#"{"assetId":"a1","versionId":"v1","held":true,"libraryId":"lib_a"}"#.utf8))
        XCTAssertEqual(item.intake, try XCTUnwrap(Intake.Held(finish: Data(#"{"held":true,"libraryId":"lib_a","assetId":"a1"}"#.utf8))))
        XCTAssertEqual(ActivityView.status(item, sent: 200, intake: try intake(#"{"assetId":"a1","versionId":"v1","step":"held","waiting":true}"#)), "Waiting for the main computer")
        XCTAssertEqual(ActivityView.status(item, sent: 200, intake: try intake(#"{"assetId":"a1","versionId":"v1","step":"done"}"#)), "Uploaded")
        // a file the server does not hold has no intake to ask
        XCTAssertNil(Intake.Held(finish: Data(#"{"assetId":"a1","versionId":"v1"}"#.utf8)))
        XCTAssertNil(Intake.Held(finish: Data(#"{"duplicateOf":"a1"}"#.utf8)))
    }

    func testTheIntakeIsReadFromItsRouteUntilAFileIsReady() async throws {
        let watch = IntakeWatch()
        var asked: [[String]] = []
        var step = "held"
        watch.ask = { _, library, assets in
            XCTAssertEqual(library, "lib_a")
            asked.append(assets)
            // a2 is not in the library any more: the route leaves it out
            return [Intake(assetId: "a1", versionId: "v1", step: step, waiting: nil, failed: nil, error: nil)]
        }
        let api = API(server: URL(string: "https://intake.example.test/")!, cookie: nil)
        watch.watch(["a1", "a2"], library: "lib_a", api: api)
        await watch.read()
        XCTAssertEqual(watch.steps["a1"]?.line, "Copying to the main computer")
        XCTAssertNil(watch.steps["a2"])
        step = "done"
        await watch.read()
        XCTAssertNil(watch.steps["a1"]?.line)
        let before = asked.count
        await watch.read() // nothing is on its way: nothing is asked
        XCTAssertEqual(asked.count, before)
        XCTAssertEqual(asked.last, ["a1"])
    }

    func testTheIntakeIsAskedLessOftenWhileNothingChangesAndNotAtAllOnceNothingIsOnItsWay() async {
        let watch = IntakeWatch()
        let api = API(server: URL(string: "https://intake.example.test/")!, cookie: nil)
        var steps = ["held", "held", "held", "held", "held", "held", "blurring", "failed", "blurring", "done"]
        var asked = 0
        var waits: [Double] = []
        watch.pause = { waits.append($0) }
        watch.ask = { _, _, _ in
            asked += 1
            return [Intake(assetId: "a1", versionId: "v1", step: steps.removeFirst(), waiting: nil, failed: nil, error: nil)]
        }
        watch.watch(["a1"], library: "lib_a", api: api)
        await watch.settled()
        // 5 seconds after a read that changed something, twice as long after each that changed nothing, a minute at most
        XCTAssertEqual(waits, [5, 10, 20, 40, 60, 60, 5])
        // it failed: not on its way, so nothing asks about it, however long the screen stays
        XCTAssertEqual(watch.steps["a1"]?.line, "Could not blur")
        await watch.read()
        XCTAssertEqual(asked, 8)
        // Retry: read now, at the shortest wait again, until it is ready
        watch.watch(["a1"], library: "lib_a", api: api)
        await watch.settled()
        XCTAssertEqual(waits.suffix(1), [5])
        XCTAssertEqual(asked, 10)
        XCTAssertNil(watch.steps["a1"]?.line)

        // no connection: asked again, later each time; a library the server refuses to read (deleted, signed out): never again
        var answers: [APIError] = [.offline, .offline, .server(404, "Not found")]
        waits = []
        watch.ask = { _, _, _ in
            asked += 1
            throw answers.removeFirst()
        }
        watch.watch(["b1"], library: "lib_b", api: api)
        await watch.settled()
        XCTAssertEqual(waits, [10, 20])
        await watch.read()
        XCTAssertEqual(asked, 13)
    }

    // MARK: A file to blur goes up as it is

    func testThePhoneNeverSendsItsOwn720pCopyOfAFileToBlur() throws {
        func library(_ json: String) throws -> UploadEngine.Libraries.Library {
            try JSONDecoder().decode(UploadEngine.Libraries.Library.self, from: Data(json.utf8))
        }
        let proxies = try library(#"{"id":"l","settings":{"upload":"proxies"}}"#)
        let blurs = try library(#"{"id":"l","settings":{"upload":"proxies","blurFaces":true},"mayKeepAsFilmed":true}"#)
        let member = try library(#"{"id":"l","settings":{"upload":"proxies","blurFaces":true},"mayKeepAsFilmed":false}"#)
        XCTAssertTrue(UploadEngine.sendsCopy(to: proxies, blur: nil))
        // the main computer needs the original to blur it
        XCTAssertFalse(UploadEngine.sendsCopy(to: blurs, blur: nil))
        // Blur faces turned off for it by the owner: it is kept as filmed, and a lighter copy may go
        XCTAssertTrue(UploadEngine.sendsCopy(to: blurs, blur: false))
        // a member's off is ignored by the server: the file is still to blur
        XCTAssertFalse(UploadEngine.sendsCopy(to: member, blur: false))
        XCTAssertFalse(UploadEngine.sendsCopy(to: try library(#"{"id":"l","settings":{"upload":"all","blurFaces":true}}"#), blur: nil))
        XCTAssertFalse(UploadEngine.sendsCopy(to: nil, blur: nil))
    }

    // MARK: A photo

    func testAPickedPhotoKeepsItsOriginalUntilSend() throws {
        let copy = try XCTUnwrap(AssistantDraft.keep(Data("heic".utf8), ext: "heic", n: 2, now: Date(timeIntervalSince1970: 0)))
        let folder = AssistantPickedVideo.folder.appendingPathComponent(copy, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let files = try FileManager.default.contentsOfDirectory(atPath: folder.path)
        XCTAssertEqual(files.count, 1)
        XCTAssertTrue(files[0].hasPrefix("Photo "))
        XCTAssertTrue(files[0].hasSuffix(" 2.heic"))
        // with no server to send it to, its copy goes and nothing is queued
        AssistantAdd.photo(.init(name: "Photo 1.jpg", jpeg: Data(), copy: copy), api: nil)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }
}
