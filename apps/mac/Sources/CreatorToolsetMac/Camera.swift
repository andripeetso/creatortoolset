import AppKit
import AVFoundation
import CoreMedia

enum CameraError: LocalizedError {
    case noInput, nothingRecorded, write(String)

    var errorDescription: String? {
        switch self {
        case .noInput: return "Couldn't open the camera."
        case .nothingRecorded: return "The camera recorded nothing."
        case .write(let why): return "Couldn't save the camera video: \(why)"
        }
    }
}

/// Cameras the Mac can use, and the permission to use them.
enum CameraDevices {
    static var available: [AVCaptureDevice] {
        AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external], mediaType: .video, position: .unspecified).devices
    }

    /// Asks for camera permission the first time; true when the app may use the camera.
    static func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }
}

/// One capture session per camera, shared by the toolbar preview and the recorder (one camera cannot be opened twice).
/// Reference-counted: each `acquire` is paired with one `release`, and the session stops when the last holder lets go.
final class CameraSession: @unchecked Sendable {
    private static let lock = NSLock()
    private static var current: CameraSession?   // guarded by lock
    /// Starts and stops the session (startRunning blocks, so never on the caller's thread).
    private static let queue = DispatchQueue(label: "com.creatortoolset.camera.session")

    let device: AVCaptureDevice
    let session = AVCaptureSession()
    private var holders = 0   // guarded by lock

    /// The session for this camera, shared with the holder already using it.
    static func acquire(device: AVCaptureDevice) throws -> CameraSession {
        lock.lock()
        defer { lock.unlock() }
        if let shared = current, shared.device.uniqueID == device.uniqueID {
            shared.holders += 1
            return shared
        }
        let created = try CameraSession(device: device)
        created.holders = 1
        current = created
        return created
    }

    private init(device: AVCaptureDevice) throws {
        self.device = device
        let input = try AVCaptureDeviceInput(device: device)
        session.beginConfiguration()
        guard session.canAddInput(input) else {
            session.commitConfiguration()
            throw CameraError.noInput
        }
        session.addInput(input)
        session.commitConfiguration()
        try device.lockForConfiguration()
        defer { device.unlockForConfiguration() }
        if let format = Self.preferredFormat(in: device.formats) {
            device.activeFormat = format
            device.activeVideoMinFrameDuration = CMTime(value: 1, timescale: 30)
            device.activeVideoMaxFrameDuration = CMTime(value: 1, timescale: 30)
        }
    }

    /// 1280×720 when the camera has it, else the largest format up to 1080p that runs at 30 fps.
    static func preferredFormat(in formats: [AVCaptureDevice.Format]) -> AVCaptureDevice.Format? {
        let candidates: [(format: AVCaptureDevice.Format, rank: (Int, Int))] = formats.compactMap { format in
            let size = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
            guard size.width <= 1920, size.height <= 1080,
                  format.videoSupportedFrameRateRanges.contains(where: { $0.minFrameRate <= 30 && 30 <= $0.maxFrameRate })
            else { return nil }
            let is720 = size.width == 1280 && size.height == 720 ? 1 : 0
            return (format, (is720, Int(size.width) * Int(size.height)))
        }
        return candidates.max { $0.rank < $1.rank }?.format
    }

    /// Runs the session if it is not running yet.
    func start() {
        Self.queue.async { if !self.session.isRunning { self.session.startRunning() } }
    }

    /// Gives up one hold; the last hold stops the session.
    func release() {
        Self.lock.lock()
        holders -= 1
        let last = holders <= 0
        if last, Self.current === self { Self.current = nil }
        Self.lock.unlock()
        guard last else { return }
        Self.queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }
}

/// A span of host time the camera is paused: `end` is nil while it is still paused.
struct CameraPause: Equatable {
    var start: CMTime
    var end: CMTime?
}

