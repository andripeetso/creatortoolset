import ImageIO
import Photos
import XCTest
@testable import CreatorToolset

/// The Upload tab's sums: which clips a chip lists, what the two buttons of the bar do, what the strip says, and the
/// badge each clip carries.
@MainActor
final class UploadTabTests: XCTestCase {
    private func upload(_ asset: String, _ state: UploadItem.State, size: Int64 = 100, sent: Int64 = 0,
                        finishedAt: Date? = nil) -> UploadItem {
        var item = UploadItem(asset: asset, filename: "\(asset).MOV", isVideo: true, capturedAt: nil, server: "s")
        item.state = state
        item.size = size
        item.sent = sent
        item.finishedAt = finishedAt
        return item
    }

    private let roll = [
        PhoneClip(id: "new", favourite: true),
        PhoneClip(id: "waiting", badge: .waiting),
        PhoneClip(id: "sending", badge: .uploading(0.4)),
        PhoneClip(id: "failed", badge: .failed, favourite: true),
        PhoneClip(id: "there", badge: .uploaded, favourite: true),
        PhoneClip(id: "new2"),
    ]

    func testEachUploadStateShowsItsBadge() {
        func badge(_ state: UploadItem.State, sent: Int64 = 0) -> StatusBadge.Kind {
            StatusBadge.kind(for: upload("a", state), sent: sent, inLibrary: false)
        }
        // not sent from this phone: the check when the library has it, else nothing
        XCTAssertEqual(StatusBadge.kind(for: nil, sent: 0, inLibrary: false), StatusBadge.Kind.none)
        XCTAssertEqual(StatusBadge.kind(for: nil, sent: 0, inLibrary: true), .uploaded)
        XCTAssertEqual(badge(.picked), .waiting)
        XCTAssertEqual(badge(.preparing), .waiting)
        XCTAssertEqual(badge(.sending, sent: 40), .uploading(0.4))
        XCTAssertEqual(badge(.finishing), .uploading(1))
        XCTAssertEqual(badge(.confirming), .uploading(1))
        XCTAssertEqual(badge(.done), .uploaded)
        XCTAssertEqual(badge(.failed), .failed)
        // this phone's own upload says more than the library's name check
        XCTAssertEqual(StatusBadge.kind(for: upload("a", .failed), sent: 0, inLibrary: true), .failed)
    }

    func testNotUploadedListsEveryClipWithoutTheGreenCheck() {
        XCTAssertEqual(UploadSums.listed(roll, filter: .notUploaded).map(\.id), ["new", "waiting", "sending", "failed", "new2"])
        XCTAssertEqual(UploadSums.listed(roll, filter: .all).count, 6)
        XCTAssertEqual(UploadSums.listed(roll, filter: .favourites).map(\.id), ["new", "failed", "there"])
        XCTAssertEqual(UploadSums.listed(roll, filter: .album("x"), album: ["there", "new2", "gone"]).map(\.id), ["there", "new2"])
    }

    func testSelectAllPicksWhatCanStillBePicked() {
        XCTAssertEqual(UploadSums.selectAll(roll, picked: []), .pick(["new", "new2"]))
        XCTAssertEqual(UploadSums.selectAll(roll, picked: ["new"]), .pick(["new", "new2"]))
        XCTAssertEqual(UploadSums.selectAll(roll, picked: ["new", "new2"]), .clear)
        XCTAssertEqual(UploadSums.selectAll(UploadSums.listed(roll, filter: .favourites), picked: []), .pick(["new"]))
        let sent = [PhoneClip(id: "there", badge: .uploaded)]
        XCTAssertNil(UploadSums.selectAll(sent, picked: []))
        XCTAssertEqual(UploadSums.selectAll(sent, picked: ["new"]), .clear)
        XCTAssertNil(UploadSums.selectAll([], picked: []))
    }

