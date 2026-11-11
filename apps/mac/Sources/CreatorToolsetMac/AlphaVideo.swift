// A see-through video from the screen recording editor: the recording's window with nothing behind it, to lay over
// other video in an editing program. H.264 has no transparency and nothing of a recording may leave this Mac, so the
// page (apps/captions src/lib/screen-export.ts) renders every frame twice into one H.264 picture, its colours over
// black and its matte (white where the frame is opaque, black where it is clear), and saves that as a download named
// "<name>.stacked.ctalpha.mp4" (colours above the matte) or "<name>.beside.ctalpha.mp4" (colours left of it).
// Shell.swift asks where the video goes, keeps the download in that folder and hands it here: the halves become
// frames with an alpha channel (premultiplied, as colours over black already are), written as ProRes 4444 in a .mov
// with the sound. It is large (about 3 GB a minute), so all of it is written on the disk that was chosen.
import Accelerate
import AVFoundation

enum AlphaVideoError: LocalizedError {
    case noVideo
    case notTwoHalves(Int, Int)
    case noFrame
    case noRoom(need: Int64, free: Int64)

    var errorDescription: String? {
        switch self {
        case .noVideo: return "the file from the editor has no picture"
        case .notTwoHalves(let w, let h): return "the file from the editor is not two halves (\(w)×\(h))"
        case .noFrame: return "a frame could not be made"
        case .noRoom(let need, let free):
            let size = { ByteCountFormatter.string(fromByteCount: $0, countStyle: .file) }
            return "it needs about \(size(need)) and this disk has \(size(free)) free"
        }
    }
}

/// A packed download by its name: what the finished video is called (no extension) and how its halves lie. nil for
/// any other download. The name says how, because the picture's shape cannot: 2160×1920 is a tall frame side by
/// side, or a very wide one stacked.
func alphaDownload(named name: String) -> (name: String, stacked: Bool)? {
    for (ending, stacked) in [(".stacked.ctalpha.mp4", true), (".beside.ctalpha.mp4", false)]
    where name.hasSuffix(ending) && name.count > ending.count {
        return (String(name.dropLast(ending.count)), stacked)
    }
    return nil
}

/// The frame inside a packed picture: half its height when stacked, half its width when side by side. nil when the
/// picture has no two equal halves. The other way round is `alphaPacking` in the page's src/lib/screen-recording.ts.
func alphaFrame(stacked: Bool, width: Int, height: Int) -> (width: Int, height: Int)? {
    let split = stacked ? height : width
    guard width > 0, height > 0, split % 2 == 0 else { return nil }
    return stacked ? (width, height / 2) : (width / 2, height)
}

/// About the bytes the finished video takes: ProRes 4444 runs near 5.3 bits a pixel a frame, whatever is in the
/// picture (measured here: 5.0 on a full 1080×1124 frame, 2.7 GB a minute at 60 frames a second).
/// ponytail: the format's nominal rate, not this recording's; ask the encoder if the guess turns people away wrongly
func alphaVideoBytes(width: Int, height: Int, frames: Double) -> Int64 {
    Int64(Double(width * height) * frames * 5.3 / 8)
}

