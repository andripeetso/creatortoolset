import XCTest
@testable import CreatorToolset

/// The studio's way to send: every answer of the catalog (through the plug-in's proxy) and of the video edge, what the
/// phone does next, when it sends there at all, and the Media Library side's list and cache.
final class CatalogRulesTests: XCTestCase {
    private let size: Int64 = 100

    private func after(_ kind: TransferStep.Kind, _ status: Int, offset: Int64? = nil, body: [String: Any]? = nil,
                       network: Bool = false) -> CatalogNext {
        let data = body.flatMap { try? JSONSerialization.data(withJSONObject: $0) } ?? Data()
        return CatalogRules.after(kind, status: status, uploadOffset: offset, size: size, body: data, networkError: network)
    }

    func testRelayPatchContinuesFromTheEdgesCountThenCompletes() {
        XCTAssertEqual(after(.relayPatch, 204, offset: 40), .send(from: 40))
        XCTAssertEqual(after(.relayPatch, 204, offset: 100), .complete)
        XCTAssertEqual(after(.relayPatch, 204), .resync)
        XCTAssertEqual(after(.relayPatch, 409), .resync)
    }

    func testRelayProblemsNeverDropTheClip() {
        XCTAssertEqual(after(.relayPatch, 0, network: true), .retryLater("The connection dropped"))
        XCTAssertEqual(after(.relayPatch, 503), .retryLater("The server had a hiccup (HTTP 503)"))
        XCTAssertEqual(after(.relayPatch, 401), .newSession("The upload link expired"))
        XCTAssertEqual(after(.relayPatch, 400), .sendDirectly("The fast route refused it (HTTP 400)"))
        XCTAssertEqual(after(.relayComplete, 200), .confirm)
        XCTAssertEqual(after(.relayComplete, 404), .sendDirectly("The library couldn't take it from the fast route"))
        XCTAssertEqual(after(.relayComplete, 409), .retryLater("The server had a hiccup (HTTP 409)"))
        XCTAssertEqual(after(.relayComplete, 401), .signedOut)
    }

    func testDirectUploadResumesFromTheServersCount() {
        XCTAssertEqual(after(.catalogPatch, 204, offset: 32), .send(from: 32))
        XCTAssertEqual(after(.catalogPatch, 204, offset: 100), .complete)
        XCTAssertEqual(after(.catalogPatch, 409, offset: 64), .send(from: 64))
        XCTAssertEqual(after(.catalogPatch, 409), .resync)
        XCTAssertEqual(after(.catalogPatch, 413), .newSession("The server refused a piece (HTTP 413)"))
        XCTAssertEqual(after(.catalogPatch, 401), .signedOut)
        XCTAssertEqual(after(.catalogPatch, 403, body: ["error": "your role is read-only"]), .failed("your role is read-only"))
    }

    func testDirectCompleteReportsTheServersFingerprint() {
        XCTAssertEqual(after(.catalogComplete, 200, body: ["sha256": "abc", "duplicate_of": NSNull()]), .finished(sha256: "abc", duplicate: false))
        XCTAssertEqual(after(.catalogComplete, 200, body: ["sha256": "abc", "duplicate_of": 12]), .finished(sha256: "abc", duplicate: true))
        XCTAssertEqual(after(.catalogComplete, 409), .resync)
        XCTAssertEqual(after(.catalogComplete, 404), .newSession("The server lost the upload"))
        XCTAssertEqual(after(.catalogComplete, 400, body: ["error": "unsupported file type: .dng"]), .failed("unsupported file type: .dng"))
    }

    /// While the studio restarts, the library can't check the sign-in: a wait, never a refusal, on every step.
    func testTheLibraryRestartingIsAWait() {
        let body: [String: Any] = ["error": "The studio can't be reached", "code": "toolset_unreachable"]
        for kind: TransferStep.Kind in [.relayComplete, .catalogPatch, .catalogComplete] {
            XCTAssertEqual(after(kind, 403, body: body), .retryLater("The library is restarting"))
        }
        // a 403 for another reason is still the answer it was
        XCTAssertEqual(after(.catalogPatch, 403, body: ["error": "no", "code": "toolset_forbidden"]), .failed("no"))
        XCTAssertTrue(CatalogRules.restarting(403, body))
        XCTAssertFalse(CatalogRules.restarting(503, body))
    }