    func testUploadCountsPickedAndAddedEarlierOnce() {
        let uploads = [upload("old1", .picked), upload("old2", .picked), upload("failed", .failed),
                       upload("sending", .sending), upload("there", .done)]
        let byAsset = Dictionary(uniqueKeysWithValues: uploads.map { ($0.assetId!, $0) })
        let badge: (String) -> StatusBadge.Kind = { StatusBadge.kind(for: byAsset[$0], sent: 0, inLibrary: $0 == "elsewhere") }
        var send = UploadSums.toSend(picked: [], uploads: uploads, badge: badge)
        XCTAssertEqual(send.fresh, [])
        XCTAssertEqual(send.count, 3)
        send = UploadSums.toSend(picked: ["new", "new2"], uploads: uploads, badge: badge)
        XCTAssertEqual(send.fresh, ["new", "new2"])
        XCTAssertEqual(send.count, 5)
        // a pick already added, on its way, failed, or found in the library since is not counted twice
        send = UploadSums.toSend(picked: ["new", "old1", "sending", "failed", "there", "elsewhere"], uploads: uploads, badge: badge)
        XCTAssertEqual(send.fresh, ["new"])
        XCTAssertEqual(send.count, 4)
        XCTAssertEqual(UploadSums.toSend(picked: [], uploads: [upload("failed", .failed)], badge: badge).count, 1)
        XCTAssertEqual(UploadSums.toSend(picked: [], uploads: [upload("there", .done)], badge: badge).count, 0)
    }

    /// A New edit's clips and another server's uploads are not the tab's: not counted, listed or tried again by Upload.
    func testTheTabLeavesNewEditClipsAndOtherServersAlone() {
        var editClip = UploadItem(id: UUID(), filename: "a.mp4", size: 10, server: "s")
        editClip.edit = UUID()
        editClip.state = .failed
        var elsewhere = UploadItem(asset: "b", filename: "b.MOV", isVideo: true, capturedAt: nil, server: "other")
        elsewhere.state = .failed
        let mine = upload("c", .failed)
        let tab = UploadSums.tab([editClip, elsewhere, mine], server: "s")
        XCTAssertEqual(tab.map(\.id), [mine.id])
        XCTAssertEqual(UploadSums.failed(tab), "1 needs a look")
    }

    func testStripSaysWhatIsOnItsWayAndWhatFailed() {
        let start = Date(timeIntervalSince1970: 1_000)
        let sent: (UploadItem) -> Int64 = { $0.sent }
        XCTAssertNil(UploadSums.sending([], since: nil, sent: sent))
        XCTAssertNil(UploadSums.sending([upload("a", .done), upload("b", .picked), upload("c", .failed)], since: nil, sent: sent))
        XCTAssertNil(UploadSums.failed([upload("a", .done), upload("b", .sending)]))

        var strip = UploadSums.sending([upload("a", .sending, sent: 50), upload("b", .preparing, size: 0)], since: start, sent: sent)
        XCTAssertEqual(strip?.text, "Uploading 2")
        XCTAssertEqual(strip?.progress ?? 0, 0.25, accuracy: 0.0001)

        let run = [
            upload("a", .sending, sent: 50), upload("b", .confirming),
            upload("c", .done, finishedAt: start.addingTimeInterval(5)),
            upload("d", .done, finishedAt: start.addingTimeInterval(9)),
            upload("e", .done, finishedAt: start),
            upload("old", .done, finishedAt: start.addingTimeInterval(-60)),
            upload("f", .failed),
        ]
        strip = UploadSums.sending(run, since: start, sent: sent)
        XCTAssertEqual(strip?.text, "Uploading 5 · 2 left")
        XCTAssertEqual(strip?.progress ?? 0, 4.5 / 5, accuracy: 0.0001)
        XCTAssertEqual(UploadSums.sending([upload("a", .sending)], since: start, sent: { _ in 250 })?.progress, 1)
        XCTAssertEqual(UploadSums.failed(run), "1 needs a look")
        XCTAssertEqual(UploadSums.failed([upload("a", .failed), upload("b", .failed)]), "2 need a look")
    }

