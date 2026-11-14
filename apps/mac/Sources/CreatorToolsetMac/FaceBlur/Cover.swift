// Face Blur's engine (apps/captions/editor-steps/blur-faces/README.md): the same files in the Mac app and the iPhone app
// (FaceBlur/ in each). Platform-neutral: Foundation, Core Image, AVFoundation and Vision only.
import CoreGraphics
import Foundation

/// A cover circle in the upright, displayed image. Coordinates are normalized (0…1) with a top-left origin. `w` and `h`
/// are the same pixel diameter against the frame's width and height, so the circle stays round on any aspect ratio:
/// diameter in pixels = max(w·W, h·H).
struct NormRect: Codable, Hashable, Sendable {
    var cx: Double
    var cy: Double
    var w: Double
    var h: Double

    /// A circle of `diameter` pixels centred at a normalized point.
    static func circle(cx: Double, cy: Double, diameter: Double, in size: CGSize) -> NormRect {
        let d = max(8, diameter)
        return NormRect(cx: cx, cy: cy, w: d / size.width, h: d / size.height)
    }

    var cgRect: CGRect { CGRect(x: cx - w / 2, y: cy - h / 2, width: w, height: h) }

    func diameter(in size: CGSize) -> Double { max(w * size.width, h * size.height) }

    func offsetBy(dx: Double, dy: Double) -> NormRect { NormRect(cx: cx + dx, cy: cy + dy, w: w, h: h) }

    func scaled(_ factor: Double) -> NormRect { NormRect(cx: cx, cy: cy, w: w * factor, h: h * factor) }

    /// Size limits for every cover: at least 1% of the frame's long side across, at most 1.5× its short side.
    static let minSide = 0.01
    static let maxSide = 1.5

    /// Keeps a sensible size and at least 2% of the cover on screen; w and h scale together so the circle stays round.
    func clamped() -> NormRect {
        let lower = Self.minSide / max(1e-6, min(w, h))
        let upper = max(lower, Self.maxSide / max(1e-6, max(w, h)))
        let s = scaled(min(upper, max(lower, 1)))
        return NormRect(cx: min(0.98 + s.w / 2, max(0.02 - s.w / 2, cx)), cy: min(0.98 + s.h / 2, max(0.02 - s.h / 2, cy)), w: s.w, h: s.h)
    }

    static func lerp(_ a: NormRect, _ b: NormRect, _ f: Double) -> NormRect {
        NormRect(cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f, w: a.w + (b.w - a.w) * f, h: a.h + (b.h - a.h) * f)
    }

    func iou(_ other: NormRect) -> Double {
        let i = cgRect.intersection(other.cgRect)
        guard !i.isNull, i.width > 0, i.height > 0 else { return 0 }
        let inter = Double(i.width * i.height)
        let union = w * h + other.w * other.h - inter
        return union > 0 ? inter / union : 0
    }

    /// Centre distance divided by the larger of the two sizes.
    func centreDistance(to other: NormRect) -> Double {
        let dx = cx - other.cx, dy = cy - other.cy
        let scale = max(w, h, other.w, other.h)
        return scale > 0 ? (dx * dx + dy * dy).squareRoot() / scale : .infinity
    }
}

/// One point on a cover's path: where the face was at a source time.
struct PathSample: Codable, Hashable, Sendable {
    var time: Double
    var rect: NormRect
    /// Head roll in radians, clockwise on screen.
    var angle: Double = 0
    /// True when the position came from optical tracking, not a detection.
    var followed = false
}

/// How a face is covered. The page and the settings use these raw values ("blur", "mosaic", "solid").
enum CoverLook: String, Codable, CaseIterable, Sendable {
    case blur, mosaic, solid
}

/// One face's cover over time: a path of positions, shown from `start` to `end` (source seconds; a photo uses 0…0).
struct Cover: Codable, Hashable, Sendable {
    /// Sorted by time; never empty.
    var path: [PathSample]
    var start: Double
    var end: Double
    var look: CoverLook = .blur
    /// 0…1. Blur radius or mosaic block size.
    var strength: Double = 0.5
    /// 0…1. Feathers outward only; the circle itself is always fully covered.
    var softness: Double = 0.45
    var colorHex = "#343434"

