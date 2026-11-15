import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CreatorToolset

// The engine checks are the Mac app's (apps/mac/Tests/CreatorToolsetMacTests/FaceBlurTests.swift): the engine is the same files.

/// A scratch folder for one test, removed at the end.
private func scratch() throws -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("face-blur-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}

/// A plain light-yellow video drawn here (no person in it): `frames` frames at 30 fps, 320×240, with a location in its
/// metadata.
private func makeVideo(_ url: URL, frames: Int = 30) async throws {
    let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
    let location = AVMutableMetadataItem()
    location.identifier = .quickTimeMetadataLocationISO6709
    location.value = "+59.4370+024.7536/" as NSString
    writer.metadata = [location]
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 240])
    input.expectsMediaDataInRealTime = false
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 320, kCVPixelBufferHeightKey as String: 240,
    ])
    writer.add(input)
    XCTAssertTrue(writer.startWriting())
    writer.startSession(atSourceTime: .zero)
    for f in 0..<frames {
        while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, adaptor.pixelBufferPool!, &buffer)
        CVPixelBufferLockBaseAddress(buffer!, [])
        let base = CVPixelBufferGetBaseAddress(buffer!)!.assumingMemoryBound(to: UInt8.self)
        let row = CVPixelBufferGetBytesPerRow(buffer!)
        for y in 0..<240 { for x in 0..<320 { let p = base + y * row + x * 4; p[0] = 120; p[1] = 220; p[2] = 230; p[3] = 255 } }
        CVPixelBufferUnlockBaseAddress(buffer!, [])
        XCTAssertTrue(adaptor.append(buffer!, withPresentationTime: CMTime(value: CMTimeValue(f), timescale: 30)))
    }
    input.markAsFinished()
    await writer.finishWriting()
    XCTAssertEqual(writer.status, .completed)
}

/// Every frame of a video: its time and the brightness (0…255) of its centre pixel.
private func centres(_ url: URL) async throws -> [(time: Double, value: Int)] {
    let asset = AVURLAsset(url: url)
    let track = try await asset.loadTracks(withMediaType: .video).first!
    let reader = try AVAssetReader(asset: asset)
    let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    reader.add(output)
    reader.startReading()
    var out: [(Double, Int)] = []
    while let sample = output.copyNextSampleBuffer() {
        guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
        let p = base + (CVPixelBufferGetHeight(buffer) / 2) * CVPixelBufferGetBytesPerRow(buffer) + (CVPixelBufferGetWidth(buffer) / 2) * 4
        out.append((CMSampleBufferGetPresentationTimeStamp(sample).seconds, (Int(p[0]) + Int(p[1]) + Int(p[2])) / 3))
        CVPixelBufferUnlockBaseAddress(buffer, .readOnly)
    }
    return out
}

/// A solid cover in the middle of the frame, showing from `start` to `end`.
private func middleCover(_ start: Double, _ end: Double) -> Cover {
    var cover = Cover(path: [PathSample(time: start, rect: NormRect(cx: 0.5, cy: 0.5, w: 0.25, h: 0.25 * 320 / 240))], start: start, end: end)
    LookPreset(look: .solid).apply(to: &cover)
    return cover
}

@MainActor
final class FaceBlurScreenTests: XCTestCase {
    func testShowsOnlyWithThePlugin() {
        let admin = ToolsetAccess.Me(username: "tiny", role: "admin", off: nil)
        let off = ToolsetAccess.Me(username: "helper", role: "user", off: ["blur-faces"])
        let on = ToolsetAccess.Me(username: "helper", role: "user", off: [])
        XCTAssertTrue(FaceBlurView.shows(plugins: ["blur-faces"], me: admin))
        XCTAssertTrue(FaceBlurView.shows(plugins: ["other", "blur-faces"], me: on))
        XCTAssertFalse(FaceBlurView.shows(plugins: ["blur-faces"], me: off))
        XCTAssertFalse(FaceBlurView.shows(plugins: [], me: admin))
        XCTAssertFalse(FaceBlurView.shows(plugins: ["editor-face-blur"], me: admin))
    }