    func testBytesGoingUpAreNotAChangeOfState() {
        var sending = upload("a", .sending, sent: 10)
        let waiting = upload("b", .preparing)
        let before = UploadSums.states([sending, waiting])
        // bytes, a note and a retry count: the roll is not walked again for these
        sending.sent = 90
        sending.note = "The connection dropped"
        sending.attempts = 2
        XCTAssertEqual(UploadSums.states([sending, waiting]), before)
        sending.state = .done
        XCTAssertNotEqual(UploadSums.states([sending, waiting]), before)
        sending.state = .sending
        XCTAssertNotEqual(UploadSums.states([sending, waiting, upload("c", .picked)]), before)
    }

    func testTheRollIsWalkedOnlyWhenSomethingItShowsChanged() {
        let memo = RollMemo()
        var walks = 0
        let walk: () -> [PhoneClip] = {
            walks += 1
            return [PhoneClip(id: "walk \(walks)")]
        }
        XCTAssertEqual(memo.clips("0 true", walk: walk).map(\.id), ["walk 1"])
        XCTAssertEqual(memo.clips("0 true", walk: walk).map(\.id), ["walk 1"])
        XCTAssertEqual(memo.clips("0 true", walk: walk).map(\.id), ["walk 1"])
        XCTAssertEqual(walks, 1)
        XCTAssertEqual(memo.clips("1 true", walk: walk).map(\.id), ["walk 2"])
        XCTAssertEqual(memo.clips("1 false", walk: walk).map(\.id), ["walk 3"])
        XCTAssertEqual(walks, 3)
    }

    /// How long the tab's sums take over a camera roll of 5,000 clips (printed; the limit is loose for a busy Mac).
    func testFiveThousandClipsAreListedInMilliseconds() {
        let ids = (0..<5_000).map { "asset-\($0)" }
        let uploads = (0..<500).map { n in upload(ids[n], n == 0 ? .failed : n < 3 ? .sending : .done, sent: 40) }
        let byAsset = Dictionary(uniqueKeysWithValues: uploads.map { ($0.assetId!, $0) })
        let inLibrary = Set(ids[500..<2_500])
        let badge: (String) -> StatusBadge.Kind = {
            StatusBadge.kind(for: byAsset[$0], sent: byAsset[$0]?.sent ?? 0, inLibrary: inLibrary.contains($0))
        }
        func median(_ work: () -> Void) -> Double {
            let runs: [Double] = (0..<21).map { _ in
                let began = CFAbsoluteTimeGetCurrent()
                work()
                return (CFAbsoluteTimeGetCurrent() - began) * 1000
            }
            return runs.sorted()[10]
        }
        var clips: [PhoneClip] = []
        let walk = median { clips = ids.enumerated().map { n, id in PhoneClip(id: id, badge: badge(id), favourite: n % 7 == 0, duration: 12) } }
        var picks = 0
        let redraw = median {
            let shown = UploadSums.listed(clips, filter: .notUploaded)
            if case .pick(let open) = UploadSums.selectAll(shown, picked: []) { picks = open.count }
            _ = UploadSums.toSend(picked: ["asset-4000", "asset-4001"], uploads: uploads, badge: badge)
        }
        print(String(format: "UPLOAD-TAB-TIMING 5000 clips: walk %.2f ms, one redraw's sums %.2f ms", walk, redraw))
        XCTAssertEqual(UploadSums.listed(clips, filter: .notUploaded).count, 2_503)
        XCTAssertEqual(picks, 2_500)
        XCTAssertLessThan(walk + redraw, 500)
    }

    /// Each server's uploads of the same clip are kept apart, and the newest one stands for it.
    func testUploadsAreFoundByClipPerServer() {
        let older = upload("a", .failed)
        let other = UploadItem(asset: "a", filename: "a.MOV", isVideo: true, capturedAt: nil, server: "t")
        let newer = upload("a", .done)
        let found = UploadStore.byAsset([older, other, newer])
        XCTAssertEqual(found[UploadStore.key(asset: "a", server: "s")]?.id, newer.id)
        XCTAssertEqual(found[UploadStore.key(asset: "a", server: "t")]?.id, other.id)
    }