/// The retiming rule for camera frames: host time in, the file's time out (t 0 = the screen recording's first frame,
/// pauses removed), or nil for a frame that is dropped (before the first frame, or during a pause).
enum CameraTiming {
    static func outputTime(host: CMTime, begin: CMTime?, pauses: [CameraPause]) -> CMTime? {
        guard let begin, host.isValid, host >= begin else { return nil }
        var paused = CMTime.zero
        for span in pauses {
            if host < span.start { continue }
            guard let end = span.end else { return nil }   // still paused at this frame
            if host < end { return nil }                  // the frame was caught during the pause
            if end > begin { paused = paused + (end - max(span.start, begin)) }
        }
        return host - begin - paused
    }
}

/// The camera's own video file. Frames come from the shared session and are retimed onto the screen recording's
/// clock (CameraTiming). All mutable state is touched only on `queue`.
final class CameraRecorder: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.creatortoolset.camera")
    private let camera: CameraSession
    private let output = AVCaptureVideoDataOutput()
    private let writer: AVAssetWriter
    private let input: AVAssetWriterInput
    private var startHost: CMTime?
    private var pauses: [CameraPause] = []
    private var last: CMTime?
    private var writing = false
    private var sessionStarted = false
    private var finished = false
    private var failed: Error?

    /// Opens the camera (shared with any preview of it) and a writer for `file`. Nothing is captured until startSession().
    init(device: AVCaptureDevice, file: URL) throws {
        camera = try CameraSession.acquire(device: device)
        let size = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
        do {
            writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
        } catch {
            camera.release()
            throw error
        }
        writer.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)   // a crash leaves a playable file
        input = AVAssetWriterInput(mediaType: .video, outputSettings: recorderVideoSettings(
            width: Int(size.width), height: Int(size.height), bitRate: 6_000_000, frameRate: 30))
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else {
            camera.release()
            throw CameraError.write("the writer refused the video track")
        }
        writer.add(input)
        super.init()
        output.alwaysDiscardsLateVideoFrames = true
        camera.session.beginConfiguration()
        guard camera.session.canAddOutput(output) else {
            camera.session.commitConfiguration()
            camera.release()
            throw CameraError.noInput
        }
        camera.session.addOutput(output)
        camera.session.commitConfiguration()
        output.setSampleBufferDelegate(self, queue: queue)
    }

    /// Starts the camera. Frames are dropped until begin(atHost:).
    func startSession() {
        queue.async {
            if !self.writing, !self.finished {
                self.writing = self.writer.startWriting()
                if !self.writing { self.failed = self.writer.error ?? CameraError.write("the writer would not start") }
            }
        }
        camera.start()
    }

    /// The host-clock time of the screen recording's first frame: output time 0.
    func begin(atHost host: CMTime) {
        queue.async { if self.startHost == nil { self.startHost = host } }
    }

    func pause(atHost host: CMTime) {
        queue.async {
            if let open = self.pauses.last, open.end == nil { return }
            self.pauses.append(CameraPause(start: host, end: nil))
        }
    }

    func resume(atHost host: CMTime) {
        queue.async {
            guard let open = self.pauses.indices.last, self.pauses[open].end == nil else { return }
            self.pauses[open].end = host
        }
    }

    /// Finishes the file at `host` (a paused stop ends at the pause), holding the last frame.
    func stop(atHost host: CMTime) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            queue.async {
                guard !self.finished else { done.resume(); return }
                self.finished = true
                var endHost = host
                if let open = self.pauses.last, open.end == nil { endHost = open.start }
                self.detach()
                guard self.sessionStarted, self.failed == nil else {
                    self.writer.cancelWriting()
                    done.resume(throwing: self.failed ?? CameraError.nothingRecorded)
                    return
                }
                let end = CameraTiming.outputTime(host: endHost, begin: self.startHost, pauses: self.pauses) ?? .zero
                self.input.markAsFinished()
                self.writer.endSession(atSourceTime: max(end, self.last ?? .zero))
                self.writer.finishWriting {
                    if self.writer.status == .completed { done.resume() }
                    else { done.resume(throwing: CameraError.write(self.writer.error?.localizedDescription ?? "unknown")) }
                }
            }
        }
    }

    /// Stops and throws the camera file away (the file is left unfinished on disk; the caller deletes the project).
    func cancel() {
        queue.async {
            guard !self.finished else { return }
            self.finished = true
            self.detach()
            self.writer.cancelWriting()
        }
    }

    /// Runs on `queue`: no more frames, the output leaves the session, and this recorder's hold on the camera ends.
    private func detach() {
        output.setSampleBufferDelegate(nil, queue: nil)
        camera.session.beginConfiguration()
        camera.session.removeOutput(output)
        camera.session.commitConfiguration()
        camera.release()
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard failed == nil, !finished, sampleBuffer.isValid, writing,
              let clock = camera.session.synchronizationClock,
              let timing = try? sampleBuffer.sampleTimingInfos(), let first = timing.first else { return }
        let hostClock = CMClockGetHostTimeClock()
        // the frame's own time on the host clock, then the same retiming as the screen (Capture.append)
        let host = CMSyncConvertTime(first.presentationTimeStamp, from: clock, to: hostClock)
        guard let at = CameraTiming.outputTime(host: host, begin: startHost, pauses: pauses) else { return }
        let shift = at - host
        var retimed = timing
        for i in retimed.indices {
            retimed[i].presentationTimeStamp = CMSyncConvertTime(timing[i].presentationTimeStamp, from: clock, to: hostClock) + shift
            if timing[i].decodeTimeStamp.isValid {
                retimed[i].decodeTimeStamp = CMSyncConvertTime(timing[i].decodeTimeStamp, from: clock, to: hostClock) + shift
            }
        }
        guard at >= .zero, at > (last ?? .negativeInfinity), input.isReadyForMoreMediaData,
              let moved = try? CMSampleBuffer(copying: sampleBuffer, withNewTiming: retimed) else { return }
        if !sessionStarted {
            writer.startSession(atSourceTime: .zero)
            sessionStarted = true
        }
        if input.append(moved) { last = at }
        else if writer.status == .failed { failed = writer.error ?? CameraError.write("the encoder stopped") }
    }
}