    func testSettingsInTheServersWords() throws {
        let s = try JSONDecoder().decode(FaceBlurSettings.self, from: Data(#"{"mode":"some","who":"Every child's face","look":"mosaic"}"#.utf8))
        XCTAssertEqual(s, FaceBlurSettings(mode: .some, who: "Every child's face", look: .mosaic))
        let back = try JSONSerialization.jsonObject(with: JSONEncoder().encode(s)) as? [String: String]
        XCTAssertEqual(back, ["mode": "some", "who": "Every child's face", "look": "mosaic"])
        XCTAssertThrowsError(try JSONDecoder().decode(FaceBlurSettings.self, from: Data(#"{"mode":"every","who":"","look":"blur"}"#.utf8)))
        // the style built on the computer is drawn with here; a server before styles leaves today's look
        let styled = try JSONDecoder().decode(FaceBlurSettings.self, from: Data(##"{"mode":"all","who":"x","look":"solid","strength":0.7,"softness":0.2,"size":1.5,"color":"#112233","auto":true}"##.utf8))
        XCTAssertEqual([styled.preset.strength, styled.preset.softness, styled.preset.size], [0.7, 0.2, 1.5])
        XCTAssertEqual(styled.preset.colorHex, "#112233")
        XCTAssertEqual(s.preset.size, 1)
        XCTAssertNil(s.preset.softness)
    }
}

final class FaceBlurEngineTests: XCTestCase {
    /// Every frame inside the cover's span is covered, every frame outside it is the source's own, and no frame is lost.
    func testEveryFrameInTheSpanIsCovered() async throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("plain.mov"), out = dir.appendingPathComponent("plain blurred.mp4")
        try await makeVideo(source)
        let scan = FaceScan(kind: .video, covers: [middleCover(0.3, 0.7)], faces: [ScannedFace(id: "F1", picture: "", note: "")])
        try await CoverPipeline.write(scan, from: source, blur: ["F1"], to: out) { _ in }
        let frames = try await centres(out)
        XCTAssertEqual(frames.count, 30)
        for f in frames {
            if f.time > 0.31 && f.time < 0.69 { XCTAssertLessThan(f.value, 80, "uncovered at \(f.time)") }
            if f.time < 0.28 || f.time > 0.72 { XCTAssertGreaterThan(f.value, 150, "covered at \(f.time)") }
        }
        // no location (or any other source metadata) in the copy, and no partial file left beside it
        let metadata = try await AVURLAsset(url: out).load(.metadata)
        XCTAssertFalse(metadata.contains { $0.identifier == .quickTimeMetadataLocationISO6709 })
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasPrefix(".") }, [])

        // no face chosen, or none found: nothing is written
        let other = dir.appendingPathComponent("other.mp4")
        for (s, why) in [(scan, "No face chosen, nothing written"), (FaceScan(kind: .video, covers: [], faces: []), "No face found, nothing written")] {
            do {
                try await CoverPipeline.write(s, from: source, blur: [], to: other) { _ in }
                XCTFail("wrote a copy with no face covered")
            } catch let nothing as CoverPipeline.NothingToCover {
                XCTAssertEqual(nothing.why, why)
            }
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: other.path))
    }

    /// A photo: the face covered, and none of the original's metadata (location, camera, date) in the copy.
    func testPhotoIsCoveredWithoutMetadata() throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("plain.jpg"), out = dir.appendingPathComponent("plain blurred.jpg")
        let ctx = CGContext(data: nil, width: 400, height: 300, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.9, green: 0.85, blue: 0.5, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 400, height: 300))
        let dest = CGImageDestinationCreateWithURL(source as CFURL, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, [
            kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 59.437, kCGImagePropertyGPSLatitudeRef: "N"],
            kCGImagePropertyExifDictionary: [kCGImagePropertyExifDateTimeOriginal: "2026:01:02 10:00:00"],
        ] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))

        var cover = Cover(path: [PathSample(time: 0, rect: NormRect(cx: 0.5, cy: 0.5, w: 0.3, h: 0.4))], start: 0, end: 0)
        LookPreset(look: .solid).apply(to: &cover)
        let scan = FaceScan(kind: .photo, covers: [cover], faces: [ScannedFace(id: "F1", picture: "", note: "")])
        let done = expectation(description: "written")
        Task {
            try await CoverPipeline.write(scan, from: source, blur: ["F1"], to: out) { _ in }
            done.fulfill()
        }
        wait(for: [done], timeout: 30)

        let written = CGImageSourceCreateWithURL(out as CFURL, nil)!
        let props = CGImageSourceCopyPropertiesAtIndex(written, 0, nil) as! [CFString: Any]
        XCTAssertNil(props[kCGImagePropertyGPSDictionary])
        XCTAssertNil((props[kCGImagePropertyExifDictionary] as? [CFString: Any])?[kCGImagePropertyExifDateTimeOriginal])
        let image = CGImageSourceCreateImageAtIndex(written, 0, nil)!
        let pixels = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                               bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        pixels.draw(image.cropping(to: CGRect(x: 200, y: 150, width: 1, height: 1))!, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        let p = pixels.data!.assumingMemoryBound(to: UInt8.self)
        XCTAssertLessThan(Int(p[0]), 80)
    }

}