/// One frame from one packed picture, both BGRA: the colours from the first half, the alpha from the other half's
/// brightness, as it is. Measured on a real export read here (906 frames): the matte is 255 all over the window and
/// 0 in the clear corner, so it needs no correcting. A colour is never left brighter than its alpha (in 435 clear
/// pixels of those frames the encoder left a 1 or a 2, which would glow).
func joinAlpha(_ packed: CVPixelBuffer, into frame: CVPixelBuffer, stacked: Bool) throws {
    CVPixelBufferLockBaseAddress(packed, .readOnly)
    CVPixelBufferLockBaseAddress(frame, [])
    defer {
        CVPixelBufferUnlockBaseAddress(frame, [])
        CVPixelBufferUnlockBaseAddress(packed, .readOnly)
    }
    let w = CVPixelBufferGetWidth(frame)
    let h = CVPixelBufferGetHeight(frame)
    guard let size = alphaFrame(stacked: stacked, width: CVPixelBufferGetWidth(packed), height: CVPixelBufferGetHeight(packed)),
          size == (w, h), let from = CVPixelBufferGetBaseAddress(packed), let to = CVPixelBufferGetBaseAddress(frame)
    else { throw AlphaVideoError.noFrame }
    let rows = CVPixelBufferGetBytesPerRow(packed)
    let pixels = (height: vImagePixelCount(h), width: vImagePixelCount(w))
    var colours = vImage_Buffer(data: from, height: pixels.height, width: pixels.width, rowBytes: rows)
    var matte = vImage_Buffer(data: from + (stacked ? h * rows : w * 4), height: pixels.height, width: pixels.width, rowBytes: rows)
    var out = vImage_Buffer(data: to, height: pixels.height, width: pixels.width, rowBytes: CVPixelBufferGetBytesPerRow(frame))
    var alpha = vImage_Buffer()
    guard vImageBuffer_Init(&alpha, pixels.height, pixels.width, 8, vImage_Flags(kvImageNoFlags)) == kvImageNoError else { throw AlphaVideoError.noFrame }
    defer { free(alpha.data) }
    let plain = vImage_Flags(kvImageNoFlags)
    vImageExtractChannel_ARGB8888(&matte, &alpha, 1, plain)   // the matte is grey: its green is its brightness
    vImageOverwriteChannels_ARGB8888(&alpha, &colours, &out, 0x1, plain)   // 0x1: the fourth byte, BGRA's alpha
    vImageClipToAlpha_RGBA8888(&out, &out, plain)
}

/// The tracks being written at once: the wait is over when each has no more to give, or at the first failure. Not
/// when all have left: once the writer has failed, a track waiting to be asked for more is never asked again.
private final class Feeding: @unchecked Sendable {
    private let lock = NSLock()
    private var open = 0
    private var error: Error?
    private var over: (() -> Void)?
    var failure: Error? { lock.withLock { error } }
    func enter() { lock.withLock { open += 1 } }
    /// Ends the wait from outside (Stop): the tracks see the failure and give no more.
    func stop(_ failed: Error) {
        lock.withLock {
            if error == nil { error = failed }
            over?()
            over = nil
        }
    }
    func leave(_ failed: Error? = nil) {
        lock.withLock {
            open -= 1
            if error == nil { error = failed }
            if open == 0 || error != nil { over?(); over = nil }
        }
    }
    func wait() async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            lock.withLock { if open == 0 || error != nil { done.resume() } else { over = { done.resume() } } }
        }
    }
}

/// A writer's input on its way to the one queue that fills it.
private struct Handed: @unchecked Sendable { let input: AVAssetWriterInput }

