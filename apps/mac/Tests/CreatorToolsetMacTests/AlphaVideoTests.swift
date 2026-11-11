import AVFoundation
import XCTest
@testable import CreatorToolsetMac

/// The see-through video of the screen recording editor (AlphaVideo.swift): the packed download's name, its halves,
/// one frame joined by hand, and a small packed file converted for real.
final class AlphaVideoTests: XCTestCase {
    /// What `progress` was told, in order.
    private final class Parts: @unchecked Sendable {
        private let lock = NSLock()
        private var told: [Double] = []
        var all: [Double] { lock.withLock { told } }
        func add(_ part: Double) { lock.withLock { told.append(part) } }
    }

    func testOnlyAPackedDownloadIsTakenAndItsNameSaysHowItIsPacked() {
        XCTAssertTrue(alphaDownload(named: "Demo (transparent).stacked.ctalpha.mp4")! == ("Demo (transparent)", true))
        XCTAssertTrue(alphaDownload(named: "a.b.beside.ctalpha.mp4")! == ("a.b", false))
        XCTAssertNil(alphaDownload(named: "Demo (zoomed).mp4"))
        XCTAssertNil(alphaDownload(named: "Demo.ctalpha.mp4"))            // no word for how: an ordinary download
        XCTAssertNil(alphaDownload(named: ".stacked.ctalpha.mp4"))
    }

    func testTheFrameInsideAPackedPicture() {
        // the same cases as the page's alphaPacking (screen-recording.test.ts), which packs them: frame, how, packed
        let cases: [(Int, Int, Bool, Int, Int)] = [
            (1920, 1080, true, 1920, 2160),
            (1080, 1920, false, 2160, 1920),
            (1080, 1080, true, 1080, 2160),
            (1080, 1124, false, 2160, 1124),
            (1080, 1350, false, 2160, 1350),
            (2160, 1080, true, 2160, 2160),
            (1080, 2160, false, 2160, 2160),   // the same packed picture as the one above: only the name tells them apart
        ]
        for (w, h, stacked, pw, ph) in cases {
            XCTAssertTrue(alphaFrame(stacked: stacked, width: pw, height: ph)! == (w, h), "\(pw)×\(ph)")
        }
        XCTAssertNil(alphaFrame(stacked: true, width: 100, height: 99))
        XCTAssertNil(alphaFrame(stacked: false, width: 99, height: 100))
        XCTAssertNil(alphaFrame(stacked: true, width: 0, height: 0))
    }

