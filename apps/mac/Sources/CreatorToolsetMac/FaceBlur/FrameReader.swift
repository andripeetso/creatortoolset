// Face Blur engine (Cover.swift says what this folder is): upright SDR frames from a video.
import AVFoundation
import CoreImage
import CoreVideo

/// Sequentially decodes upright, SDR frames at analysis size. One pass, in order: no per-frame seeking, which is slow on
/// long-GOP phone footage.
final class FrameReader {
    struct Frame {
        let time: Double
        let buffer: CVPixelBuffer
    }

    private let reader: AVAssetReader
    private let output: AVAssetReaderVideoCompositionOutput
    let size: CGSize

    /// - Parameters:
    ///   - longSide: frames are scaled so their long side is at most this.
    ///   - exact: frames are this size instead, squeezed to it whatever their shape (the library's picture read, LookPicture.swift).
    ///   - pixelFormat: the frames' pixel format.
    init(asset: AVAsset, range: ClosedRange<Double>, longSide: CGFloat, exact: CGSize? = nil,
         pixelFormat: OSType = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange) async throws {
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw MediaError.noVideoTrack
        }
        let ciContext = CIContext(options: [.cacheIntermediates: false])
        // The composition applies the track's rotation for us: its source
        // images arrive upright.
        let composition = try await AVMutableVideoComposition.videoComposition(
            with: asset,
            applyingCIFiltersWithHandler: { _ in }
        )
        let upright = composition.renderSize
        let scale = min(1, longSide / max(upright.width, upright.height))
        let target = exact ?? CGSize(
            width: max(2, (upright.width * scale / 2).rounded(.down) * 2),
            height: max(2, (upright.height * scale / 2).rounded(.down) * 2)
        )
        let sx = target.width / upright.width, sy = target.height / upright.height
        let scaled = try await AVMutableVideoComposition.videoComposition(
            with: asset,
            applyingCIFiltersWithHandler: { request in
                let image = request.sourceImage
                    .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
                request.finish(with: image, context: ciContext)
            }
        )
        scaled.renderSize = target
        MediaColor.applySDR(to: scaled)
        size = target

        reader = try AVAssetReader(asset: asset)
        let start = CMTime(seconds: max(0, range.lowerBound), preferredTimescale: 600)
        let end = CMTime(seconds: range.upperBound, preferredTimescale: 600)
        reader.timeRange = CMTimeRange(start: start, end: end)
        output = AVAssetReaderVideoCompositionOutput(
            videoTracks: [track],
            videoSettings: [
                kCVPixelBufferPixelFormatTypeKey as String: pixelFormat,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ]
        )
        output.videoComposition = scaled
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw MediaError.unreadable }
        reader.add(output)
        guard reader.startReading() else {
            throw reader.error ?? MediaError.unreadable
        }
    }

    func next() throws -> Frame? {
        while let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            let time = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            return Frame(time: time, buffer: buffer)
        }
        if reader.status == .failed { throw reader.error ?? MediaError.unreadable }
        return nil
    }

    func cancel() {
        if reader.status == .reading { reader.cancelReading() }
    }

    deinit { cancel() }
}

enum MediaColor {
    /// Rec. 709 output. HDR sources (HLG/PQ from recent phones) are tone-mapped to SDR here, before covers are applied.
    static func applySDR(to composition: AVMutableVideoComposition) {
        composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
    }
}

/// Copies reader frames so they can be kept (the reader's pool is small and
/// stalls if we hold its buffers).
final class PixelBufferCopier {
    private var pool: CVPixelBufferPool?
    private var poolKey: (Int, Int, OSType)?

    func copy(_ source: CVPixelBuffer) -> CVPixelBuffer? {
        let width = CVPixelBufferGetWidth(source), height = CVPixelBufferGetHeight(source)
        let format = CVPixelBufferGetPixelFormatType(source)
        if poolKey == nil || poolKey! != (width, height, format) {
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: format,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ]
            var newPool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &newPool)
            pool = newPool
            poolKey = (width, height, format)
        }
        guard let pool else { return nil }
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, pool, &out)
        guard let destination = out else { return nil }

        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(destination, [])
        defer {
            CVPixelBufferUnlockBaseAddress(destination, [])
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
        }
        let planes = max(1, CVPixelBufferGetPlaneCount(source))
        for plane in 0..<planes {
            let isPlanar = CVPixelBufferIsPlanar(source)
            guard let src = isPlanar ? CVPixelBufferGetBaseAddressOfPlane(source, plane) : CVPixelBufferGetBaseAddress(source),
                  let dst = isPlanar ? CVPixelBufferGetBaseAddressOfPlane(destination, plane) : CVPixelBufferGetBaseAddress(destination)
            else { return nil }
            let rows = isPlanar ? CVPixelBufferGetHeightOfPlane(source, plane) : height
            let srcStride = isPlanar ? CVPixelBufferGetBytesPerRowOfPlane(source, plane) : CVPixelBufferGetBytesPerRow(source)
            let dstStride = isPlanar ? CVPixelBufferGetBytesPerRowOfPlane(destination, plane) : CVPixelBufferGetBytesPerRow(destination)
            if srcStride == dstStride {
                memcpy(dst, src, srcStride * rows)
            } else {
                let rowBytes = min(srcStride, dstStride)
                for row in 0..<rows {
                    memcpy(dst + row * dstStride, src + row * srcStride, rowBytes)
                }
            }
        }
        return destination
    }
}
