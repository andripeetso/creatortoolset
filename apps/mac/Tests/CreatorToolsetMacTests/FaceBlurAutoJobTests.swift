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

    func testTheClaimCarriesTheJobsWords() {
        let claim = Data(#"{"job":{"id":4,"kind":"faceblur","editId":"","variant":"","options":{"mode":"some","look":"mosaic","media":"photo"}}}"#.utf8)
        let job = EditorJob(claim: claim)
        XCTAssertEqual(job?.kind, faceBlurAutoKind)
        XCTAssertEqual(job?.options, ["mode": "some", "look": "mosaic", "media": "photo"])
        let auto = FaceBlurAutoJob(api: DeviceAPI(base: URL(string: "http://127.0.0.1:1")!, token: "t"), step: job!, folder: folder())
        XCTAssertFalse(auto.isVideo)
        XCTAssertEqual(auto.preset.look, .mosaic)
        // a claim from a server that sends no options: a video, blurred
        let plain = FaceBlurAutoJob(api: auto.api, step: EditorJob(id: 1, kind: faceBlurAutoKind), folder: folder())
        XCTAssertTrue(plain.isVideo)
        XCTAssertEqual(plain.preset.look, .blur)
    }

    func testTheServersAnswersAreRead() {
        XCTAssertEqual(FaceBlurAutoJob.chosen(Data(#"{"blur":["F1","F3"],"ok":true}"#.utf8)), ["F1", "F3"])
        XCTAssertNil(FaceBlurAutoJob.chosen(Data(#"{"error":"no AI"}"#.utf8)))
        XCTAssertEqual(FaceBlurAutoJob.problem(DeviceReply(status: 409, data: Data(#"{"error":"Face Blur needs your AI. Nothing was blurred."}"#.utf8))), "Face Blur needs your AI. Nothing was blurred.")
        XCTAssertEqual(FaceBlurAutoJob.problem(DeviceReply(status: 502, data: Data())), "HTTP 502")
    }

    func testAVideoWithNoFaceEndsWithNoCopyAndNoQuestion() async throws {
        let video = folder().appendingPathComponent("drawn.mov")
        try await drawnVideo(video)
        let bytes = try Data(contentsOf: video)
        let site = FakeSite()
        site.bytes = { $0.method == "GET" && $0.path == "/api/devices/relay/job/faceblur/9" ? bytes : nil }
        site.answer = { _ in (200, #"{"ok":true}"#) }
        let work = folder().appendingPathComponent("faceblur/9")
        let job = FaceBlurAutoJob(api: DeviceAPI(base: site.url, token: "ctd_test"), step: EditorJob(id: 9, kind: faceBlurAutoKind, options: ["mode": "some", "look": "blur", "media": "video"]), folder: work)
        let end = await offMain { job.run().end }
        XCTAssertEqual(end, .done)
        let posts = site.requests.filter { $0.method == "POST" }
        // no face: the AI is never asked, no file is sent, and the server is told there was nothing to cover
        XCTAssertEqual(posts.map(\.path), ["/api/devices/relay/job/faceblur/9"])
        let body = try JSONSerialization.jsonObject(with: posts[0].body) as? [String: String]
        XCTAssertEqual(body?["nothing"], "No face found, nothing written")
        XCTAssertFalse(FileManager.default.fileExists(atPath: work.path), "the job's files are removed")
    }

    func testAFileNoLongerThisMacsIsLeftAlone() async {
        let site = FakeSite()
        site.answer = { _ in (404, #"{"error":"Not found"}"#) }
        let job = FaceBlurAutoJob(api: DeviceAPI(base: site.url, token: "ctd_test"), step: EditorJob(id: 3, kind: faceBlurAutoKind), folder: folder().appendingPathComponent("faceblur/3"))
        let end = await offMain { job.run().end }
        XCTAssertEqual(end, .gone)
        XCTAssertTrue(site.requests.allSatisfy { $0.method == "GET" }, "nothing is sent for a job taken back")
    }

    func testAnUnreadableFileFailsWithASentence() async {
        let site = FakeSite()
        site.bytes = { $0.method == "GET" ? Data("not a video".utf8) : nil }
        site.answer = { _ in (200, #"{"ok":true}"#) }
        let job = FaceBlurAutoJob(api: DeviceAPI(base: site.url, token: "ctd_test"), step: EditorJob(id: 5, kind: faceBlurAutoKind), folder: folder().appendingPathComponent("faceblur/5"))
        let end = await offMain { job.run().end }
        guard case .failed(let why) = end else { return XCTFail("expected a failure, got \(end)") }
        XCTAssertFalse(why.isEmpty)
        XCTAssertEqual(site.requests.last?.path, "/api/devices/relay/job/faceblur/5/fail")
    }
}
