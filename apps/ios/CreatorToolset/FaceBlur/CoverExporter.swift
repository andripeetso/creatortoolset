// Face Blur engine (Cover.swift says what this folder is): the covered copy of a video or a photo.
import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

/// Writes covered copies. Every frame of a video goes through `CoverRenderer`; there is no uncovered fallback. A copy
/// is written next to `url` first and moved there only once it checks out, so a half-written file never has the name.
enum CoverExporter {
    /// Long side of exported videos: fits every messaging app without them recompressing twice.
    static let videoLongSide: CGFloat = 1920
    static let photoLongSide: CGFloat = 4096
    /// H.264 at a fixed bitrate: the copy is the working file for editing, and an export preset picks about half of this.
    static let videoBitrate = 20_000_000

    // MARK: Video

    static func exportVideo(
        asset: AVAsset,
        covers: [Cover],
        to url: URL,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws {
        guard let sourceVideo = try await asset.loadTracks(withMediaType: .video).first else {
            throw MediaError.noVideoTrack
        }
        let range = CMTimeRange(start: .zero, duration: try await asset.load(.duration))

        // A fresh composition carries no source metadata (location, device, original dates).
        let composition = AVMutableComposition()
        guard let video = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw MediaError.unreadable
        }
        try video.insertTimeRange(range, of: sourceVideo, at: .zero)
        let (natural, transform) = try await sourceVideo.load(.naturalSize, .preferredTransform)
        video.preferredTransform = transform
        for sourceAudio in try await asset.loadTracks(withMediaType: .audio) {
            if let audio = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) {
                try? audio.insertTimeRange(range, of: sourceAudio, at: .zero)
            }
        }

        let renderer = CoverRenderer.shared
        let ciContext = CIContext(options: [.cacheIntermediates: false])
        let upright = CGRect(origin: .zero, size: natural).applying(transform).standardized.size
        let scale = min(1, videoLongSide / max(upright.width, upright.height))
        let target = CGSize(
            width: max(2, (upright.width * scale / 2).rounded(.down) * 2),
            height: max(2, (upright.height * scale / 2).rounded(.down) * 2)
        )
        let videoComposition = try await AVMutableVideoComposition.videoComposition(
            with: composition,
            applyingCIFiltersWithHandler: { request in
                // Every output frame goes through the cover renderer. There is
                // no fallback that could let an uncovered frame through.
                let source = request.sourceImage
                let time = request.compositionTime.seconds
                let covered = renderer.render(source, covers: covers, time: time)
                let sx = target.width / source.extent.width, sy = target.height / source.extent.height
                let output = covered
                    .transformed(by: CGAffineTransform(translationX: -source.extent.minX, y: -source.extent.minY))
                    .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
                    .cropped(to: CGRect(origin: .zero, size: target))
                request.finish(with: output, context: ciContext)
            }
        )
        videoComposition.renderSize = target
        MediaColor.applySDR(to: videoComposition)

        let partial = partialURL(for: url)
        defer { try? FileManager.default.removeItem(at: partial) }
        try await write(composition, videoComposition, size: target, duration: range.duration.seconds, to: partial, progress: progress)
        progress(1)

