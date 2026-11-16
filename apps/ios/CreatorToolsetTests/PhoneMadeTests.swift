import AVFoundation
import UIKit
import XCTest
@testable import CreatorToolset

/// What the phone makes of a video itself for its upload (`PhoneMade`, the server's derived.ts `Made`).
@MainActor
final class PhoneMadeTests: XCTestCase {
    private var tiny: URL { Bundle(for: Self.self).url(forResource: "tiny", withExtension: "mp4")! }

    private func scratch(_ name: String) -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("phone-made-\(UUID().uuidString)-\(name)")
    }

    /// The vectors come from the server's algorithm (size as text, first MiB, last MiB over 2 MiB), computed outside Swift.
    func testQuickFingerprintIsTheServersAndTheMacs() throws {
        XCTAssertEqual(PhoneMade.quickPrint(tiny), "69746c7c57529092cdd962a27c45c16b44ae32d7d77b1a633523cb65b618f568")
        let big = scratch("big")
        defer { try? FileManager.default.removeItem(at: big) }
        try Data((0..<(3 << 20) + 5).map { UInt8($0 % 251) }).write(to: big)
        XCTAssertEqual(PhoneMade.quickPrint(big), "0ee8b30d373feef377f5e6a638c1126998e0722ce74d8457e1bc8884724e6ff1")
        XCTAssertNil(PhoneMade.quickPrint(scratch("missing")))
    }

    func testRotationAndCodecsReadAsTheServersProbe() {
        XCTAssertEqual(PhoneMade.rotation(.identity), 0)
        XCTAssertEqual(PhoneMade.rotation(CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 1080, ty: 0)), 90) // an iPhone's portrait clip
        XCTAssertEqual(PhoneMade.rotation(CGAffineTransform(a: -1, b: 0, c: 0, d: -1, tx: 0, ty: 0)), 180)
        XCTAssertEqual(PhoneMade.rotation(CGAffineTransform(a: 0, b: -1, c: 1, d: 0, tx: 0, ty: 0)), 270)
        XCTAssertEqual(PhoneMade.codec(kCMVideoCodecType_HEVC), "hevc")
        XCTAssertEqual(PhoneMade.codec(kCMVideoCodecType_H264), "h264")
        XCTAssertEqual(PhoneMade.codec(kCMVideoCodecType_AppleProRes422), "prores")
        XCTAssertEqual(PhoneMade.codec(kAudioFormatMPEG4AAC), "aac")
    }

    func testProbeAndCardPictureOfAVideo() async throws {
        let probeRead = await PhoneMade.probe(tiny)
        let probe = try XCTUnwrap(probeRead)
        XCTAssertEqual(probe.vcodec, "h264")
        XCTAssertEqual(probe.pixFmt, "yuv420p")
        XCTAssertEqual([probe.width, probe.height], [1080, 1920])
        XCTAssertGreaterThan(probe.duration, 0)
        XCTAssertTrue(probe.format.contains("mp4"))

        let pictureRead = await PhoneMade.cardPicture(tiny, duration: probe.duration)
        let picture = try XCTUnwrap(pictureRead)
        XCTAssertEqual(Array(picture.prefix(2)), [0xFF, 0xD8])
        XCTAssertEqual(UIImage(data: picture)?.cgImage?.width, 480)

        let notVideo = scratch("note.txt")
        defer { try? FileManager.default.removeItem(at: notVideo) }
        try Data("not a video".utf8).write(to: notVideo)
        let none = await PhoneMade.probe(notVideo)
        XCTAssertNil(none)
    }

    func testTheCopyIs720p() async throws {
        let out = scratch("720p.mp4")
        defer { try? FileManager.default.removeItem(at: out) }
        try await PhoneMade.proxy(tiny, to: out)
        let probeRead = await PhoneMade.probe(out)
        let probe = try XCTUnwrap(probeRead)
        XCTAssertEqual(probe.vcodec, "h264")
        XCTAssertEqual(min(probe.width, probe.height), 720)
    }

    /// To a library that keeps only proxies the upload's bytes become the copy, and the start carries the original's
    /// fingerprint, size and probe; to any other library the original goes, with its fingerprint and picture.
    func testWhatTheUploadStartSends() async throws {
        let engine = UploadEngine.shared
        let heavy = scratch("heavy.mov")
        defer { try? FileManager.default.removeItem(at: heavy) }
        try await writeNoise(to: heavy)
        let size = Int64(try Data(contentsOf: heavy).count)
        func added(_ name: String) throws -> UUID {
            let id = UUID()
            try? FileManager.default.removeItem(at: AppFiles.upload(id))
            try FileManager.default.copyItem(at: heavy, to: AppFiles.upload(id))
            engine.store.add(UploadItem(id: id, filename: name, size: size, server: "phone-made-test"))
            return id
        }

        let kept = try added("Roll.MOV")
        defer { engine.store.remove(kept) }
        let all = await engine.made(kept, proxies: false)
        XCTAssertEqual(all["quick"] as? String, PhoneMade.quickPrint(heavy))
        XCTAssertNotNil(all["thumb"] as? String)
        XCTAssertNil(all["proxy"])
        XCTAssertEqual(engine.store.item(kept)?.size, size)

        let copied = try added("Cartwheel.MOV")
        defer { engine.store.remove(copied) }
        let proxies = await engine.made(copied, proxies: true)
        let proxy = try XCTUnwrap(proxies["proxy"] as? [String: Any])
        XCTAssertEqual(proxy["size"] as? Int64, size)
        XCTAssertEqual((proxy["probe"] as? [String: Any])?["width"] as? Int, 1080)
        XCTAssertEqual(proxies["quick"] as? String, PhoneMade.quickPrint(heavy)) // the original's, not the copy's
        let item = try XCTUnwrap(engine.store.item(copied))
        XCTAssertEqual(item.filename, "Cartwheel.mp4")
        let onDisk = try XCTUnwrap(FileManager.default.attributesOfItem(atPath: AppFiles.upload(copied).path)[.size] as? Int64)
        XCTAssertEqual(item.size, onDisk)
        // asked again (a retry), it sends the same and makes no second copy
        let again = await engine.made(copied, proxies: true)
        XCTAssertEqual((again["proxy"] as? [String: Any])?["size"] as? Int64, size)
        XCTAssertEqual(engine.store.item(copied)?.size, onDisk)
    }
}

/// A second of 1080x1920 noise at 40 Mbit/s: heavier than its 720p copy, as a phone's own clip is.
private func writeNoise(to url: URL) async throws {
    let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 1080, AVVideoHeightKey: 1920,
        AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 40_000_000],
    ])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 1080, kCVPixelBufferHeightKey as String: 1920,
    ])
    writer.add(input)
    writer.startWriting()
    writer.startSession(atSourceTime: .zero)
    var seed: UInt64 = 1
    for frame in 0..<30 {
        while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
        let pixels = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(pixels, [])
        let words = CVPixelBufferGetBytesPerRow(pixels) * 1920 / 8
        let base = CVPixelBufferGetBaseAddress(pixels)!.bindMemory(to: UInt64.self, capacity: words)
        for i in 0..<words {
            seed = seed &* 6364136223846793005 &+ 1442695040888963407
            base[i] = seed
        }
        CVPixelBufferUnlockBaseAddress(pixels, [])
        adaptor.append(pixels, withPresentationTime: CMTime(value: CMTimeValue(frame), timescale: 30))
    }
    input.markAsFinished()
    await writer.finishWriting()
    XCTAssertEqual(writer.status, .completed, writer.error?.localizedDescription ?? "")
}
