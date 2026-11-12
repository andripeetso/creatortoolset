// Cutting a still picture out of its background for the server (api/lib/cutouts.ts). A `cutout` step reaches this Mac
// the way a card step does (Relay.swift): its long poll lists the kind, the server hints, this Mac claims. Then, with
// the device token:
//   GET  /api/devices/relay/cutout/:id        the picture (PNG, JPEG or HEIC)
//   POST /api/devices/relay/cutout/:id        multipart `cutout`: the PNG, everything but the picture's subject see-through
//   or   /api/devices/relay/cutout/:id/fail   { error } with a reason a person can read
// An answer that carries `editor: true` says another step waits: it is claimed at once.
// The picture is read with ImageIO and cut with the foreground mask Vision has from macOS 14: no model is fetched, and
// no request goes anywhere but the server.
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// The step kind this Mac lists for a cut-out (contracts/devices.ts CUTOUT_KIND).
let cutoutKind = "cutout"

enum Cutout {
    /// The same caps as the server's (CUTOUT_LIMITS), and the pixels, which only this side can see.
    static let maxBytes = 25_000_000
    static let maxResult = 40_000_000
    static let maxPixels = 50_000_000
    /// A bigger picture is cut at this size on its long side, so the PNG stays under `maxResult`.
    static let maxSide = 4096
    static let types: Set<String> = [UTType.png.identifier, UTType.jpeg.identifier, UTType.heic.identifier]

    /// Why a picture can't be cut out, in words for the person.
    struct Refused: Error, Equatable {
        let why: String
    }

    static func fits(width: Int, height: Int) -> Bool { width > 0 && height > 0 && width * height <= maxPixels }

    /// `picture` as a PNG with everything but its subject see-through, upright and at most `maxSide` on its long side.
    static func png(_ picture: Data) throws -> Data {
        guard picture.count <= maxBytes else { throw Refused(why: "The picture is over \(maxBytes / 1_000_000) MB.") }
        guard let source = CGImageSourceCreateWithData(picture as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let type = CGImageSourceGetType(source) as String?, types.contains(type), CGImageSourceGetCount(source) > 0
        else { throw Refused(why: "That is not a PNG, JPEG or HEIC picture.") }
        let index = CGImageSourceGetPrimaryImageIndex(source)
        let props = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any]
        guard let width = props?[kCGImagePropertyPixelWidth] as? Int, let height = props?[kCGImagePropertyPixelHeight] as? Int, fits(width: width, height: height)
        else { throw Refused(why: "The picture is over \(maxPixels / 1_000_000) million pixels.") }
        // decoded once, turned the way the camera held it
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, index, [
            kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: min(max(width, height), maxSide), kCGImageSourceShouldCacheImmediately: true,
        ] as CFDictionary) else { throw Refused(why: "The picture could not be read.") }
        let handler = VNImageRequestHandler(cgImage: image)
        let request = VNGenerateForegroundInstanceMaskRequest()
        try handler.perform([request])
        guard let found = request.results?.first, !found.allInstances.isEmpty else { throw Refused(why: "Nothing in this picture stands out from its background.") }
        let masked = CIImage(cvPixelBuffer: try found.generateMaskedImage(ofInstances: found.allInstances, from: handler, croppedToInstancesExtent: false))
        let out = NSMutableData()
        guard let cut = CIContext().createCGImage(masked, from: masked.extent),
              let png = CGImageDestinationCreateWithData(out, UTType.png.identifier as CFString, 1, nil)
        else { throw Refused(why: "The cut-out could not be made into a PNG.") }
        CGImageDestinationAddImage(png, cut, nil)
        guard CGImageDestinationFinalize(png) else { throw Refused(why: "The cut-out could not be made into a PNG.") }
        guard out.length <= maxResult else { throw Refused(why: "The cut-out is over \(maxResult / 1_000_000) MB.") }
        return out as Data
    }
}

/// One cut-out step, from reading the picture to sending its PNG or why not. Runs on the caller's thread.
struct CutoutJob {
    let api: DeviceAPI
    let id: Int

    /// How it ended, and whether the server's answer said another step waits.
    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/cutout/\(id)"
        let why: String
        do {
            let picture = try api.get(base, tries: 2)
            if picture.status == 401 { return (.gone, false) }
            guard picture.status == 200 else { throw Cutout.Refused(why: "The picture could not be read from the server (HTTP \(picture.status)).") }
            let png = try Cutout.png(picture.data)
            let reply = try api.upload(base, [FormPart(name: "cutout", filename: "cutout.png", type: "image/png", data: png)], tries: 3)
            // any other answer: the server has ended it (refused it, or it is no longer this Mac's)
            return reply.status == 200 ? (.done, RelayRunner.editorWaits(reply.data)) : (.gone, false)
        } catch let refused as Cutout.Refused {
            why = refused.why
        } catch {
            why = "The picture could not be cut out on this Mac: \(error.localizedDescription)."
        }
        let reply = try? api.call("POST", "\(base)/fail", ["error": String(why.prefix(500))], tries: 4)
        return (.failed(why), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }
}
