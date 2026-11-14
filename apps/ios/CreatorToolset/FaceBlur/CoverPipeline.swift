// Face Blur engine (Cover.swift says what this folder is): one file from scan to covered copy. The scan finds the faces
// and makes a picture and a line about each (what the person's AI chooses from in "Only some faces"); the write covers
// the faces chosen. A scan is kept, so the same file can be written again with other faces.
import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers

/// One face a scan found, as the page and the AI see it.
struct ScannedFace: Hashable, Sendable {
    /// "F1", "F2"… in the order the faces first appear.
    let id: String
    /// A JPEG, base64: the face at up to three moments side by side.
    let picture: String
    /// "middle left of the frame; 12% of its width; seen for 4.2 s"
    let note: String
}

/// What a scan found in one file. `covers[i]` is the face `faces[i]`.
struct FaceScan: Sendable {
    let kind: MediaKind
    let covers: [Cover]
    let faces: [ScannedFace]
}

enum CoverPipeline {
    static func faceID(_ index: Int) -> String { "F\(index + 1)" }

    static func kind(of url: URL) -> MediaKind? {
        guard let type = UTType(filenameExtension: url.pathExtension) else { return nil }
        if type.conforms(to: .movie) || type.conforms(to: .video) { return .video }
        if type.conforms(to: .image) { return .photo }
        return nil
    }

