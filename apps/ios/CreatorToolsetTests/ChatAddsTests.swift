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

    func testAVideoIsStampedWithItsRoadOnceAndKeepsIt() {
        let stamped = AssistantUpload.stamped([video("New.mov"), video("Begun.mov", file: "f1")], api: nil, add: true)
        XCTAssertEqual(stamped?.map(\.add), [true, nil]) // one that began as the chat's own upload stays that
        let back = AssistantUpload.stamped([video("Add.mov", file: "u1", add: true)], api: nil, add: false)
        XCTAssertEqual(back?.map(\.add), [true]) // taken back and sent again: its upload goes on
        XCTAssertEqual(AssistantUpload.stamped([video("Own.mov")], api: nil)?.map(\.add), [nil])
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
