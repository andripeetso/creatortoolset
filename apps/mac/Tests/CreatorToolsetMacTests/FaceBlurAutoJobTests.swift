import AVFoundation
import XCTest
@testable import CreatorToolsetMac

/// Face Blur's automatic covers against a stand-in server that speaks the device routes: the claim's words, the server's
/// answers, and a whole job on a drawn video (no person in it), which ends with no copy.
final class FaceBlurAutoJobTests: XCTestCase {
    private func folder() -> URL {
        let dir = testFolder("face-blur-auto")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir
    }

    /// A plain video drawn here: 15 frames, 160×120, nothing that looks like a face.
    private func drawnVideo(_ url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 160, AVVideoHeightKey: 120])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 160, kCVPixelBufferHeightKey as String: 120,
        ])
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for f in 0..<15 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            var buffer: CVPixelBuffer?
            CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
            CVPixelBufferLockBaseAddress(buffer!, [])
            memset(CVPixelBufferGetBaseAddress(buffer!)!, 180, CVPixelBufferGetBytesPerRow(buffer!) * 120)
            CVPixelBufferUnlockBaseAddress(buffer!, [])
            XCTAssertTrue(adaptor.append(buffer!, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: 30)))
        }
        input.markAsFinished()
        await writer.finishWriting()
    }

    private func offMain<T>(_ work: @escaping () -> T) async -> T {
        await withCheckedContinuation { c in DispatchQueue.global().async { c.resume(returning: work()) } }
    }

    private func job(_ id: Int, _ site: FakeSite, path: String, out: URL, granted: URL) -> FaceBlurAutoJob {
        FaceBlurAutoJob(api: DeviceAPI(base: site.url, token: "ctd_test"),
                        step: EditorJob(id: id, kind: faceBlurAutoKind, options: ["media": "video", "look": "blur", "path": path, "out": out.path]),
                        granted: [granted.path])
    }

    func testTheClaimCarriesTheJobsWords() {
        let claim = Data(#"{"job":{"id":4,"kind":"faceblur-intake","editId":"","variant":"","options":{"look":"mosaic","media":"photo","path":"/a/b.jpg","out":"/a/Imports"}}}"#.utf8)
        let job = EditorJob(claim: claim)
        XCTAssertEqual(job?.kind, faceBlurAutoKind)
        XCTAssertEqual(job?.options["path"], "/a/b.jpg")
        let auto = FaceBlurAutoJob(api: DeviceAPI(base: URL(string: "http://127.0.0.1:1")!, token: "t"), step: job!)
        XCTAssertFalse(auto.isVideo)
        XCTAssertEqual(auto.preset.look, .mosaic)
    }

    func testTheServersAnswersAreRead() {
        XCTAssertEqual(FaceBlurAutoJob.chosen(Data(#"{"blur":["F1","F3"],"ok":true}"#.utf8)), ["F1", "F3"])
        XCTAssertEqual(FaceBlurAutoJob.chosen(Data(#"{"blur":[]}"#.utf8)), [])
        XCTAssertNil(FaceBlurAutoJob.chosen(Data(#"{"error":"no AI"}"#.utf8)))
        XCTAssertEqual(FaceBlurAutoJob.problem(DeviceReply(status: 502, data: Data())), "HTTP 502")
        // the AI provider could not answer: the server put the file back, which is no failure of this Mac's
        XCTAssertTrue(FaceBlurAutoJob.putBack(DeviceReply(status: 409, data: Data(#"{"error":"At its limit","back":true}"#.utf8))))
        XCTAssertFalse(FaceBlurAutoJob.putBack(DeviceReply(status: 409, data: Data(#"{"error":"Refused"}"#.utf8))))
    }

    func testAVideoWithNoFaceIsReadWhereItIsAndSendsItsHash() async throws {
        let dir = folder()
        let video = dir.appendingPathComponent("drawn.mov")
        try await drawnVideo(video)
        let site = FakeSite()
        site.answer = { _ in (200, #"{"ok":true}"#) }
        let out = dir.appendingPathComponent("Imports")
        let end = await offMain { self.job(9, site, path: video.path, out: out, granted: dir).run().end }
        XCTAssertEqual(end, .done)
        XCTAssertTrue(site.requests.allSatisfy { $0.method == "POST" }, "the original is never downloaded")
        XCTAssertEqual(site.requests.map(\.path), ["/api/devices/relay/job/faceblur-intake/9"])
        let body = try JSONSerialization.jsonObject(with: site.requests[0].body) as? [String: String]
        XCTAssertEqual(body?["nothing"], "No face found")
        XCTAssertEqual(body?["sha256"], try LibraryCopyJob.sha256(of: video))
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), "no copy is written")
    }

    func testAFileNotHereNowGoesBackNotFailed() async throws {
        let dir = folder()
        let site = FakeSite()
        site.answer = { _ in (200, #"{"ok":true}"#) }
        let end = await offMain { self.job(3, site, path: dir.appendingPathComponent("moved.mov").path, out: dir, granted: dir).run().end }
        XCTAssertEqual(end, .gone)
        XCTAssertEqual(site.requests.map(\.path), ["/api/devices/relay/job/faceblur-intake/3"])
        let body = try JSONSerialization.jsonObject(with: site.requests[0].body) as? [String: String]
        XCTAssertNotNil(body?["back"])
    }

    func testAFileOutsideTheSharedFoldersFails() async {
        let dir = folder(), other = folder()
        let site = FakeSite()
        site.answer = { _ in (200, #"{"ok":true}"#) }
        let video = other.appendingPathComponent("x.mov")
        FileManager.default.createFile(atPath: video.path, contents: Data("x".utf8))
        let end = await offMain { self.job(4, site, path: video.path, out: dir, granted: dir).run().end }
        guard case .failed = end else { return XCTFail("expected a failure, got \(end)") }
        XCTAssertEqual(site.requests.last?.path, "/api/devices/relay/job/faceblur-intake/4/fail")
    }

    func testAnUnreadableFileFailsWithASentence() async {
        let dir = folder()
        let bad = dir.appendingPathComponent("bad.mov")
        FileManager.default.createFile(atPath: bad.path, contents: Data("not a video".utf8))
        let site = FakeSite()
        site.answer = { _ in (200, #"{"ok":true}"#) }
        let end = await offMain { self.job(5, site, path: bad.path, out: dir, granted: dir).run().end }
        guard case .failed(let why) = end else { return XCTFail("expected a failure, got \(end)") }
        XCTAssertFalse(why.isEmpty)
        XCTAssertEqual(site.requests.last?.path, "/api/devices/relay/job/faceblur-intake/5/fail")
    }

    func testTheCopysRecordCarriesItsOwnPrints() async throws {
        let video = folder().appendingPathComponent("copy.mp4")
        try await drawnVideo(video)
        let made = try FaceBlurAutoJob.record(of: video)
        XCTAssertEqual(made["path"] as? String, video.path)
        XCTAssertEqual(made["quick"] as? String, Imports.quickPrint(video.path))
        XCTAssertEqual(made["sha256"] as? String, try LibraryCopyJob.sha256(of: video))
        XCTAssertGreaterThan(made["size"] as? Int ?? 0, 0)
        XCTAssertGreaterThan(made["duration"] as? Double ?? 0, 0)
    }

    func testTheCopysSizeAndBitrateComeFromTheJob() {
        XCTAssertEqual(FaceBlurAutoJob.output([:]), CoverOutput())
        XCTAssertEqual(FaceBlurAutoJob.output([:]).videoLongSide, 1920)
        XCTAssertEqual(FaceBlurAutoJob.output([:]).photoLongSide, 4096)
        let big = FaceBlurAutoJob.output(["longSide": "3840", "bitrate": "50000000"])
        XCTAssertEqual(big.videoLongSide, 3840)
        XCTAssertEqual(big.photoLongSide, 3840)
        XCTAssertEqual(big.bitrate, 50_000_000)
        // as filmed: a video at most 3840 (the encoder's limit), a photo as today
        let filmed = FaceBlurAutoJob.output(["longSide": "0"])
        XCTAssertEqual(filmed.videoLongSide, 3840)
        XCTAssertEqual(filmed.photoLongSide, 4096)
        // anything else is the engine's own
        let odd = FaceBlurAutoJob.output(["longSide": "720", "bitrate": "9999999999"])
        XCTAssertEqual(odd, CoverOutput())
        XCTAssertEqual(FaceBlurAutoJob.output(["bitrate": "fast"]).bitrate, 20_000_000)
    }
}