    @MainActor
    func testRequestErrorsSayWhatToDo() async {
        let catalog = CatalogAPI(api: API(server: URL(string: "http://127.0.0.1:1")!, cookie: "c"))
        let restarting = await catalog.failure(403, ["error": "x", "code": "toolset_unreachable"])
        XCTAssertTrue(restarting.transient)
        let off = await catalog.failure(404, ["error": "Not found"])
        XCTAssertEqual(off.message, "The Media Library isn't on for this account")
        XCTAssertFalse(off.transient)
        let signedOut = await catalog.failure(401, [:])
        XCTAssertEqual(signedOut, .signedOut)
        XCTAssertTrue(APIError.offline.transient)
        XCTAssertTrue(APIError.server(502, "").transient)
        XCTAssertFalse(APIError.server(400, "").transient)
    }

    func testBackoffAndCeiling() {
        XCTAssertEqual(CatalogRules.backoff(attempt: 1), 5)
        XCTAssertEqual(CatalogRules.backoff(attempt: 3), 20)
        XCTAssertEqual(CatalogRules.backoff(attempt: 20), 600)
        XCTAssertFalse(CatalogRules.exhausted(afterAttempt: CatalogRules.maxAttempts - 2))
        XCTAssertTrue(CatalogRules.exhausted(afterAttempt: CatalogRules.maxAttempts - 1))
    }

    func testServerUploadStatesReadUnknownWords() {
        XCTAssertEqual(ServerUploadState(server: "receiving"), .receiving)
        XCTAssertEqual(ServerUploadState(server: "duplicate"), .duplicate)
        XCTAssertEqual(ServerUploadState(server: "quarantined"), .unknown)
        XCTAssertEqual(ServerUploadState(server: nil), .unknown)
        XCTAssertEqual(DirectUploadState(server: "complete"), .complete)
        XCTAssertEqual(DirectUploadState(server: nil), .unknown)
    }

    func testAStepSurvivesATaskDescription() {
        let step = TransferStep(itemId: UUID(), kind: .catalogPatch, offset: 16_777_216)
        XCTAssertEqual(TransferStep(encoded: step.encoded), step)
        XCTAssertTrue(step.catalog)
        XCTAssertFalse(TransferStep(itemId: UUID(), kind: .patch).catalog)
    }

    /// Only a server whose Media Library is the plug-in's catalog gets the Upload tab's clips there.
    @MainActor
    func testTheCatalogIsUsedOnlyWhenItIsTheMediaLibrary() {
        let source = ServerPlugins.Source(id: "catalog", label: "Library")
        XCTAssertTrue(ServerPlugins.Known(plugins: [Studio.plugin], mainSource: source).catalog)
        XCTAssertFalse(ServerPlugins.Known(plugins: [Studio.plugin], mainSource: nil).catalog)
        XCTAssertFalse(ServerPlugins.Known(plugins: ["other"], mainSource: source).catalog)
        XCTAssertFalse(ServerPlugins.Known().catalog)
    }

    func testPiecesStayUnderTheProxysLimit() {
        XCTAssertEqual(CatalogRules.maxPiece, 16 << 20)
        XCTAssertEqual(CatalogAPI.path("api/uploads"), Studio.path("/media/api/uploads"))
    }
}

final class CatalogBrowseTests: XCTestCase {
    func testBrowseOffersOnlyFinishedFootage() {
        let finished: [String: Any] = [
            "id": 7, "safety_status": "Certified", "delivery_ready": true, "media_type": "video",
            "new_filename": "rolling_to_the_ball.mp4", "duration_seconds": 12.4,
            "shot_at": "2025-03-01T10:22:33Z", "video_width": 1080, "video_height": 1920,
            "version_group_id": NSNull(), "active_generation_id": 41,
        ]
        let clip = CatalogClip(finished)
        XCTAssertEqual(clip?.id, 7)
        XCTAssertEqual(clip?.title, "rolling to the ball")
        XCTAssertEqual(clip?.isVideo, true)
        XCTAssertEqual(clip?.shotAt, ISO8601DateFormatter().date(from: "2025-03-01T10:22:33Z"))
        XCTAssertEqual(clip?.aspect ?? 0, 1080.0 / 1920.0, accuracy: 0.0001)
        // the render is in the picture's address: a re-censored clip's new picture is fetched
        XCTAssertEqual(clip?.thumbnail, CatalogAPI.path("api/clips/7/thumbnail?r=41"))

        var processing = finished; processing["safety_status"] = "Processing"
        var notDelivered = finished; notDelivered["delivery_ready"] = false
        var reel = finished; reel["category"] = "content"
        var hiddenVersion = finished; hiddenVersion["version_group_id"] = 3; hiddenVersion["version_primary"] = false
        var shownVersion = finished; shownVersion["version_group_id"] = 3; shownVersion["version_primary"] = true
        XCTAssertNil(CatalogClip(processing))
        XCTAssertNil(CatalogClip(notDelivered))
        XCTAssertNil(CatalogClip(reel))
        XCTAssertNil(CatalogClip(hiddenVersion))
        XCTAssertNotNil(CatalogClip(shownVersion))
    }