    func testActivitySaysWhyAndWhen() {
        let now = Date(timeIntervalSince1970: 10_000)
        var item = upload("a", .sending, sent: 25)
        XCTAssertEqual(ActivityView.status(item, sent: 25, now: now), "Uploading · 25%")
        item.note = "The connection dropped"
        item.nextAttemptAt = now.addingTimeInterval(40)
        XCTAssertEqual(ActivityView.status(item, sent: 25, now: now), "The connection dropped · trying again in 40 s")
        item.nextAttemptAt = now.addingTimeInterval(130)
        XCTAssertEqual(ActivityView.status(item, sent: 25, now: now), "The connection dropped · trying again in 2 min")
        item.state = .failed
        XCTAssertEqual(ActivityView.status(item, sent: 0, now: now), "Couldn't upload: The connection dropped")
        item.state = .done
        item.duplicate = true
        XCTAssertEqual(ActivityView.status(item, sent: 0, now: now), "Already in the library")
    }
}

/// The queue saved by an older build still reads, New edit clips included.
final class UploadQueueTests: XCTestCase {
    func testAQueueSavedBeforeTheCameraRollStillReads() throws {
        // what the build before this one wrote (UploadItem's fields then)
        let old = #"""
        [{"id":"0E2E6E9A-3C1B-4C55-9D8A-1D1B4E7C2F01","filename":"take.mp4","size":1000,"server":"http://127.0.0.1:43190",
          "state":"sending","sent":512,"uploadId":"u1","chunkSize":33554432,"duplicate":false,"attempts":0,
          "edit":"7A1C0C7E-1B2D-4E3F-8A9B-0C1D2E3F4A5B"},
         {"id":"0E2E6E9A-3C1B-4C55-9D8A-1D1B4E7C2F02","filename":"a.mov","size":10,"server":"s","state":"done","sent":10,
          "duplicate":true,"attempts":0}]
        """#
        let items = try JSONDecoder().decode([UploadItem].self, from: Data(old.utf8))
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items[0].uploadId, "u1")
        XCTAssertNotNil(items[0].edit)
        XCTAssertNil(items[0].route)
        XCTAssertNil(items[0].assetId)
        XCTAssertTrue(items[0].isWorking)
        XCTAssertTrue(items[1].duplicate)
        // and what this build writes reads back
        var clip = UploadItem(asset: "A/L0/001", filename: "IMG_1.MOV", isVideo: true, capturedAt: Date(timeIntervalSince1970: 5), server: "s")
        clip.route = .catalog
        clip.catalog = CatalogSend(ingestId: "i", chunkSize: 5, direct: true)
        let again = try JSONDecoder().decode(UploadItem.self, from: JSONEncoder().encode(clip))
        XCTAssertEqual(again, clip)
    }
}

final class PhotosTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    func testFingerprintIsTheFilesSha256() async throws {
        let file = folder.appendingPathComponent("abc.bin")
        try Data("abc".utf8).write(to: file)
        let sha = try await Exporter.sha256(of: file)
        XCTAssertEqual(sha, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testScreenshotsAreNeverCameraPhotos() {
        XCTAssertEqual(CameraOrigin.quick(subtypes: .photoScreenshot, isBurst: false, fileType: "public.png"), false)
        XCTAssertEqual(CameraOrigin.quick(subtypes: .photoScreenshot, isBurst: false, fileType: "public.heic"), false)
    }

    func testOnlyACameraMakesLiveHdrPortraitBurstOrHeicPhotos() {
        XCTAssertEqual(CameraOrigin.quick(subtypes: .photoLive, isBurst: false, fileType: "public.jpeg"), true)
        XCTAssertEqual(CameraOrigin.quick(subtypes: .photoDepthEffect, isBurst: false, fileType: nil), true)
        XCTAssertEqual(CameraOrigin.quick(subtypes: [], isBurst: true, fileType: "public.jpeg"), true)
        XCTAssertEqual(CameraOrigin.quick(subtypes: [], isBurst: false, fileType: "public.heic"), true)
        XCTAssertEqual(CameraOrigin.quick(subtypes: [], isBurst: false, fileType: "com.adobe.raw-image"), true)
        // a plain JPEG or PNG could be a picture saved from a chat: only its metadata can tell
        XCTAssertNil(CameraOrigin.quick(subtypes: [], isBurst: false, fileType: "public.jpeg"))
        XCTAssertNil(CameraOrigin.quick(subtypes: [], isBurst: false, fileType: "public.png"))
    }

    func testCameraMetadataNeedsAMaker() {
        XCTAssertTrue(CameraOrigin.namesACamera([kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "Apple"]]))
        XCTAssertFalse(CameraOrigin.namesACamera([kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: "  "]]))
        XCTAssertFalse(CameraOrigin.namesACamera([:]))
    }

    func testOnlyMediaFrom2023OnIsListed() {
        let predicate = PhotoLibrary.fetchOptions().predicate!
        let calendar = Calendar(identifier: .gregorian)
        XCTAssertFalse(predicate.evaluate(with: ["creationDate": calendar.date(from: DateComponents(year: 2022, month: 12, day: 31, hour: 23, minute: 59))!]))
        XCTAssertTrue(predicate.evaluate(with: ["creationDate": calendar.date(from: DateComponents(year: 2023, month: 1, day: 1))!]))
        XCTAssertTrue(predicate.evaluate(with: ["creationDate": Date()]))
    }

    @MainActor
    func testUploadedCheckAsksAgainOnceADayNotEveryVisit() {
        let now = Date()
        typealias Mark = LibraryIndex.Mark
        XCTAssertTrue(LibraryIndex.needsCheck(nil, now: now))
        XCTAssertFalse(LibraryIndex.needsCheck(Mark(name: "IMG_1.HEIC", size: 1, inLibrary: false, checkedAt: now.addingTimeInterval(-3600)), now: now))
        XCTAssertTrue(LibraryIndex.needsCheck(Mark(name: "IMG_1.HEIC", size: 1, inLibrary: false, checkedAt: now.addingTimeInterval(-25 * 3600)), now: now))
        XCTAssertFalse(LibraryIndex.needsCheck(Mark(name: "IMG_1.HEIC", size: 1, inLibrary: true, checkedAt: .distantPast), now: now))
    }

    /// A clip in one server's library is not in another's.
    @MainActor
    func testInTheLibraryIsPerServer() {
        let index = LibraryIndex(url: folder.appendingPathComponent("index.json"))
        index.markInLibrary(["a"], server: "s")
        XCTAssertTrue(index.isInLibrary("a", server: "s"))
        XCTAssertFalse(index.isInLibrary("a", server: "t"))
        XCTAssertFalse(index.isInLibrary("a", server: nil))
        XCTAssertTrue(LibraryIndex(url: folder.appendingPathComponent("index.json")).isInLibrary("a", server: "s"))
    }

    @MainActor
    func testICloudOnlyPhotosAreRetriedADayLaterNotEveryVisit() {
        let now = Date()
        typealias Mark = PhotoLibrary.CameraMark
        XCTAssertFalse(Mark(camera: nil, checkedAt: now.addingTimeInterval(-3600)).needsCheck(now: now))
        XCTAssertTrue(Mark(camera: nil, checkedAt: now.addingTimeInterval(-25 * 3600)).needsCheck(now: now))
        XCTAssertFalse(Mark(camera: false, checkedAt: .distantPast).needsCheck(now: now))
        XCTAssertFalse(Mark(camera: true, checkedAt: .distantPast).needsCheck(now: now))
    }
}
