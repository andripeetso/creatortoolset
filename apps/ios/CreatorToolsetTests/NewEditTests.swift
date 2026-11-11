import XCTest
@testable import CreatorToolset

/// New edit without a network: Start's order, and what the row says for each answer the server gives.
@MainActor
final class NewEditTests: XCTestCase {
    func testStartMakesTheUploadsThenTheEditThenSendsTheBytes() async throws {
        var calls: [String] = []
        try await PhoneEdits.run(prepare: { calls.append("uploads"); return ["u1", "u2"] },
                                 makeEdit: { calls.append("edit \($0)") },
                                 send: { calls.append("bytes") })
        XCTAssertEqual(calls, ["uploads", #"edit ["u1", "u2"]"#, "bytes"])
    }

    func testNoBytesWithoutTheEdit() async {
        var sent = false
        struct Refused: Error {}
        do {
            try await PhoneEdits.run(prepare: { ["u1"] }, makeEdit: { _ in throw Refused() }, send: { sent = true })
            XCTFail("Start went on")
        } catch {}
        XCTAssertFalse(sent)
    }

    // MARK: The row

    private let a = UUID(), b = UUID()
    private var edit: PhoneEdit { PhoneEdit(id: UUID(), server: "s", name: "Phone edit", clips: [a, b], editId: "e1") }

    private func clip(_ id: UUID, _ state: UploadItem.State, upload: String) -> UploadItem {
        var item = UploadItem(id: id, filename: "\(upload).mp4", size: 10, server: "s")
        item.state = state
        item.uploadId = upload
        return item
    }

    private func remote(_ json: String) throws -> RemoteEdit {
        try JSONDecoder().decode(RemoteEdit.self, from: Data(json.utf8))
    }

    // GET /api/editor/:id from a scratch server: made from two uploads, before their bytes (trimmed)
    private let waiting = #"""
    {"id":"3a430223-7401-4ec2-bb1b-569b21a77911","createdBy":"admin","sources":[],
     "uploads":[{"id":"02f1a32d-7dee-48ba-8e83-5135df904a15"},{"id":"499e909b-95ea-4e91-908e-aa07f6897608"}],
     "name":"Phone edit","versions":1,"last":null,"jobs":[],"drafts":[],"previews":{},"flagDefs":[]}
    """#
    // the same edit once both were in (trimmed)
    private let started = #"""
    {"id":"3a430223-7401-4ec2-bb1b-569b21a77911","sources":["46ca0468-2e49-4a27-8666-c05e3b585941","bfac3cb9-393f-432e-aced-8a95409d1895"],
     "jobs":[{"id":1,"kind":"analyze","variant":"","state":"queued","attempts":0,"error":null}],"previews":{}}
    """#

    func testUploading() throws {
        let clips = [a: clip(a, .done, upload: "02f1a32d-7dee-48ba-8e83-5135df904a15"),
                     b: clip(b, .sending, upload: "499e909b-95ea-4e91-908e-aa07f6897608")]
        XCTAssertEqual(EditState.of(edit, clips: clips, remote: nil, starting: false), .uploading(done: 1, of: 2))
        XCTAssertEqual(EditState.of(edit, clips: clips, remote: try remote(waiting), starting: false), .uploading(done: 1, of: 2))
        XCTAssertEqual(EditState.of(edit, clips: clips, remote: nil, starting: true), .starting)
    }

    func testAFailedClipIsFailedOnlyWhenTheServerHasNotGotIt() throws {
        let clips = [a: clip(a, .done, upload: "02f1a32d-7dee-48ba-8e83-5135df904a15"),
                     b: clip(b, .failed, upload: "499e909b-95ea-4e91-908e-aa07f6897608")]
        // before the server answers, nothing is said
        XCTAssertEqual(EditState.of(edit, clips: clips, remote: nil, starting: false), .uploading(done: 1, of: 2))
        XCTAssertEqual(EditState.of(edit, clips: clips, remote: try remote(waiting), starting: false), .failed("A clip didn't upload"))
        // the finish's answer was lost ("Already finished"): the server has the clip
        let landed = try remote(#"{"sources":[],"uploads":[{"id":"02f1a32d-7dee-48ba-8e83-5135df904a15","version":"v1"},{"id":"499e909b-95ea-4e91-908e-aa07f6897608","version":"v2"}]}"#)
        XCTAssertEqual(EditState.of(edit, clips: clips, remote: landed, starting: false), .uploading(done: 2, of: 2))
        // its copy is gone from the phone and the server never got it
        XCTAssertEqual(EditState.of(edit, clips: [a: clips[a]!], remote: try remote(waiting), starting: false), .failed("A clip didn't upload"))
    }

    func testStartStoppedBeforeTheEdit() {
        var stopped = edit
        stopped.editId = nil
        stopped.problem = "The server answered 503"
        XCTAssertEqual(EditState.of(stopped, clips: [:], remote: nil, starting: false), .failed("The server answered 503"))
    }

    func testEditingThenReady() throws {
        XCTAssertEqual(EditState.of(edit, clips: [:], remote: try remote(started), starting: false), .editing)
        // the copies are cleared once it started: before the server's answer it still reads Editing
        XCTAssertEqual(EditState.of(edit, clips: [:], remote: nil, starting: false), .editing)
        let failed = try remote(#"{"sources":["v1"],"jobs":[{"id":1,"kind":"analyze","variant":"","state":"needs_key","attempts":1,"error":"Add a transcription key"}],"previews":{}}"#)
        XCTAssertEqual(EditState.of(edit, clips: [:], remote: failed, starting: false), .stuck("Add a transcription key"))
        // previews as contracts/editor.ts has them (ReviewPreview), by version name
        let ready = try remote(#"{"sources":["v1"],"jobs":[],"previews":{"v2":{"assetId":"x2","n":1},"v1":{"assetId":"x1","n":3}}}"#)
        XCTAssertEqual(EditState.of(edit, clips: [:], remote: ready, starting: false), .ready(path: "/review/x1?v=3"))
    }

    /// Saved uploads from before New edit still load (the new field is optional).
    func testOldSavedUploadsStillLoad() throws {
        let saved = #"[{"id":"\#(a.uuidString)","filename":"a.mp4","size":10,"server":"s","state":"done","sent":10,"duplicate":false,"attempts":0}]"#
        let items = try JSONDecoder().decode([UploadItem].self, from: Data(saved.utf8))
        XCTAssertNil(items.first?.edit)
    }
}