        // Never give a partial or empty file the copy's name.
        let check = AVURLAsset(url: partial)
        let duration = try await check.load(.duration).seconds
        let tracks = try await check.loadTracks(withMediaType: .video)
        guard duration > 0, !tracks.isEmpty else { throw MediaError.exportFailed("the finished file didn't check out.") }
        try place(partial, at: url)
    }

    /// Reads the composition through the cover renderer and writes H.264 at `videoBitrate` with each sound track as
    /// stereo AAC. A writer adds no metadata of its own.
    private static func write(
        _ composition: AVAsset,
        _ videoComposition: AVVideoComposition,
        size: CGSize,
        duration: Double,
        to url: URL,
        progress: @escaping @Sendable (Double) -> Void
    ) async throws {
        let reader = try AVAssetReader(asset: composition)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let videoOut = AVAssetReaderVideoCompositionOutput(
            videoTracks: try await composition.loadTracks(withMediaType: .video),
            videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        )
        videoOut.videoComposition = videoComposition
        videoOut.alwaysCopiesSampleData = false
        let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(size.width),
            AVVideoHeightKey: Int(size.height),
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: videoBitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        videoIn.expectsMediaDataInRealTime = false
        guard reader.canAdd(videoOut), writer.canAdd(videoIn) else { throw MediaError.exportFailed("that video can't be made here.") }
        reader.add(videoOut)
        writer.add(videoIn)
        var pairs: [(AVAssetReaderOutput, AVAssetWriterInput)] = [(videoOut, videoIn)]

        var stereo = AudioChannelLayout()
        stereo.mChannelLayoutTag = kAudioChannelLayoutTag_Stereo
        let layout = Data(bytes: &stereo, count: MemoryLayout<AudioChannelLayout>.size)
        for track in try await composition.loadTracks(withMediaType: .audio) {
            let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVChannelLayoutKey: layout,
                AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false,
            ])
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVChannelLayoutKey: layout,
                AVEncoderBitRateKey: 256_000,
            ])
            input.expectsMediaDataInRealTime = false
            // a sound track that can't be read is left out, as the export session did with one it couldn't convert
            guard reader.canAdd(out), writer.canAdd(input) else { continue }
            reader.add(out)
            writer.add(input)
            pairs.append((out, input))
        }

        guard reader.startReading() else { throw reader.error ?? MediaError.exportFailed("the video couldn't be read.") }
        guard writer.startWriting() else { throw writer.error ?? MediaError.exportFailed("the copy couldn't be started.") }
        writer.startSession(atSourceTime: .zero)

        try await withTaskCancellationHandler {
            await withTaskGroup(of: Void.self) { group in
                for (index, (out, input)) in pairs.enumerated() {
                    nonisolated(unsafe) let out = out, input = input
                    group.addTask {
                        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                            input.requestMediaDataWhenReady(on: DispatchQueue(label: "faceblur.write.\(index)")) {
                                while input.isReadyForMoreMediaData {
                                    guard let sample = out.copyNextSampleBuffer() else {
                                        input.markAsFinished()
                                        done.resume()
                                        return
                                    }
                                    if index == 0, duration > 0 { progress(min(1, CMSampleBufferGetPresentationTimeStamp(sample).seconds / duration)) }
                                    if !input.append(sample) {
                                        reader.cancelReading()
                                        input.markAsFinished()
                                        done.resume()
                                        return
                                    }
                                }
                            }
                        }
                    }
                }
            }
        } onCancel: {
            reader.cancelReading()
            writer.cancelWriting()
        }
        try Task.checkCancellation()
        if reader.status == .failed { writer.cancelWriting(); throw reader.error ?? MediaError.exportFailed("the video couldn't be read.") }
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? MediaError.exportFailed("Unknown error") }
    }

    // MARK: Photo

    /// Renders a new JPEG. Only pixels are written: no EXIF, GPS, camera or
    /// original-date metadata comes along.
    static func exportPhoto(image: CIImage, covers: [Cover], to url: URL) throws {
        var source = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
        let scale = min(1, photoLongSide / max(source.extent.width, source.extent.height))
        if scale < 1 {
            source = source.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        let rendered = CoverRenderer.shared.render(source, covers: covers, time: 0)
        let context = CIContext()
        let rect = CGRect(origin: .zero, size: rendered.extent.size).integral
        guard let cg = context.createCGImage(rendered, from: rect, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else {
            throw MediaError.exportFailed("the photo couldn't be drawn.")
        }
        let partial = partialURL(for: url)
        defer { try? FileManager.default.removeItem(at: partial) }
        guard let destination = CGImageDestinationCreateWithURL(partial as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw MediaError.exportFailed("the photo couldn't be written.")
        }
        CGImageDestinationAddImage(destination, cg, [
            kCGImageDestinationLossyCompressionQuality: 0.92,
            kCGImagePropertyOrientation: 1,
        ] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw MediaError.exportFailed("the photo couldn't be written.") }
        try place(partial, at: url)
    }

    /// A hidden name beside `url` for the copy while it is written.
    static func partialURL(for url: URL) -> URL {
        url.deletingLastPathComponent().appendingPathComponent(".\(url.deletingPathExtension().lastPathComponent).\(UUID().uuidString.prefix(8)).partial.\(url.pathExtension)")
    }

    /// Moves a finished copy to its name, replacing an earlier copy there (the same item written again).
    static func place(_ partial: URL, at url: URL) throws {
        if FileManager.default.fileExists(atPath: url.path) {
            _ = try FileManager.default.replaceItemAt(url, withItemAt: partial)
        } else {
            try FileManager.default.moveItem(at: partial, to: url)
        }
    }
}