    static let leadHold = 0.25
    static let tailHold = 0.25
    /// Path gaps longer than this are covered by a circle spanning both ends instead of being interpolated.
    static let interpolateMax = 0.9

    /// Where the cover is at a source time, or nil when it isn't showing.
    func placement(at time: Double) -> (rect: NormRect, angle: Double)? {
        guard time >= start - 1e-3, time <= end + 1e-3, !path.isEmpty else { return nil }
        let base = Self.pathSample(path, at: time)
        return (base.rect.clamped(), base.angle)
    }

    /// Interpolated path position, holding before the first and after the last sample. Long gaps become a circle that
    /// spans both ends.
    static func pathSample(_ path: [PathSample], at time: Double) -> PathSample {
        guard let first = path.first, let last = path.last else {
            return PathSample(time: time, rect: NormRect(cx: 0.5, cy: 0.5, w: 0.2, h: 0.2))
        }
        if time <= first.time { return first }
        if time >= last.time { return last }
        var lo = 0, hi = path.count
        while lo < hi {
            let mid = (lo + hi) / 2
            if path[mid].time > time { hi = mid } else { lo = mid + 1 }
        }
        let a = path[lo - 1], b = path[lo]
        let span = b.time - a.time
        if span > interpolateMax && needsBridge(a.rect, b.rect) {
            return PathSample(time: time, rect: gapCover(a.rect, b.rect), angle: a.angle, followed: true)
        }
        let f = span > 0 ? (time - a.time) / span : 0
        return PathSample(time: time, rect: .lerp(a.rect, b.rect, f), angle: lerpAngle(a.angle, b.angle, f), followed: a.followed || b.followed)
    }

    /// A long gap only needs the big bridging cover if the face moved or changed size across it.
    static func needsBridge(_ a: NormRect, _ b: NormRect) -> Bool {
        let ratio = b.w / max(1e-6, a.w)
        return a.centreDistance(to: b) > 0.25 || ratio < 0.8 || ratio > 1.25
    }

    /// Union of two circles, inflated to the circumscribed circle.
    static func gapCover(_ a: NormRect, _ b: NormRect) -> NormRect {
        let u = a.cgRect.union(b.cgRect).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        // w/h of any cover equals H/W of the frame, which converts heights into width units without the frame size
        let ratio = a.h > 0 ? a.w / a.h : 1
        let w = max(Double(u.width), Double(u.height) * ratio) * 2.squareRoot()
        return NormRect(cx: u.midX, cy: u.midY, w: w, h: w / ratio)
    }

    /// Shortest-way angle interpolation, so a head rolling through ±180° doesn't spin the cover the long way round.
    static func lerpAngle(_ a: Double, _ b: Double, _ f: Double) -> Double {
        var delta = (b - a).truncatingRemainder(dividingBy: 2 * .pi)
        if delta > .pi { delta -= 2 * .pi }
        if delta < -.pi { delta += 2 * .pi }
        return a + delta * f
    }
}

/// The look every cover of a job gets.
struct LookPreset: Hashable, Sendable {
    var look: CoverLook = .blur
    var colorHex = "#343434"
    var strength = 0.5

    func apply(to cover: inout Cover) {
        cover.look = look
        cover.colorHex = colorHex
        cover.strength = strength
        cover.softness = look == .solid ? 0 : 0.45
    }
}

enum MediaKind: String, Codable, Sendable {
    case photo, video
}

enum MediaError: LocalizedError {
    case noVideoTrack
    case unreadable
    case exportFailed(String)

    var errorDescription: String? {
        switch self {
        case .noVideoTrack: "This file has no video that can be read."
        case .unreadable: "This file couldn't be read. Try another photo or video."
        case .exportFailed(let detail): "The covered copy couldn't be written: \(detail)"
        }
    }
}
