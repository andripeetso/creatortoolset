// One card's pictures as the files the server takes (SPEC 6a): the frames as an H.264 .mp4 with no sound, and three
// stills (first, middle and last frame) as PNG, 540 px wide. A card is a full-screen cutaway, and H.264 has no
// see-through, so every frame is laid on black.
import AVFoundation
import AppKit

enum CardClipError: Error, Equatable {
    case writer(String)
}

/// A bitmap of exactly width × height pixels, black, with `image` drawn over all of it (whatever the screen's scale made
/// the picture).
func onBlack(_ image: CGImage, width: Int, height: Int, data: UnsafeMutableRawPointer? = nil, bytesPerRow: Int = 0) -> CGContext? {
    guard let space = CGColorSpace(name: CGColorSpace.sRGB),
          let context = CGContext(data: data, width: width, height: height, bitsPerComponent: 8, bytesPerRow: bytesPerRow, space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
    else { return nil }
    let all = CGRect(x: 0, y: 0, width: width, height: height)
    context.setFillColor(CGColor(gray: 0, alpha: 1))
    context.fill(all)
    context.interpolationQuality = .high
    // The picture holds the page's own colour values but is labelled with the screen's colour space. Relabelled, not
    // converted, a colour the script wrote is the colour in the clip, on any screen.
    context.draw(image.copy(colorSpace: space) ?? image, in: all)
    return context
}

/// The frames of one card, written as they are drawn. Used from the main actor, in frame order.
@MainActor
final class CardClipWriter {
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let width: Int
    private let height: Int
    /// 1000 ticks a frame, so a rate like 29.97 keeps its length
    private let timescale: Int32

    init(to url: URL, width: Int, height: Int, fps: Double) throws {
        self.width = width
        self.height = height
        timescale = Int32((fps * 1000).rounded())
        writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.movieTimeScale = timescale   // or the length is rounded to the file's usual 1/600 s
        input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                // text and flat colour: 0.15 bit a pixel is about 9 Mbit/s at 1080 × 1920, 30 frames a second
                AVVideoAverageBitRateKey: Int(Double(width * height) * fps * 0.15),
                AVVideoMaxKeyFrameIntervalKey: max(1, Int(fps.rounded())),
                // frames in the order they are shown, so a cut into the clip never waits for a later frame
                AVVideoAllowFrameReorderingKey: false,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ] as [String: Any],
        ])
        input.expectsMediaDataInRealTime = false
        input.mediaTimeScale = timescale
        adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ])
        guard writer.canAdd(input) else { throw CardClipError.writer("this Mac can't make an H.264 clip of \(width) × \(height)") }
        writer.add(input)
        guard writer.startWriting() else { throw CardClipError.writer(writer.error?.localizedDescription ?? "the clip could not be started") }
        writer.startSession(atSourceTime: .zero)
    }

    private func time(_ frame: Int) -> CMTime { CMTime(value: Int64(frame) * 1000, timescale: timescale) }

    /// Adds frame `index`. The encoder works on its own threads and now and then is not ready for the next frame.
    func append(_ image: CGImage, index: Int) async throws {
        var waited = 0
        while !input.isReadyForMoreMediaData {
            guard writer.status == .writing, waited < 2500 else {
                throw CardClipError.writer(writer.error?.localizedDescription ?? "the encoder stopped taking frames")
            }
            try await Task.sleep(nanoseconds: 2_000_000)
            waited += 1
        }
        var made: CVPixelBuffer?
        if let pool = adaptor.pixelBufferPool { CVPixelBufferPoolCreatePixelBuffer(nil, pool, &made) }
        guard let buffer = made else { throw CardClipError.writer("no room for a frame") }
        CVPixelBufferLockBaseAddress(buffer, [])
        let drawn = onBlack(image, width: width, height: height, data: CVPixelBufferGetBaseAddress(buffer), bytesPerRow: CVPixelBufferGetBytesPerRow(buffer)) != nil
        CVPixelBufferUnlockBaseAddress(buffer, [])
        guard drawn, adaptor.append(buffer, withPresentationTime: time(index)) else {
            throw CardClipError.writer(writer.error?.localizedDescription ?? "a frame could not be written")
        }
    }

    /// Closes the file after `frames` frames: the last one is shown as long as the others.
    func finish(frames: Int) async throws {
        input.markAsFinished()
        writer.endSession(atSourceTime: time(frames))
        await writer.finishWriting()
        guard writer.status == .completed else { throw CardClipError.writer(writer.error?.localizedDescription ?? "the clip could not be finished") }
    }

    /// Gives up: nothing is left at the file's place.
    func cancel() {
        if writer.status == .writing { writer.cancelWriting() }
        try? FileManager.default.removeItem(at: writer.outputURL)
    }
}

enum CardStill {
    /// SPEC 6a: a still is 540 px wide, as tall as the card's shape makes it.
    static let width = 540

    /// Which frames the three stills are: the first, the middle and the last.
    static func frames(of count: Int) -> [Int] { [0, count / 2, max(0, count - 1)] }

    static func height(cardWidth: Int, cardHeight: Int) -> Int {
        max(1, Int((Double(cardHeight) * Double(width) / Double(max(cardWidth, 1))).rounded()))
    }

    /// The frame as a PNG `width` px wide, and whether it is nothing but the empty black stage.
    static func png(_ image: CGImage, cardWidth: Int, cardHeight: Int) throws -> (data: Data, blank: Bool) {
        let h = height(cardWidth: cardWidth, cardHeight: cardHeight)
        guard let context = onBlack(image, width: width, height: h), let small = context.makeImage(), let bytes = context.data,
              let data = NSBitmapImageRep(cgImage: small).representation(using: .png, properties: [:])
        else { throw CardClipError.writer("a still could not be made") }
        // BGRA, opaque: the stage is empty when no colour byte is above a trace (the encoder's rounding, not a picture)
        let pixels = bytes.bindMemory(to: UInt8.self, capacity: context.bytesPerRow * h)
        var blank = true
        scan: for y in 0..<h {
            let row = y * context.bytesPerRow
            for x in 0..<width where pixels[row + x * 4] > 8 || pixels[row + x * 4 + 1] > 8 || pixels[row + x * 4 + 2] > 8 {
                blank = false
                break scan
            }
        }
        return (data, blank)
    }
}
