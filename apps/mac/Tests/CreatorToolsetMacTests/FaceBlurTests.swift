import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CreatorToolsetMac

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

final class FaceBlurAskTests: XCTestCase {
    func testAsks() {
        XCTAssertEqual(faceBlurAsk("faceblur:hello"), .hello)
        XCTAssertEqual(faceBlurAsk(#"faceblur:start:{"files":["/Users/a/b: c.mov"],"mode":"some","look":"mosaic"}"#),
                       .start(files: ["/Users/a/b: c.mov"], mode: .some, style: LookPreset(look: .mosaic)))
        XCTAssertEqual(faceBlurAsk(##"faceblur:start:{"files":["/a.mov"],"mode":"all","look":"solid","size":1.5,"softness":0.2,"strength":0.9,"color":"#ff0000"}"##),
                       .start(files: ["/a.mov"], mode: .all, style: LookPreset(look: .solid, values: ["size": 1.5, "softness": 0.2, "strength": 0.9, "color": "#ff0000"])))
        XCTAssertEqual(faceBlurAsk(#"faceblur:try:{"picture":"AAAA","look":"blur","blur":["F1"]}"#),
                       .trial(picture: "AAAA", path: nil, style: LookPreset(), blur: ["F1"], facesOnly: false))
        XCTAssertEqual(faceBlurAsk(#"faceblur:try:{"path":"/a.jpg","look":"mosaic","facesOnly":true}"#),
                       .trial(picture: nil, path: "/a.jpg", style: LookPreset(look: .mosaic), blur: nil, facesOnly: true))
        XCTAssertNil(faceBlurAsk(#"faceblur:try:{"look":"blur"}"#))
        XCTAssertNil(faceBlurAsk(#"faceblur:try:{"picture":"AAAA","path":"/a.jpg","look":"blur"}"#))
        XCTAssertEqual(faceBlurAsk(#"faceblur:choose:{"job":"j","path":"/x.jpg","blur":["F2"]}"#), .choose(job: "j", path: "/x.jpg", blur: ["F2"]))
        XCTAssertEqual(faceBlurAsk(#"faceblur:choose:{"job":"j","path":"/x.jpg","blur":[],"error":"No AI is connected."}"#),
                       .choose(job: "j", path: "/x.jpg", blur: [], error: "No AI is connected."))
        XCTAssertEqual(faceBlurAsk(#"faceblur:choose:{"job":"j","path":"/x.jpg","blur":[],"error":""}"#), .choose(job: "j", path: "/x.jpg", blur: []))
        XCTAssertEqual(faceBlurAsk("faceblur:state:j1"), .state(job: "j1"))
        XCTAssertEqual(faceBlurAsk(#"faceblur:faces:{"job":"j1","path":"/x.jpg"}"#), .faces(job: "j1", path: "/x.jpg"))
        XCTAssertNil(faceBlurAsk(#"faceblur:faces:{"job":"j1"}"#))
        XCTAssertEqual(faceBlurAsk("faceblur:cancel:j1"), .cancel(job: "j1"))
        XCTAssertEqual(faceBlurAsk("faceblur:show:/a/b:c.mp4"), .show(path: "/a/b:c.mp4"))
        // malformed or unknown: nil
        XCTAssertNil(faceBlurAsk(#"faceblur:start:{"files":["/a.mov"],"mode":"every","look":"blur"}"#))
        XCTAssertNil(faceBlurAsk(#"faceblur:start:{"files":[],"mode":"all","look":"blur"}"#))
        XCTAssertNil(faceBlurAsk(#"faceblur:start:{"files":["/a.mov"],"mode":"all","look":"emoji"}"#))
        XCTAssertEqual(faceBlurAsk("faceblur:pick"), .pick)
        XCTAssertNil(faceBlurAsk("faceblur:pick:x"))
        XCTAssertNil(faceBlurAsk("faceblur:state"))
        XCTAssertNil(faceBlurAsk("faceblur:hello:x"))
        XCTAssertNil(faceBlurAsk("faceblur:delete:/a"))
        XCTAssertNil(faceBlurAsk("plugin:on:x"))
    }

    func testOutputNames() {
        let source = URL(fileURLWithPath: "/Movies/Beach day.MOV")
        XCTAssertEqual(CoverPipeline.outputURL(for: source, kind: .video, exists: { _ in false }).path, "/Movies/Beach day blurred.mp4")
        let taken: Set<String> = ["/Movies/Beach day blurred.mp4", "/Movies/Beach day blurred 2.mp4"]
        XCTAssertEqual(CoverPipeline.outputURL(for: source, kind: .video, exists: taken.contains).path, "/Movies/Beach day blurred 3.mp4")
        XCTAssertEqual(CoverPipeline.outputURL(for: URL(fileURLWithPath: "/P/a.heic"), kind: .photo, exists: { _ in false }).path, "/P/a blurred.jpg")
    }

    func testRefusals() throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let photo = dir.appendingPathComponent("p.jpg"), text = dir.appendingPathComponent("t.txt")
        try Data([0xFF]).write(to: photo)
        try Data("x".utf8).write(to: text)
        XCTAssertNil(FaceBlurJobs.refusal([photo.path], allowed: [photo.path]))
        XCTAssertEqual(FaceBlurJobs.refusal([photo.path], allowed: []), "Pick p.jpg in this app first: Face Blur takes only files chosen or dropped here.")
        XCTAssertEqual(FaceBlurJobs.refusal([text.path], allowed: [text.path]), "t.txt isn't a photo or a video.")
        XCTAssertEqual(FaceBlurJobs.refusal([dir.path], allowed: [dir.path]), "\(dir.lastPathComponent) can't be read.")
    }
}

final class FaceBlurEngineTests: XCTestCase {
    /// A cover fades in over its lead hold and out over its tail hold, and is whole while the face is tracked.
    func testCoverFadesInAndOut() {
        let r = NormRect(cx: 0.5, cy: 0.5, w: 0.1, h: 0.1)
        let cover = Cover(path: [PathSample(time: 1, rect: r), PathSample(time: 2, rect: r)], start: 0.75, end: 2.25)
        XCTAssertEqual(cover.opacity(at: 0.75), 0, accuracy: 1e-9)
        XCTAssertEqual(cover.opacity(at: 0.875), 0.5, accuracy: 1e-9)
        XCTAssertEqual(cover.opacity(at: 1.5), 1, accuracy: 1e-9)
        XCTAssertEqual(cover.opacity(at: 2.125), 0.5, accuracy: 1e-9)
        // a cover that starts with the clip is whole from its first frame, and a longer hold stays whole
        XCTAssertEqual(Cover(path: [PathSample(time: 1, rect: r)], start: 1, end: 1.7).opacity(at: 1.6), 1, accuracy: 1e-9)
        XCTAssertEqual(Cover(path: [PathSample(time: 0, rect: r)], start: 0, end: 0.25).opacity(at: 0), 1, accuracy: 1e-9)
    }

    /// One face moving slowly across a second, plus a one-frame flicker elsewhere: one track, start to end.
    func testTracksFromDetections() {
        let frame = CGSize(width: 640, height: 480)
        let builder = TrackBuilder(frame: frame)
        for f in 0..<30 {
            let t = Double(f) / 30
            var faces = [FaceDetection(rect: NormRect(cx: 0.3 + t * 0.1, cy: 0.4, w: 0.12, h: 0.16), angle: 0, score: 0.9)]
            if f == 12 { faces.append(FaceDetection(rect: NormRect(cx: 0.8, cy: 0.8, w: 0.05, h: 0.07), angle: 0, score: 0.6)) }
            builder.ingest(time: t, detections: faces)
        }
        let covers = builder.covers(scanStart: 0, scanEnd: 1, preset: LookPreset())
        XCTAssertEqual(covers.count, 1)
        XCTAssertEqual(covers[0].start, 0)
        XCTAssertEqual(covers[0].end, 1)
        // a cover at every moment of the track, around the face
        for f in 0...30 {
            let at = covers[0].placement(at: Double(f) / 30)
            XCTAssertNotNil(at)
            XCTAssertEqual(at!.rect.cx, 0.3 + Double(min(f, 29)) / 300, accuracy: 0.02)
        }
        XCTAssertEqual(CoverPipeline.note(covers[0], kind: .video), "middle centre of the frame; 10% of its width; seen for 1.0 s")
        XCTAssertEqual(CoverPipeline.moments(covers[0]).count, 3)
    }

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

        // no face chosen: nothing is written, the copy is as it was
        do {
            try await CoverPipeline.write(scan, from: source, blur: [], to: out) { _ in }
            XCTFail("wrote a copy with no face covered")
        } catch let nothing as CoverPipeline.NothingToCover {
            XCTAssertEqual(nothing.why, "No face chosen, nothing written")
        }
        let after = try await centres(out)
        XCTAssertEqual(after.filter { $0.value < 80 }.count, frames.filter { $0.value < 80 }.count)
        // no face found at all
        let none = FaceScan(kind: .video, covers: [], faces: [])
        let other = dir.appendingPathComponent("none blurred.mp4")
        do {
            try await CoverPipeline.write(none, from: source, blur: [], to: other) { _ in }
            XCTFail("wrote a copy of a file with no face")
        } catch let nothing as CoverPipeline.NothingToCover {
            XCTAssertEqual(nothing.why, "No face found, nothing written")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: other.path))
    }

    /// The state the page polls carries no face pictures; the faces ask does.
    @MainActor
    func testPicturesOnlyWhenAsked() {
        var item = FaceBlurJobs.Item(path: "/a.jpg")
        item.scan = FaceScan(kind: .photo, covers: [middleCover(0, 0)], faces: [ScannedFace(id: "F1", picture: "abc", note: "n")])
        item.blur = ["F1"]
        let light = (FaceBlurJobs.reply(item)["faces"] as? [[String: Any]])?.first
        XCTAssertNil(light?["picture"])
        XCTAssertEqual(light?["blur"] as? Bool, true)
        XCTAssertEqual((FaceBlurJobs.reply(item, pictures: true)["faces"] as? [[String: Any]])?.first?["picture"] as? String, "abc")
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

    /// A face's picture is a JPEG under the cap, its crops side by side.
    func testFacePicture() throws {
        let ctx = CGContext(data: nil, width: 640, height: 480, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.9, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 640, height: 480))
        let frame = ctx.makeImage()!
        let crop = CoverPipeline.crop(frame, NormRect(cx: 0.95, cy: 0.5, w: 0.2, h: 0.2 * 640 / 480))
        XCTAssertLessThanOrEqual(crop.width, 128)   // stopped at the frame's edge
        let data = try XCTUnwrap(Data(base64Encoded: CoverPipeline.picture([crop, crop, crop])))
        XCTAssertLessThanOrEqual(data.count, CoverPipeline.maxPictureBytes)
        let image = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(data as CFData, nil)!, 0, nil)!
        XCTAssertEqual(image.width, 3 * CoverPipeline.tile)
    }

    /// The page's road on this Mac: start, read the state until done. The video drawn here has no face: it is done
    /// straight away even in "some" mode, says so, and nothing is written beside it.
    @MainActor
    func testJobWritesTheCopy() async throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let source = dir.appendingPathComponent("plain.mov")
        try await makeVideo(source, frames: 10)
        let jobs = FaceBlurJobs()
        let start = jobs.answer(#"faceblur:start:{"files":["\#(source.path)"],"mode":"some","look":"blur"}"#, allowed: [source.path])
        let job = try XCTUnwrap(start["job"] as? String)
        var state: [String: Any] = [:]
        for _ in 0..<600 {
            state = jobs.answer("faceblur:state:\(job)", allowed: [])
            if state["done"] as? Bool == true { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let item = try XCTUnwrap((state["items"] as? [[String: Any]])?.first)
        XCTAssertEqual(item["stage"] as? String, "done", "\(item)")
        XCTAssertNil(item["out"])
        XCTAssertEqual(item["note"] as? String, "No face found, nothing written")
        XCTAssertEqual((item["faces"] as? [Any])?.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: dir.appendingPathComponent("plain blurred.mp4").path))
        XCTAssertNotNil(jobs.answer("faceblur:choose:{\"job\":\"nope\",\"path\":\"/x\",\"blur\":[]}", allowed: [])["problem"])
    }
}

final class FaceBlurStyleTests: XCTestCase {
    /// The settings' values, as numbers or as a device job's text; out of range or missing keeps the default.
    func testStyleFromValues() {
        let style = LookPreset(values: ["look": "mosaic", "strength": "0.9", "softness": 0.1, "size": 1.6, "color": "#00ff00"])
        XCTAssertEqual([style.look.rawValue, style.colorHex], ["mosaic", "#00ff00"])
        XCTAssertEqual([style.strength, style.softness, style.size], [0.9, 0.1, 1.6])
        let wild = LookPreset(values: ["look": "emoji", "strength": 4, "softness": "x", "size": 9, "color": "red"])
        XCTAssertEqual(wild, LookPreset())
        var cover = Cover(path: [PathSample(time: 0, rect: NormRect(cx: 0.5, cy: 0.5, w: 0.2, h: 0.2))], start: 0, end: 0)
        LookPreset(look: .solid).apply(to: &cover)
        XCTAssertEqual(cover.softness, 0)
        LookPreset(look: .blur).apply(to: &cover)
        XCTAssertEqual(cover.softness, 0.45)
        LookPreset(look: .solid, values: ["softness": 0.3, "size": 1.5]).apply(to: &cover)
        XCTAssertEqual(cover.softness, 0.3)
        XCTAssertEqual(cover.placement(at: 0)!.rect.w, 0.3, accuracy: 1e-9)
    }

    /// Size draws a bigger cover: a point just outside the face's own circle is covered at 1.5 and not at 1.
    func testSizeIsDrawn() {
        let frame = CIImage(color: CIColor(red: 1, green: 1, blue: 1)).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 200))
        func covered(size: Double) -> Bool {
            var cover = Cover(path: [PathSample(time: 0, rect: NormRect(cx: 0.5, cy: 0.5, w: 0.3, h: 0.3))], start: 0, end: 0)
            LookPreset(look: .solid, values: ["size": size, "color": "#000000"]).apply(to: &cover)
            let out = CoverRenderer.shared.render(frame, covers: [cover], time: 0)
            // 40 px right of the centre: outside a 60 px circle, inside a 90 px one
            var pixel = [UInt8](repeating: 0, count: 4)
            CIContext().render(out, toBitmap: &pixel, rowBytes: 4, bounds: CGRect(x: 140, y: 100, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
            return pixel[0] < 80
        }
        XCTAssertFalse(covered(size: 1))
        XCTAssertTrue(covered(size: 1.5))
    }

    /// A test run's pictures: the photo covered in the style, a video's three moments, and nothing written beside the file.
    func testFramesWriteNothing() async throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let video = dir.appendingPathComponent("plain.mov")
        try await makeVideo(video, frames: 30)
        let cover = middleCover(0, 1)
        let scan = FaceScan(kind: .video, covers: [cover], faces: [ScannedFace(id: "F1", picture: "", note: "")])
        let frames = try await CoverPipeline.frames(scan, from: video, blur: ["F1"], style: LookPreset(look: .solid, values: ["color": "#000000"]))
        XCTAssertFalse(frames.isEmpty)
        XCTAssertLessThanOrEqual(frames.count, 3)
        for frame in frames {
            let image = CGImageSourceCreateImageAtIndex(CGImageSourceCreateWithData(Data(base64Encoded: frame)! as CFData, nil)!, 0, nil)!
            let pixels = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                   bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
            pixels.draw(image.cropping(to: CGRect(x: image.width / 2, y: image.height / 2, width: 1, height: 1))!, in: CGRect(x: 0, y: 0, width: 1, height: 1))
            XCTAssertLessThan(Int(pixels.data!.assumingMemoryBound(to: UInt8.self)[0]), 80)
        }
        // none chosen: the frames show it as it is
        let plain = try await CoverPipeline.frames(scan, from: video, blur: [], style: LookPreset())
        XCTAssertEqual(plain.count, 3)
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), ["plain.mov"])
    }

    /// A test run on a picture the page sent, and on a file not picked here (refused).
    func testTrialAsks() async throws {
        let ctx = CGContext(data: nil, width: 300, height: 200, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.4, green: 0.7, blue: 0.9, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: 300, height: 200))
        let data = NSMutableData()
        let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(dest, ctx.makeImage()!, nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        let picture = (data as Data).base64EncodedString()
        let ask = faceBlurAsk(#"faceblur:try:{"picture":"\#(picture)","look":"blur"}"#)!
        let reply = await FaceBlurTrial.shared.answer(ask, allowed: [])
        XCTAssertNil(reply["problem"], "\(reply)")
        XCTAssertEqual(reply["kind"] as? String, "photo")
        XCTAssertEqual((reply["faces"] as? [Any])?.count, 0)
        XCTAssertEqual((reply["frames"] as? [String])?.count, 1)
        let refused = await FaceBlurTrial.shared.answer(faceBlurAsk(#"faceblur:try:{"path":"/etc/hosts","look":"blur"}"#)!, allowed: [])
        XCTAssertNotNil(refused["problem"])
        let bad = await FaceBlurTrial.shared.answer(faceBlurAsk(#"faceblur:try:{"picture":"not base64!","look":"blur"}"#)!, allowed: [])
        XCTAssertNotNil(bad["problem"])
    }

    func testTheWriterTakesTheChosenSizeAndBitrate() {
        // a 4K upright clip: 1920 on its long side, as filmed when that is smaller, never larger
        XCTAssertEqual(CoverExporter.frameSize(CGSize(width: 2160, height: 3840), longSide: 1920), CGSize(width: 1080, height: 1920))
        XCTAssertEqual(CoverExporter.frameSize(CGSize(width: 2160, height: 3840), longSide: 3840), CGSize(width: 2160, height: 3840))
        XCTAssertEqual(CoverExporter.frameSize(CGSize(width: 1080, height: 1920), longSide: 3840), CGSize(width: 1080, height: 1920))
        let settings = CoverExporter.videoSettings(size: CGSize(width: 1080, height: 1920), bitrate: 35_000_000)
        XCTAssertEqual(settings[AVVideoWidthKey] as? Int, 1080)
        XCTAssertEqual(settings[AVVideoHeightKey] as? Int, 1920)
        XCTAssertEqual((settings[AVVideoCompressionPropertiesKey] as? [String: Any])?[AVVideoAverageBitRateKey] as? Int, 35_000_000)
    }
}