    func testTheRoomAVideoNeedsIsNearWhatOneTook() {
        // the real 15 s export: 906 frames of 1080×1124 came to 687 MB
        XCTAssertEqual(Double(alphaVideoBytes(width: 1080, height: 1124, frames: 906)), 687e6, accuracy: 70e6)
        // the sizes are written the way this Mac writes them ("2.9 GB", "2,9 GB")
        let size = { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) }
        XCTAssertEqual(
            AlphaVideoError.noRoom(need: 2_900_000_000, free: 1_200_000_000).errorDescription,
            "it needs about \(size(2_900_000_000)) and this disk has \(size(1_200_000_000)) free")
    }

    /// A BGRA buffer filled by `pixel(x, y)` = (blue, green, red, alpha).
    private func buffer(_ w: Int, _ h: Int, _ pixel: (Int, Int) -> (UInt8, UInt8, UInt8, UInt8)) -> CVPixelBuffer {
        var made: CVPixelBuffer?
        CVPixelBufferCreate(nil, w, h, kCVPixelFormatType_32BGRA, [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &made)
        let b = made!
        CVPixelBufferLockBaseAddress(b, [])
        let p = CVPixelBufferGetBaseAddress(b)!.assumingMemoryBound(to: UInt8.self)
        let rows = CVPixelBufferGetBytesPerRow(b)
        for y in 0..<h {
            for x in 0..<w {
                let (blue, green, red, alpha) = pixel(x, y)
                let at = p + y * rows + x * 4
                (at[0], at[1], at[2], at[3]) = (blue, green, red, alpha)
            }
        }
        CVPixelBufferUnlockBaseAddress(b, [])
        return b
    }

    private func pixel(_ b: CVPixelBuffer, _ x: Int, _ y: Int) -> [Int] {
        CVPixelBufferLockBaseAddress(b, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(b, .readOnly) }
        let at = CVPixelBufferGetBaseAddress(b)!.assumingMemoryBound(to: UInt8.self) + y * CVPixelBufferGetBytesPerRow(b) + x * 4
        return [Int(at[0]), Int(at[1]), Int(at[2]), Int(at[3])]
    }

    // The test picture, 8 wide and 4 high or the other way round. Each corner of the frame has its own colour, a
    // different amount in each channel, and its own matte, so a swapped channel or a turned half shows:
    // top left opaque, top right half see-through, bottom left clear, bottom right a colour brighter than its matte.
    private let colours: [[(UInt8, UInt8, UInt8)]] = [[(10, 60, 200), (20, 90, 120)], [(0, 0, 0), (90, 30, 250)]]
    private let mattes: [[UInt8]] = [[255, 128], [0, 40]]

    private func packed(frameW: Int, frameH: Int, stacked: Bool) -> CVPixelBuffer {
        buffer(stacked ? frameW : frameW * 2, stacked ? frameH * 2 : frameH) { x, y in
            let inMatte = stacked ? y >= frameH : x >= frameW
            let (fx, fy) = (stacked ? x : x % frameW, stacked ? y % frameH : y)
            let (row, col) = (fy * 2 / frameH, fx * 2 / frameW)
            if inMatte { let m = self.mattes[row][col]; return (m, m, m, 255) }
            let c = self.colours[row][col]
            return (c.0, c.1, c.2, 255)
        }
    }

    func testAFrameIsItsColoursWithTheOtherHalfAsAlpha() throws {
        for (w, h, stacked) in [(8, 4, true), (4, 8, false)] {
            let frame = buffer(w, h) { _, _ in (7, 7, 7, 7) }
            try joinAlpha(packed(frameW: w, frameH: h, stacked: stacked), into: frame, stacked: stacked)
            XCTAssertEqual(pixel(frame, 0, 0), [10, 60, 200, 255], "opaque, stacked \(stacked)")
            XCTAssertEqual(pixel(frame, w - 1, 0), [20, 90, 120, 128], "half see-through")
            XCTAssertEqual(pixel(frame, 0, h - 1), [0, 0, 0, 0], "clear")
            XCTAssertEqual(pixel(frame, w - 1, h - 1), [40, 30, 40, 40], "no colour brighter than its alpha")
        }
        // a frame of another size than the packed picture's half is refused
        XCTAssertThrowsError(try joinAlpha(packed(frameW: 8, frameH: 4, stacked: true), into: buffer(8, 8) { _, _ in (0, 0, 0, 0) }, stacked: true))
    }

    /// A packed H.264 file like the page's: `frames` pictures at 30 a second, and one second of silence as AAC.
    private func writePacked(to file: URL, frameW: Int, frameH: Int, stacked: Bool, frames: Int) async throws {
        let (w, h) = (stacked ? frameW : frameW * 2, stacked ? frameH * 2 : frameH)
        let writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: w, AVVideoHeightKey: h,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 4_000_000],
            // said, as the page's file says it: a small picture with nothing said is read as another kind of colour
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: nil)
        let sound = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 1, AVEncoderBitRateKey: 64_000,
        ])
        writer.add(video)
        writer.add(sound)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        let picture = packed(frameW: frameW, frameH: frameH, stacked: stacked)
        for i in 0..<frames {
            while !video.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
            XCTAssertTrue(adaptor.append(picture, withPresentationTime: CMTime(value: CMTimeValue(i), timescale: 30)))
        }
        video.markAsFinished()
        var format = AudioStreamBasicDescription(
            mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2, mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var description: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &format, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description)
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: 96_000, blockAllocator: nil, customBlockSource: nil, offsetToData: 0, dataLength: 96_000, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &block)
        CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: 96_000)
        var silence: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block!, formatDescription: description!, sampleCount: 48_000, presentationTimeStamp: .zero, packetDescriptions: nil, sampleBufferOut: &silence)
        while !sound.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 2_000_000) }
        XCTAssertTrue(sound.append(silence!))
        sound.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
    }

    func testAPackedFileBecomesASeeThroughVideoWithItsSound() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        // the two ways of packing give the same 256×256 picture here: the frames differ, as the name says
        for (w, h, stacked) in [(256, 128, true), (128, 256, false)] {
            let from = folder.appendingPathComponent("in-\(stacked).mp4")
            try await writePacked(to: from, frameW: w, frameH: h, stacked: stacked, frames: 30)
            let made = folder.appendingPathComponent("Demo.mov")
            try Data().write(to: made)   // a file with that name is replaced: the Save dialog asked
            let parts = Parts()
            try await makeAlphaVideo(packed: from, stacked: stacked, to: made) { parts.add($0) }
            // nothing but the video is left in the folder it was made in, and the page heard how far it was
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), ["Demo.mov"])
            XCTAssertEqual(parts.all, parts.all.sorted())
            XCTAssertEqual(parts.all.last, 0.99)

            let asset = AVURLAsset(url: made)
            let track = try await asset.loadTracks(withMediaType: .video).first!
            let size = try await track.load(.naturalSize)
            XCTAssertTrue((Int(size.width), Int(size.height)) == (w, h))
            let format = try await track.load(.formatDescriptions).first!
            XCTAssertEqual(CMFormatDescriptionGetMediaSubType(format), kCMVideoCodecType_AppleProRes4444)
            let sounds = try await asset.loadTracks(withMediaType: .audio).count
            let seconds = try await asset.load(.duration).seconds
            XCTAssertEqual(sounds, 1)
            XCTAssertEqual(seconds, 1, accuracy: 0.1)

            // read back with its alpha: every corner of the frame as it was packed (two encoders on the way: ±3)
            let reader = try AVAssetReader(asset: asset)
            let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            reader.add(out)
            XCTAssertTrue(reader.startReading())
            var count = 0
            var last: CVPixelBuffer?
            while let sample = out.copyNextSampleBuffer() {
                if let picture = CMSampleBufferGetImageBuffer(sample) { last = picture; count += 1 }
            }
            XCTAssertEqual(count, 30)
            let near = { (got: [Int], want: [Int], what: String) in
                XCTAssertTrue(zip(got, want).allSatisfy { abs($0 - $1) <= 3 }, "\(what), stacked \(stacked): \(got) is not \(want)")
            }
            let frame = try XCTUnwrap(last)
            near(pixel(frame, w / 4, h / 4), [10, 60, 200, 255], "opaque")
            near(pixel(frame, w * 3 / 4, h / 4), [20, 90, 120, 128], "half see-through")
            near(pixel(frame, w / 4, h * 3 / 4), [0, 0, 0, 0], "clear")
            near(pixel(frame, w * 3 / 4, h * 3 / 4), [40, 30, 40, 40], "clipped to its alpha")
        }
    }

    func testAVideoThatIsStoppedLeavesNothingBehind() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let from = folder.appendingPathComponent("in.mp4")
        try await writePacked(to: from, frameW: 256, frameH: 128, stacked: true, frames: 30)
        let making = Task { try await makeAlphaVideo(packed: from, stacked: true, to: folder.appendingPathComponent("Demo.mov")) }
        making.cancel()
        do {
            try await making.value
            XCTFail("it should have stopped")
        } catch {
            XCTAssertTrue(making.isCancelled)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [])
    }

    func testAFileStillBeingMadeHasANameOfItsOwnBesideTheVideo() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let final = folder.appendingPathComponent("Demo (transparent).mov")
        XCTAssertEqual(alphaWorkFile(beside: final, ext: "mp4").path, folder.appendingPathComponent("Demo (transparent) (being made).mp4").path)
        try Data().write(to: folder.appendingPathComponent("Demo (transparent) (being made).mov"))   // left by a run that was cut off
        XCTAssertEqual(alphaWorkFile(beside: final, ext: "mov").lastPathComponent, "Demo (transparent) (being made) (2).mov")
    }

    func testAFileThatIsNoVideoLeavesNothingBehind() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let from = folder.appendingPathComponent("in.mp4")
        try Data("not a video".utf8).write(to: from)
        do {
            try await makeAlphaVideo(packed: from, stacked: true, to: folder.appendingPathComponent("Demo.mov"))
            XCTFail("it should have failed")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path), [])
    }
}