/// The packed file at `packed` as a ProRes 4444 .mov at `output`: every frame joined from its halves, the sound
/// copied as it is. `progress` hears how far it is (0 to 1, once a percent). Throws with nothing left at `output`,
/// also when its task is cancelled.
func convertAlphaVideo(packed: URL, stacked: Bool, output: URL, progress: (@Sendable (Double) -> Void)? = nil) async throws {
    let asset = AVURLAsset(url: packed)
    guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw AlphaVideoError.noVideo }
    let natural = try await track.load(.naturalSize)
    guard let size = alphaFrame(stacked: stacked, width: Int(natural.width), height: Int(natural.height)) else {
        throw AlphaVideoError.notTwoHalves(Int(natural.width), Int(natural.height))
    }
    // a disk without the room is not filled to find that out
    let count = try await asset.load(.duration).seconds * Double(try await track.load(.nominalFrameRate))
    let need = alphaVideoBytes(width: size.width, height: size.height, frames: count)
    let room = try? output.deletingLastPathComponent().resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
    // (a disk that does not say how much it has free answers 0: not known, so not refused)
    if let free = room?.volumeAvailableCapacityForImportantUsage, free > 0, free < need { throw AlphaVideoError.noRoom(need: need, free: free) }
    let reader = try AVAssetReader(asset: asset)
    let frames = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    frames.alwaysCopiesSampleData = false
    reader.add(frames)

    let writer = try AVAssetWriter(outputURL: output, fileType: .mov)
    let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.proRes4444,
        AVVideoWidthKey: size.width,
        AVVideoHeightKey: size.height,
        AVVideoColorPropertiesKey: [
            AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
            AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
            AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
        ],
    ])
    let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: size.width,
        kCVPixelBufferHeightKey as String: size.height,
    ])
    writer.add(video)
    var sound: (from: AVAssetReaderTrackOutput, to: AVAssetWriterInput)?
    if let audio = try await asset.loadTracks(withMediaType: .audio).first {
        let from = AVAssetReaderTrackOutput(track: audio, outputSettings: nil)
        let to = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: try await audio.load(.formatDescriptions).first)
        reader.add(from)
        writer.add(to)
        sound = (from, to)
    }

    let feeding = Feeding()
    do {
        guard reader.startReading() else { throw reader.error ?? AlphaVideoError.noVideo }
        guard writer.startWriting() else { throw writer.error ?? AlphaVideoError.noFrame }
        writer.startSession(atSourceTime: .zero)
        // both tracks at once, each as the writer asks for it: one filled to its end first can hold the other up
        let feed = { (input: AVAssetWriterInput, name: String, next: @escaping () throws -> Bool) in
            feeding.enter()
            let to = Handed(input: input)
            input.requestMediaDataWhenReady(on: DispatchQueue(label: "alpha-video." + name)) {
                while to.input.isReadyForMoreMediaData {
                    var failed: Error?
                    do {
                        if feeding.failure == nil, try next() { continue }
                    } catch {
                        failed = error
                    }
                    to.input.markAsFinished()
                    feeding.leave(failed)
                    return
                }
            }
        }
        var written = 0.0
        var told = -1
        feed(video, "picture") {
            guard let sample = frames.copyNextSampleBuffer() else { return false }
            written += 1
            let percent = min(99, Int(written / max(count, 1) * 100))
            if percent != told {
                told = percent
                progress?(Double(percent) / 100)
            }
            guard let picture = CMSampleBufferGetImageBuffer(sample) else { return true }   // a marker, no picture in it
            var made: CVPixelBuffer?
            if let pool = adaptor.pixelBufferPool { CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made) }
            guard let frame = made else { throw AlphaVideoError.noFrame }
            try joinAlpha(picture, into: frame, stacked: stacked)
            guard adaptor.append(frame, withPresentationTime: CMSampleBufferGetPresentationTimeStamp(sample)) else {
                throw writer.error ?? AlphaVideoError.noFrame
            }
            return true
        }
        if let sound {
            feed(sound.to, "sound") {
                guard let sample = sound.from.copyNextSampleBuffer() else { return false }
                guard sound.to.append(sample) else { throw writer.error ?? AlphaVideoError.noFrame }
                return true
            }
        }
        await withTaskCancellationHandler { await feeding.wait() } onCancel: { feeding.stop(CancellationError()) }
        if let error = feeding.failure ?? (reader.status == .failed ? reader.error : nil) { throw error }
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? AlphaVideoError.noFrame }
    } catch {
        reader.cancelReading()
        if writer.status == .writing { writer.cancelWriting() }
        try? FileManager.default.removeItem(at: output)
        throw error
    }
}

/// A name beside `final` for a file that is still being made ("Demo (being made).mov"), free in that folder.
func alphaWorkFile(beside final: URL, ext: String) -> URL {
    let stem = final.deletingPathExtension().lastPathComponent
    return uniqueURL(in: final.deletingLastPathComponent(), named: "\(stem) (being made).\(ext)")
}

/// A finished packed download made into the video at `final` (a file already there is replaced: the Save dialog has
/// asked). It is made beside `final` under a name of its own and moved in whole, so `final` is never half a video
/// and the disk that takes it is the one chosen. The packed file is deleted either way.
func makeAlphaVideo(packed: URL, stacked: Bool, to final: URL, progress: (@Sendable (Double) -> Void)? = nil) async throws {
    let made = alphaWorkFile(beside: final, ext: "mov")
    defer {
        try? FileManager.default.removeItem(at: packed)
        try? FileManager.default.removeItem(at: made)
    }
    try await convertAlphaVideo(packed: packed, stacked: stacked, output: made, progress: progress)
    if FileManager.default.fileExists(atPath: final.path) { try FileManager.default.removeItem(at: final) }
    try FileManager.default.moveItem(at: made, to: final)
}