/// The toolbar's camera preview: a round, mirrored, floating, non-activating 180 pt window in the bottom-left corner.
/// It holds the camera's session (the same one the recorder uses) until `close()`.
@MainActor
enum CameraPreview {
    private static var panel: NSWindow?
    private static var camera: CameraSession?

    static var window: NSWindow? { panel }

    /// Shows the preview on `screen`, replacing any earlier one. No preview if the camera cannot be opened.
    static func show(device: AVCaptureDevice, on screen: NSScreen) {
        close()
        guard let shared = try? CameraSession.acquire(device: device) else { return }
        let size: CGFloat = 180
        let view = NSView(frame: NSRect(x: 0, y: 0, width: size, height: size))
        view.wantsLayer = true
        view.layer?.cornerRadius = size / 2
        view.layer?.masksToBounds = true
        view.layer?.backgroundColor = NSColor.black.cgColor
        let layer = AVCaptureVideoPreviewLayer(session: shared.session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = view.bounds
        layer.connection?.automaticallyAdjustsVideoMirroring = false
        layer.connection?.isVideoMirrored = true
        view.layer?.addSublayer(layer)

        let frame = screen.visibleFrame
        let window = NSPanel(
            contentRect: NSRect(x: frame.minX + 24, y: frame.minY + 24, width: size, height: size),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.level = .floating
        window.isFloatingPanel = true
        window.isMovableByWindowBackground = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.hidesOnDeactivate = false
        window.isReleasedWhenClosed = false
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.contentView = view
        window.orderFrontRegardless()
        panel = window
        camera = shared
        shared.start()
    }

    /// Hides the preview and gives up its hold on the camera (the session stops when nothing else holds it).
    static func close() {
        panel?.orderOut(nil)
        panel = nil
        camera?.release()
        camera = nil
    }
}