    /// Where the covered copy of `source` goes: "<name> blurred.mp4" (a video) or ".jpg" (a photo) beside it, with a
    /// number when that name is taken ("<name> blurred 2.mp4").
    static func outputURL(for source: URL, kind: MediaKind, exists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }) -> URL {
        let folder = source.deletingLastPathComponent()
        let name = source.deletingPathExtension().lastPathComponent
        let ext = kind == .video ? "mp4" : "jpg"
        var url = folder.appendingPathComponent("\(name) blurred.\(ext)")
        var n = 2
        while exists(url.path) {
            url = folder.appendingPathComponent("\(name) blurred \(n).\(ext)")
            n += 1
        }
        return url
    }

    // MARK: Scan

    /// Finds the faces in a photo or a video. `progress` gets 0…1.
    static func scan(_ source: URL, preset: LookPreset, progress: @escaping @Sendable (Double) -> Void) async throws -> FaceScan {
        guard let kind = kind(of: source) else { throw MediaError.unreadable }
        switch kind {
        case .video:
            let asset = AVURLAsset(url: source, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
            let duration = try await asset.load(.duration).seconds
            guard duration.isFinite, duration > 0 else { throw MediaError.unreadable }
            let analysis = try await VideoAnalyzer(asset: asset, range: 0...duration, preset: preset).run { progress($0.fraction * 0.9) }
            // a cancelled scan has only some of the faces: never write from it
            guard analysis.completed else { throw CancellationError() }
            let faces = try await videoFaces(asset, covers: analysis.covers)
            progress(1)
            return FaceScan(kind: .video, covers: analysis.covers, faces: faces)
        case .photo:
            let image = try uprightPhoto(source)
            let size = image.extent.size
            let scale = min(1, 3072 / max(size.width, size.height))
            let scaled = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            // a generous copy for Vision: small faces in big group photos need it
            guard let cg = CIContext().createCGImage(scaled, from: CGRect(origin: .zero, size: scaled.extent.size).integral) else { throw MediaError.unreadable }
            let covers = TrackBuilder.photoCovers(try FaceDetector.detect(in: cg), frame: size, preset: preset)
            try Task.checkCancellation()
            let faces = covers.enumerated().map { i, cover in
                ScannedFace(id: faceID(i), picture: picture([crop(cg, cover.path[0].rect)]), note: note(cover, kind: .photo))
            }
            progress(1)
            return FaceScan(kind: .photo, covers: covers, faces: faces)
        }
    }

    // MARK: Write

    /// A write that would cover no face: nothing is written, so a copy that looks covered never is. `why` is for the person.
    struct NothingToCover: Error, Equatable {
        let why: String
    }

    /// Writes `source` to `url` with the faces in `blur` covered (ids from the scan); the others stay as they are.
    /// Throws `NothingToCover` (and writes nothing) when no face was found or none is chosen.
    static func write(_ scan: FaceScan, from source: URL, blur: Set<String>, to url: URL, progress: @escaping @Sendable (Double) -> Void) async throws {
        let covers = scan.covers.enumerated().filter { blur.contains(faceID($0.offset)) }.map(\.element)
        if scan.covers.isEmpty { throw NothingToCover(why: "No face found, nothing written") }
        if covers.isEmpty { throw NothingToCover(why: "No face chosen, nothing written") }
        switch scan.kind {
        case .video:
            try await CoverExporter.exportVideo(asset: AVURLAsset(url: source), covers: covers, to: url, progress: progress)
        case .photo:
            try CoverExporter.exportPhoto(image: try uprightPhoto(source), covers: covers, to: url)
            progress(1)
        }
    }

    /// A photo upright (EXIF orientation applied), its origin at zero.
    static func uprightPhoto(_ url: URL) throws -> CIImage {
        guard let image = CIImage(contentsOf: url, options: [.applyOrientationProperty: true]) else { throw MediaError.unreadable }
        return image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
    }

    // MARK: Faces in words and pictures

    /// The line the AI reads about a face: where it is, how big, how long.
    static func note(_ cover: Cover, kind: MediaKind) -> String {
        let n = Double(cover.path.count)
        let cx = cover.path.reduce(0) { $0 + $1.rect.cx } / n, cy = cover.path.reduce(0) { $0 + $1.rect.cy } / n
        // the cover is the face box padded by about a third (TrackBuilder.faceRect)
        let width = cover.path.reduce(0) { $0 + $1.rect.w } / n / 1.35
        let where_ = "\(cy < 0.33 ? "top" : cy > 0.67 ? "bottom" : "middle") \(cx < 0.33 ? "left" : cx > 0.67 ? "right" : "centre")"
        let seen = kind == .photo ? "in the photo" : String(format: "seen for %.1f s", max(0, cover.end - cover.start))
        return "\(where_) of the frame; \(Int((width * 100).rounded()))% of its width; \(seen)"
    }

    /// The moments a face's picture shows: the largest detected sighting of each third of its path.
    static func moments(_ cover: Cover, n: Int = 3) -> [Double] {
        let seen = cover.path.filter { !$0.followed }
        let samples = seen.isEmpty ? cover.path : seen
        var out: [Double] = []
        for i in 0..<n {
            let part = samples[(i * samples.count / n)..<((i + 1) * samples.count / n)]
            if let best = part.max(by: { $0.rect.w < $1.rect.w }), !out.contains(best.time) { out.append(best.time) }
        }
        return out.sorted()
    }

    private static func videoFaces(_ asset: AVAsset, covers: [Cover]) async throws -> [ScannedFace] {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1280, height: 1280)
        generator.requestedTimeToleranceBefore = CMTime(value: 1, timescale: 30)
        generator.requestedTimeToleranceAfter = CMTime(value: 1, timescale: 30)
        var faces: [ScannedFace] = []
        for (i, cover) in covers.enumerated() {
            try Task.checkCancellation()
            var crops: [CGImage] = []
            for t in moments(cover) {
                guard let frame = try? await generator.image(at: CMTime(seconds: t, preferredTimescale: 600)).image else { continue }
                crops.append(crop(frame, Cover.pathSample(cover.path, at: t).rect))
            }
            faces.append(ScannedFace(id: faceID(i), picture: picture(crops), note: note(cover, kind: .video)))
        }
        return faces
    }

    /// The square around a cover circle in `image` (top-left origin), within the image.
    static func crop(_ image: CGImage, _ rect: NormRect) -> CGImage {
        let size = CGSize(width: image.width, height: image.height)
        let d = rect.diameter(in: size)
        let box = CGRect(x: rect.cx * size.width - d / 2, y: rect.cy * size.height - d / 2, width: d, height: d)
            .integral.intersection(CGRect(origin: .zero, size: size))
        return image.cropping(to: box) ?? image
    }

    static let tile = 160
    static let maxPictureBytes = 200_000

    /// The crops side by side, each in a `tile`-pixel square, as a base64 JPEG under `maxPictureBytes`.
    static func picture(_ crops: [CGImage]) -> String {
        let count = max(1, crops.count)
        guard let ctx = CGContext(data: nil, width: tile * count, height: tile, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return "" }
        ctx.setFillColor(gray: 0, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: tile * count, height: tile))
        ctx.interpolationQuality = .high
        for (i, crop) in crops.enumerated() {
            // fitted into its square, centred
            let s = CGFloat(tile) / CGFloat(max(crop.width, crop.height))
            let w = CGFloat(crop.width) * s, h = CGFloat(crop.height) * s
            ctx.draw(crop, in: CGRect(x: CGFloat(i * tile) + (CGFloat(tile) - w) / 2, y: (CGFloat(tile) - h) / 2, width: w, height: h))
        }
        guard let image = ctx.makeImage() else { return "" }
        for quality in [0.8, 0.6, 0.4, 0.2] {
            let data = NSMutableData()
            guard let dest = CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil) else { return "" }
            CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
            if CGImageDestinationFinalize(dest), data.length <= maxPictureBytes { return (data as Data).base64EncodedString() }
        }
        return ""
    }
}
