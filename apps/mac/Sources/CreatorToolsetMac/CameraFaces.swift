import AVFoundation
import Foundation
import Vision

// Where the face is in a recording's camera file, for the editor's Follow my face (src/lib/screen-recording.ts
// faceFollower): five looks a second with the Mac's own face finder, written beside the file as camera-faces.json,
// `{"v":1,"samples":[[t, x, y, h], …]}`: the time in seconds, the largest face's centre and its height, all 0–1 of the
// picture as filmed (not mirrored), top left at 0,0. A moment with no face has no sample. Made when the editor asks,
// so recordings made before it work too.
enum CameraFaces {
    static let perSecond = 5.0

    /// Reads the camera file through once and writes the samples; `progress` hears 0–1 along the way.
    static func make(_ project: LocalProject, progress: @escaping (Double) -> Void) async throws {
        let asset = AVURLAsset(url: project.cameraURL)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw CocoaError(.fileReadCorruptFile) }
        let duration = try await asset.load(.duration).seconds
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? CocoaError(.fileReadUnknown) }
        var samples: [[Double]] = []
        var next = 0.0
        while let buffer = output.copyNextSampleBuffer() {
            try Task.checkCancellation()
            let t = CMSampleBufferGetPresentationTimeStamp(buffer).seconds
            guard t >= next, let pixels = CMSampleBufferGetImageBuffer(buffer) else { continue }
            next = t + 1 / perSecond
            let request = VNDetectFaceRectanglesRequest()
            try VNImageRequestHandler(cvPixelBuffer: pixels, options: [:]).perform([request])
            // the largest face is the one being filmed; Vision's box has its origin at the bottom left
            if let face = (request.results ?? []).max(by: { $0.boundingBox.width * $0.boundingBox.height < $1.boundingBox.width * $1.boundingBox.height }) {
                let b = face.boundingBox
                let round = { (v: CGFloat) in (Double(v) * 10_000).rounded() / 10_000 }
                samples.append([(t * 1000).rounded() / 1000, round(b.midX), round(1 - b.midY), round(b.height)])
            }
            if duration > 0 { progress(min(1, t / duration)) }
        }
        if reader.status == .failed { throw reader.error ?? CocoaError(.fileReadUnknown) }
        let data = try JSONSerialization.data(withJSONObject: ["v": 1, "samples": samples])
        try data.write(to: project.facesURL, options: .atomic)
        progress(1)
    }
}