    func testBrowseMediaSwitch() {
        let video = CatalogClip(["id": 1, "safety_status": "Certified", "delivery_ready": true, "media_type": "video"])!
        let photo = CatalogClip(["id": 2, "safety_status": "Certified", "delivery_ready": true, "media_type": "image"])!
        XCTAssertTrue(CatalogMedia.all.matches(video) && CatalogMedia.all.matches(photo))
        XCTAssertTrue(CatalogMedia.videos.matches(video) && !CatalogMedia.videos.matches(photo))
        XCTAssertTrue(CatalogMedia.photos.matches(photo) && !CatalogMedia.photos.matches(video))
        XCTAssertEqual(CatalogMedia.photos.query, "image")
        XCTAssertNil(CatalogMedia.all.query)
    }

    @MainActor
    func testBrowseCacheShowsThenChecksAgainAfterTenMinutes() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("browse-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let clip = CatalogClip(["id": 1, "safety_status": "Certified", "delivery_ready": true, "media_type": "video",
                                "active_generation_id": "gen-a"])!
        let cache = BrowseCache(url: file)
        let now = Date()
        cache.store(BrowseCache.latestKey, clips: [clip], etag: "\"v1\"", now: now.addingTimeInterval(-11 * 60))
        XCTAssertFalse(cache.entry(BrowseCache.latestKey)!.isFresh(now: now))
        cache.confirm(BrowseCache.latestKey, now: now)
        XCTAssertTrue(cache.entry(BrowseCache.latestKey)!.isFresh(now: now))
        XCTAssertEqual(cache.entry(BrowseCache.latestKey)?.etag, "\"v1\"")
        // only the 40 most recently used searches are kept; the list always stays
        for n in 0..<45 {
            cache.store(BrowseCache.searchKey("word \(n)", .all), clips: [clip], etag: nil, now: now.addingTimeInterval(Double(n)))
        }
        XCTAssertNil(cache.entry(BrowseCache.searchKey("word 0", .all)))
        XCTAssertNotNil(cache.entry(BrowseCache.searchKey("word 44", .all)))
        XCTAssertNotNil(cache.entry(BrowseCache.latestKey))
        cache.remember(search: "bath")
        cache.remember(search: "Park")
        cache.remember(search: "BATH")
        XCTAssertEqual(cache.recent, ["BATH", "Park"])
    }

    @MainActor
    func testBrowseCacheSurvivesARelaunch() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("browse-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: file) }
        let clip = CatalogClip(["id": 9, "safety_status": "Certified", "delivery_ready": true, "media_type": "image",
                                "new_filename": "smile.jpg", "shot_at": "2025-09-21T08:00:00Z"])!
        BrowseCache(url: file).store(BrowseCache.searchKey("smile", .photos), clips: [clip], etag: "\"e\"")
        let first = BrowseCache(url: file)
        first.store(BrowseCache.searchKey("smile", .photos), clips: [clip], etag: "\"e\"")
        first.remember(search: "smile")
        // the write happens off the main thread: wait for it
        var second = BrowseCache(url: file)
        for _ in 0..<30 where second.recent != ["smile"] {
            try await Task.sleep(nanoseconds: 100_000_000)
            second = BrowseCache(url: file)
        }
        XCTAssertEqual(second.entry(BrowseCache.searchKey("smile", .photos))?.clips, [clip])
        XCTAssertEqual(second.recent, ["smile"])
    }
}
