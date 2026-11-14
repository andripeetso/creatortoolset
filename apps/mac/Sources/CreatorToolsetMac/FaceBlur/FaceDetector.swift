// Face Blur engine (Cover.swift says what this folder is): Vision face rectangles.
import Vision
import CoreImage
import CoreML
import CoreVideo

/// A face found in one frame. `rect` is the tight face box (normalized,
/// top-left origin), not yet a cover.
struct FaceDetection: Hashable, Sendable {
    var rect: NormRect
    /// Head roll in radians, clockwise on screen.
    var angle: Double
    var score: Double
}

/// Apple Vision face detection. Revision 3 finds faces at any roll, sideways and upside-down included.
enum FaceDetector {
    /// Detections below this are ignored entirely.
    static let minScore = 0.45

    static func detect(in pixelBuffer: CVPixelBuffer) throws -> [FaceDetection] {
        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, orientation: .up)
        return try run(handler)
    }

    static func detect(in image: CGImage) throws -> [FaceDetection] {
        let handler = VNImageRequestHandler(cgImage: image, orientation: .up)
        return try run(handler)
    }

    private static func run(_ handler: VNImageRequestHandler) throws -> [FaceDetection] {
        let request = VNDetectFaceRectanglesRequest()
        request.revision = VNDetectFaceRectanglesRequestRevision3
        #if targetEnvironment(simulator)
        // The simulator has no Neural Engine; Vision needs the CPU path there.
        if #available(iOS 17.0, *) {
            if let cpu = try? request.supportedComputeStageDevices[.main]?.first(where: { device in
                if case .cpu = device { return true } else { return false }
            }) {
                request.setComputeDevice(cpu, for: .main)
            }
        }
        #endif
        try handler.perform([request])
        return (request.results ?? []).compactMap { face in
            let score = Double(face.confidence)
            guard score >= minScore else { return nil }
            return FaceDetection(
                rect: normRect(fromVision: face.boundingBox),
                angle: -(face.roll?.doubleValue ?? 0),
                score: score
            )
        }
    }

    /// Vision uses a bottom-left origin.
    static func normRect(fromVision box: CGRect) -> NormRect {
        NormRect(cx: box.midX, cy: 1 - box.midY, w: box.width, h: box.height)
    }

    static func visionRect(from rect: NormRect) -> CGRect {
        CGRect(x: rect.cx - rect.w / 2, y: 1 - rect.cy - rect.h / 2, width: rect.w, height: rect.h)
    }

    /// Turns a tight face box into a cover circle, padding small faces more
    /// because their boxes are less precise.
    static func coverRect(for face: NormRect, in frame: CGSize) -> NormRect {
        let wPx = face.w * frame.width, hPx = face.h * frame.height
        let size = max(wPx, hPx)
        let rel = size / max(1, min(frame.width, frame.height))
        let factor: Double
        switch rel {
        case 0.26...: factor = 1.08
        case 0.14...: factor = 1.18
        case 0.07...: factor = 1.28
        default: factor = 1.45
        }
        // Vision's box stops at the brow; pad a little more so hairlines and ears stay covered.
        return .circle(cx: face.cx, cy: face.cy, diameter: size * factor * 1.12, in: frame)
    }

    /// Plausible face size: 1.5%–90% of the frame's short side.
    static func isPlausible(_ face: NormRect, in frame: CGSize) -> Bool {
        let size = max(face.w * frame.width, face.h * frame.height)
        let rel = size / max(1, min(frame.width, frame.height))
        return rel >= 0.015 && rel <= 0.9
    }
}
