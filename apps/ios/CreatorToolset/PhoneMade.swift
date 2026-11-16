import AVFoundation
import CryptoKit
import Foundation
import UIKit

/// What the phone makes of a video itself and sends with its upload, so the server never reads the file for it
/// (`apps/captions/api/library/derived.ts` `Made`): the card picture, the quick fingerprint, and to a library that keeps
/// only proxies a 720p copy in place of the original, with the original's probe. The original stays on the phone.
enum PhoneMade {
    /// The original, read before any 720p copy took its place in the upload, kept with the upload so a retry sends the same.
    struct Original: Codable, Hashable {
        let quick: String
        let size: Int64
        let probe: Probe
        /// The upload's bytes are the 720p copy.
        var proxy: Bool
    }

    /// The server's `ProbeSummary` as far as AVFoundation reads it, plus the file's own ISO 6709 location, which the
    /// server turns into a country and drops.
    struct Probe: Codable, Hashable {
        var duration: Double
        var width: Int
        var height: Int
        var fps: Double
        var rotation: Int
        var format = "mov,mp4,m4a,3gp,3g2,mj2"
        var vcodec: String
        var pixFmt: String
        var acodec: String
        var capturedAt: Double?
        var location: String?

        var json: [String: Any] {
            var out: [String: Any] = ["duration": duration, "width": width, "height": height, "fps": fps, "rotation": rotation,
                                      "format": format, "vcodec": vcodec, "pixFmt": pixFmt, "acodec": acodec]
            if let capturedAt { out["capturedAt"] = capturedAt }
            if let location { out["location"] = location }
            return out
        }
    }

    /// SHA-256 over the size as decimal text, the first MiB, and the last MiB when the file is over 2 MiB: the server's
    /// and the Mac's quickPrint, byte for byte.
    static func quickPrint(_ url: URL) -> String? {
        let mib: UInt64 = 1 << 20
        guard let file = try? FileHandle(forReadingFrom: url), let size = try? file.seekToEnd() else { return nil }
        defer { try? file.close() }
        var hash = SHA256()
        hash.update(data: Data(String(size).utf8))
        do {
            try file.seek(toOffset: 0)
            hash.update(data: try file.read(upToCount: Int(mib)) ?? Data())
            if size > 2 * mib {
                try file.seek(toOffset: size - mib)
                hash.update(data: try file.read(upToCount: Int(mib)) ?? Data())
            }
        } catch { return nil }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }

    /// The probe of a video; nil for a file with no picture (a sound, a photo).
    static func probe(_ url: URL) async -> Probe? {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let loaded = try? await track.load(.naturalSize, .preferredTransform, .nominalFrameRate, .formatDescriptions),
              let duration = try? await asset.load(.duration).seconds, duration.isFinite else { return nil }
        let (size, transform, fps, formats) = loaded
        let video = formats.first
        let audio = try? await asset.loadTracks(withMediaType: .audio).first?.load(.formatDescriptions).first
        let metadata = (try? await asset.load(.commonMetadata)) ?? []
        let location = try? await AVMetadataItem.metadataItems(from: metadata, filteredByIdentifier: .commonIdentifierLocation).first?.load(.stringValue)
        let created = try? await asset.load(.creationDate)?.load(.dateValue)
        return Probe(duration: (duration * 1000).rounded() / 1000,
                     width: Int(abs(size.width)), height: Int(abs(size.height)),
                     fps: (Double(fps) * 1000).rounded() / 1000,
                     rotation: rotation(transform),
                     vcodec: video.map { codec(CMFormatDescriptionGetMediaSubType($0)) } ?? "",
                     pixFmt: video.map(pixFmt) ?? "",
                     acodec: audio.map { codec(CMFormatDescriptionGetMediaSubType($0)) } ?? "",
                     capturedAt: created.map { ($0.timeIntervalSince1970 * 1000).rounded() },
                     location: location)
    }

    /// Clockwise quarter turns, as the server's probe reads the display matrix (an iPhone's portrait clip: 90).
    static func rotation(_ t: CGAffineTransform) -> Int {
        let degrees = Int((atan2(Double(t.b), Double(t.a)) * 180 / .pi / 90).rounded()) * 90
        return (degrees % 360 + 360) % 360
    }

    /// ffprobe's name for a codec the phone knows by its four-character code.
    static func codec(_ code: FourCharCode) -> String {
        let fourcc = String(bytes: [24, 16, 8, 0].map { UInt8((code >> $0) & 0xff) }, encoding: .ascii) ?? ""
        switch fourcc {
        case "avc1", "avc3": return "h264"
        case "hvc1", "hev1", "dvh1", "dvhe": return "hevc"
        case "av01": return "av1"
        case "vp09": return "vp9"
        case "ap4h", "ap4x", "apch", "apcn", "apcs", "apco": return "prores"
        case "aac ": return "aac"
        case "lpcm": return "pcm_s16le"
        case ".mp3": return "mp3"
        case "alac": return "alac"
        case "ac-3": return "ac3"
        case "ec-3": return "eac3"
        case "opus": return "opus"
        default: return fourcc.trimmingCharacters(in: .whitespaces).lowercased()
        }
    }

    /// 10-bit (an iPhone's HDR, ProRes) or 8-bit: only whether a browser plays it as it is turns on it.
    private static func pixFmt(_ format: CMFormatDescription) -> String {
        if codec(CMFormatDescriptionGetMediaSubType(format)) == "prores" { return "yuv422p10le" }
        let ext = CMFormatDescriptionGetExtensions(format) as? [String: Any] ?? [:]
        let bits = ext[kCMFormatDescriptionExtension_BitsPerComponent as String] as? Int ?? 8
        let transfer = ext[kCMFormatDescriptionExtension_TransferFunction as String] as? String
        let hdr = transfer == (kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String)
            || transfer == (kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String)
        return bits > 8 || hdr ? "yuv420p10le" : "yuv420p"
    }

    /// The card picture: a still a tenth of the way in, turned upright, 480 wide (the server's own thumbnail), JPEG.
    static func cardPicture(_ url: URL, duration: Double) async -> Data? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 480, height: 4096)
        for seconds in [duration * 0.1, 1, 0] where seconds <= duration {
            if let still = try? await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600)) {
                return UIImage(cgImage: still.image).jpegData(compressionQuality: 0.75)
            }
        }
        return nil
    }

    /// A 720p H.264 copy (the short side 720, never upscaled; every sound track kept, in AAC) at `to`.
    /// ponytail: the 1280x720 preset fits the frame in 1280x720, so a wider-than-16:9 clip's short side ends under 720.
    static func proxy(_ url: URL, to: URL) async throws {
        try? FileManager.default.removeItem(at: to)
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: url), presetName: AVAssetExportPreset1280x720) else {
            throw NoCopy()
        }
        session.outputURL = to
        session.outputFileType = .mp4
        session.shouldOptimizeForNetworkUse = true
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                session.exportAsynchronously {
                    switch session.status {
                    case .completed: continuation.resume()
                    case .cancelled: continuation.resume(throwing: CancellationError())
                    default: continuation.resume(throwing: session.error ?? NoCopy())
                    }
                }
            }
        } onCancel: {
            session.cancelExport()
        }
    }

    struct NoCopy: Error {}
}
