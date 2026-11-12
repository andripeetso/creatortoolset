// Screen recording. Record opens the toolbar (RecordToolbar.swift: Display / Window / Area, camera, microphone, Mac
// sound); the source picker (SourcePicker.swift) chooses what to record; then a count-in and the floating bar. The
// picture is captured at its own sharpness up to 4K, 60 fps, without the system pointer: the pointer's path and clicks
// are logged beside the video, so the editor (src/lib/screen-recording.ts) draws a smooth, larger pointer and zooms in
// where you click. The voice is the file's first sound track, the Mac's own sound a second one, never mixed; a camera
// is its own file on the same clock (Camera.swift). Nothing renders and nothing uploads at Stop: the recording is a
// folder on this Mac (LocalProject.swift) and a small preview (RecordingPreview.swift) offers Edit, Save, Copy and
// Share. Needs macOS 15 (the microphone comes through the same capture stream, so voice and picture share one clock).
// An iPhone or iPad on a cable is recorded into the same files from a capture session (Phone.swift): its screen, its
// sound where the Mac's would be, no pointer log.
import AVFoundation
import Combine
import AppKit
import ScreenCaptureKit
import SwiftUI
import VideoToolbox

/// What Review reads beside the video (api/review.ts, PUT …/screen/events): seconds from the first frame,
/// positions as 0–1 of the recorded source (top left 0,0; outside 0–1 = the pointer was outside it).
struct ScreenEvents: Codable {
    var v = 1
    var width = 0
    var height = 0
    var moves: [[Double]] = []    // [t, x, y]
    var clicks: [[Double]] = []   // [t, x, y], the press
    var releases: [[Double]] = [] // [t, x, y], the button coming up again: a drag lasts from its press to here
    var audio: [String] = []      // the sound tracks in file order: "mic", "system"
}

/// The pointer at `location` (NSEvent.mouseLocation: global points, origin bottom left of the main display) as 0–1 of
/// `display` (the recorded rect in global points, origin top left, like CGDisplayBounds), rounded to 1/10000.
func normalizedPointer(_ location: CGPoint, display: CGRect, mainHeight: CGFloat) -> (x: Double, y: Double) {
    let round = { (v: CGFloat) in (Double(v) * 10_000).rounded() / 10_000 }
    return (round((location.x - display.minX) / display.width), round((mainHeight - location.y - display.minY) / display.height))
}

/// The capture size: the display's pixels, scaled down to fit 3840 on the long side and 4K's pixel count in all,
/// which keeps the file at H.264 level 5.2 (a 3008×3130 window at full sharpness comes out as level 6.0, which
/// fewer players and web views take), even numbers for the encoder.
func captureSize(points: CGSize, scale: CGFloat) -> (width: Int, height: Int) {
    let w = points.width * scale, h = points.height * scale
    let k = min(1, 3840 / max(w, h), (3840 * 2160 / (w * h)).squareRoot())
    let even = { (v: CGFloat) in max(2, Int((v * scale * k) / 2) * 2) }
    return (even(points.width), even(points.height))
}

/// Where the recording bar goes, all in AppKit's global points (y grows upwards): centred under the recorded window
/// or area, 10 pt below it; 10 pt above it when that does not fit in `visible`; inside it, 16 pt above its bottom
/// edge, when neither fits (a window as tall as the screen). No rect (a whole display): the top centre. Always
/// fully inside `visible`.
func barOrigin(recorded: CGRect?, visible: CGRect, size: CGSize) -> CGPoint {
    guard let r = recorded else { return CGPoint(x: visible.midX - size.width / 2, y: visible.maxY - size.height - 12) }
    let below = r.minY - 10 - size.height, above = r.maxY + 10
    let y = below >= visible.minY ? below : (above + size.height <= visible.maxY ? above : r.minY + 16)
    return PickerGeometry.clamped(CGRect(x: r.midX - size.width / 2, y: y, width: size.width, height: size.height), to: visible, scale: 1).origin
}

/// Where the panel shown after Stop goes (AppKit's global points): the recorded window's or area's bottom right
/// corner, 16 pt inside it, where the eyes already are; the screen's for a whole display. Always fully inside `visible`.
func previewOrigin(recorded: CGRect?, visible: CGRect, size: CGSize) -> CGPoint {
    let r = recorded ?? visible
    return PickerGeometry.clamped(CGRect(x: r.maxX - size.width - 16, y: r.minY + 16, width: size.width, height: size.height), to: visible, scale: 1).origin
}

/// Whether a pointer event is logged as a click: a button going down, but not on one of the app's own floating
/// windows (a press on the bar's Stop is not a place for the editor to zoom in on).
func logsClick(_ type: NSEvent.EventType, on window: NSWindow?, own: [NSWindow]) -> Bool {
    [.leftMouseDown, .rightMouseDown].contains(type) && !own.contains { $0 === window }
}

/// Whether a pointer event is logged as a release: a button coming up, by the same rule. The editor keeps a zoom
/// through a drag by it (press to release), as it keeps one through clicks that follow each other.
func logsRelease(_ type: NSEvent.EventType, on window: NSWindow?, own: [NSWindow]) -> Bool {
    [.leftMouseUp, .rightMouseUp].contains(type) && !own.contains { $0 === window }
}

/// Seconds as m:ss (h:mm:ss from an hour on).
func clockText(_ t: TimeInterval) -> String {
    let s = Int(t)
    return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
}

private func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

/// An error for the log with its domain and code, and those of the one under it: "could not be completed" alone
/// says nothing.
private func withCodes(_ error: Error) -> String {
    let e = error as NSError
    let under = (e.userInfo[NSUnderlyingErrorKey] as? NSError).map { ", under it \($0.domain) \($0.code)" } ?? ""
    return "\(e.localizedDescription) (\(e.domain) \(e.code)\(under))"
}

enum RecorderError: LocalizedError {
    case noDisplay, nothingRecorded, write(String), noDevice, deviceGone, deviceSilent

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "Couldn't find the display to record."
        case .nothingRecorded: return "Nothing was recorded."
        case .write(let why): return "Couldn't save the recording: \(why)"
        case .noDevice: return "The device is no longer connected."
        case .deviceGone: return "The device stopped sending its screen."
        case .deviceSilent: return "The device isn't sending its screen. Unlock it and try again."
        }
    }
}

/// One recording: the capture stream (or a device's capture session) into an MP4, and the pointer log. Every mutable
/// field is touched only on `queue` (the sample queue of both), so no locks.
@available(macOS 15.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureVideoDataOutputSampleBufferDelegate,
                     AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.creatortoolset.recorder")
    private let writer: AVAssetWriter
    private let video: AVAssetWriterInput
    private let mic: AVAssetWriterInput?
    private let system: AVAssetWriterInput?
    private var stream: SCStream?
    /// A device on a cable, in place of the stream: its session, the outputs this recording added to it, the
    /// microphone's input and what is watched for the device going away.
    private var phone: PhoneSession?
    private let phonePicture = AVCaptureVideoDataOutput()
    private let phoneSound = AVCaptureAudioDataOutput()
    private let phoneVoice = AVCaptureAudioDataOutput()
    private var phoneMic: AVCaptureDeviceInput?
    private var phoneWatch: [NSObjectProtocol] = []
    /// Host time of the first frame plus every pause so far: a buffer's time in the file is its host time minus this.
    private var offset: CMTime?
    private var pausedAt: CMTime?
    private var last: [ObjectIdentifier: CMTime] = [:]
    private var lastMove = -1.0
    private var failed: Error?
    /// Each sound track is written in one layout, whatever layout its buffers come in (SoundLayout).
    private var micLayout = SoundLayout(mono: true)
    private var systemLayout = SoundLayout()
    /// Puts a picture of another size than the file's into it whole (`fitted`).
    private var fitter: VTPixelTransferSession?
    private var fitPool: CVPixelBufferPool?
    private(set) var events: ScreenEvents
    /// The stream stopped by itself (display gone, permission taken away): called once, on `queue`.
    var onStop: ((Error) -> Void)?
    /// The first frame arrived, at this host time (the file's 0): the camera starts its clock there. On `queue`.
    var onFirstFrame: ((CMTime) -> Void)?

    init(file: URL, width: Int, height: Int, mic withMic: Bool, system withSystem: Bool) throws {
        writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
        writer.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)   // a crash leaves a playable file
        // ponytail: one bitrate for every screen (~20 Mbit/s at 4K, more than text needs); per-content rate control if files run big
        video = AVAssetWriterInput(mediaType: .video, outputSettings: recorderVideoSettings(
            width: width, height: height, bitRate: max(6_000_000, width * height * 60 / 25), frameRate: 60))
        video.expectsMediaDataInRealTime = true
        // the voice in one channel (it plays in both ears), the sound of the Mac or the device in two
        let aac = { (channels: Int, bitRate: Int) -> [String: Any] in
            [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: channels, AVEncoderBitRateKey: bitRate]
        }
        mic = withMic ? AVAssetWriterInput(mediaType: .audio, outputSettings: aac(1, 128_000)) : nil
        system = withSystem ? AVAssetWriterInput(mediaType: .audio, outputSettings: aac(2, 192_000)) : nil
        events = ScreenEvents(width: width, height: height)
        super.init()
        writer.add(video)
        // the voice first: players, Review's transcode and the export all take the first sound track
        if let mic { writer.add(mic); mic.expectsMediaDataInRealTime = true; events.audio.append("mic") }
        if let system { writer.add(system); system.expectsMediaDataInRealTime = true; events.audio.append("system") }
    }

    /// Opens the file for writing: the first thing either kind of recording does.
    func open() throws {
        guard writer.startWriting() else { throw RecorderError.write(writer.error?.localizedDescription ?? "the writer refused") }
    }

    func start(filter: SCContentFilter, config: SCStreamConfiguration) async throws {
        try open()
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if config.capturesAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
        if config.captureMicrophone { try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }
        self.stream = stream
        try await stream.startCapture()
    }

    /// Records a device on a cable from its running session: its screen, its sound when `sound` (the track the Mac's
    /// sound has in a screen recording), and the Mac's microphone as the voice. Each output is tied to its own port by
    /// hand: a session left to connect them itself has two sound sources to choose from.
    func start(phone: PhoneSession, mic: AVCaptureDevice?, sound: Bool) throws {
        try open()
        let session = phone.session
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        func tie(_ output: AVCaptureOutput, to port: AVCaptureInput.Port?) throws {
            guard let port else { throw RecorderError.noDevice }
            session.addOutputWithNoConnections(output)
            let link = AVCaptureConnection(inputPorts: [port], output: output)
            guard session.canAddConnection(link) else { throw RecorderError.noDevice }
            session.addConnection(link)
        }
        // the same pixel layout the screen is captured in, where the device can be read that way
        let wanted = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        if phonePicture.availableVideoPixelFormatTypes.contains(wanted) {
            phonePicture.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: wanted]
        }
        try tie(phonePicture, to: phone.input.ports.first { $0.mediaType == .video })
        phonePicture.setSampleBufferDelegate(self, queue: queue)
        if system != nil, sound, let port = phone.input.ports.first(where: { $0.mediaType == .audio }) {
            try tie(phoneSound, to: port)
            phoneSound.setSampleBufferDelegate(self, queue: queue)
        }
        if self.mic != nil, let mic {
            let input = try AVCaptureDeviceInput(device: mic)
            guard session.canAddInput(input) else { throw RecorderError.write("the microphone could not be opened") }
            session.addInputWithNoConnections(input)
            phoneMic = input
            try tie(phoneVoice, to: input.ports.first { $0.mediaType == .audio })
            phoneVoice.setSampleBufferDelegate(self, queue: queue)
        }
        self.phone = phone
        // unplugged, switched off, or the session gave up: the recording stops by itself and keeps what it has
        let gone: (Notification) -> Void = { [weak self] note in
            if let error = note.userInfo?[AVCaptureSessionErrorKey] as? Error { AppLog.write("device session: \(withCodes(error))") }
            self?.queue.async { self?.fail(RecorderError.deviceGone) }
        }
        phoneWatch = [
            NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil, using: gone),
            NotificationCenter.default.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: phone.device, queue: nil, using: gone),
        ]
        phone.start()   // it is running already when the panel before the recording showed it
    }

    /// No more buffers from the device: this recording's outputs and the microphone leave its session, which stops.
    /// Not on `queue`: taking an output away waits for its last buffer to be handed over there.
    private func leavePhone() {
        guard let phone else { return }
        self.phone = nil
        phoneWatch.forEach(NotificationCenter.default.removeObserver)
        phoneWatch = []
        phonePicture.setSampleBufferDelegate(nil, queue: nil)
        phoneSound.setSampleBufferDelegate(nil, queue: nil)
        phoneVoice.setSampleBufferDelegate(nil, queue: nil)
        let session = phone.session
        session.beginConfiguration()
        for output in [phonePicture, phoneSound, phoneVoice] as [AVCaptureOutput] where session.outputs.contains(output) {
            session.removeOutput(output)
        }
        if let phoneMic { session.removeInput(phoneMic) }
        session.commitConfiguration()
        phoneMic = nil
        phone.stop()
    }

    func pause() {
        let now = hostNow()
        queue.async { if self.pausedAt == nil { self.pausedAt = now } }
    }

    func resume() {
        let now = hostNow()
        queue.async {
            if let paused = self.pausedAt, let offset = self.offset { self.offset = offset + (now - paused) }
            self.pausedAt = nil
        }
    }

    /// Closes the file. The video lasts until now (a still screen sends no new frames, so the last one is held).
    func stop() async throws -> ScreenEvents {
        let now = hostNow()
        try? await stream?.stopCapture()
        leavePhone()
        return try await withCheckedThrowingContinuation { done in
            queue.async {
                // a stream that failed midway (display gone, permission taken) still keeps what it wrote
                guard let offset = self.offset, self.writer.status == .writing else {
                    // a writer that failed keeps its file (the fragments written before the failure play), and its
                    // error is never "nothing recorded", which would throw the folder away
                    if self.writer.status != .failed { self.writer.cancelWriting() }
                    done.resume(throwing: self.failed ?? self.writer.error ?? RecorderError.nothingRecorded)
                    return
                }
                let leftOut = self.micLayout.leftOut + self.systemLayout.leftOut
                if leftOut > 0 { AppLog.write("recording: \(leftOut) sound buffers that could not be read left out") }
                [self.video, self.mic, self.system].compactMap { $0 }.forEach { $0.markAsFinished() }
                self.writer.endSession(atSourceTime: max((self.pausedAt ?? now) - offset, self.last[ObjectIdentifier(self.video)] ?? .zero))
                self.writer.finishWriting {
                    if self.writer.status == .completed { return done.resume(returning: self.events) }
                    if let error = self.writer.error { AppLog.write("recording not closed: \(withCodes(error))") }
                    done.resume(throwing: RecorderError.write(self.writer.error?.localizedDescription ?? "unknown"))
                }
            }
        }
    }

    /// The pointer log so far (written beside the video every few seconds, so a crash keeps most of it).
    func eventsSoFar(_ done: @escaping @Sendable (ScreenEvents) -> Void) {
        queue.async { done(self.events) }
    }

    func cancel() {
        Task { try? await stream?.stopCapture() }
        leavePhone()
        queue.async {
            if self.failed == nil { self.failed = RecorderError.nothingRecorded }   // later buffers are dropped
            self.writer.cancelWriting()
        }
    }

    /// The pointer moved (`click` = a button went down, `release` = it came up again), as 0–1 of the display.
    func note(x: Double, y: Double, click: Bool, release: Bool = false) {
        let now = hostNow()
        queue.async {
            guard self.pausedAt == nil, let offset = self.offset else { return }
            let t = ((now - offset).seconds * 1000).rounded() / 1000
            guard t >= 0 else { return }
            if click { self.events.clicks.append([t, x, y]) }
            else if release { self.events.releases.append([t, x, y]) }
            // ponytail: moves at most 30 a second (an hour ≈ 3 MB); Review interpolates between them
            else if t - self.lastMove >= 1.0 / 30 { self.events.moves.append([t, x, y]); self.lastMove = t }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        switch type {
        case .screen:
            // only frames with a picture (a still screen sends "idle" ones without)
            guard buffer.isValid,
                  let info = (CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
                  let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
            take(buffer, .picture)
        case .microphone: take(buffer, .voice)
        case .audio: take(buffer, .sound)
        @unknown default: break
        }
    }

    /// A device's buffers. Its session stamps them by its own clock (the host clock itself for most devices); the
    /// pause, the camera and the file all go by the host clock, so they are put on it first.
    func captureOutput(_ output: AVCaptureOutput, didOutput buffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let track: Track = output === phonePicture ? .picture : output === phoneVoice ? .voice : .sound
        let host = CMClockGetHostTimeClock()
        guard let clock = phone?.session.synchronizationClock, !CFEqual(clock, host) else { return take(buffer, track) }
        guard var timing = try? buffer.sampleTimingInfos(), !timing.isEmpty else { return }
        for i in timing.indices {
            timing[i].presentationTimeStamp = CMSyncConvertTime(timing[i].presentationTimeStamp, from: clock, to: host)
            if timing[i].decodeTimeStamp.isValid { timing[i].decodeTimeStamp = CMSyncConvertTime(timing[i].decodeTimeStamp, from: clock, to: host) }
        }
        if let moved = try? CMSampleBuffer(copying: buffer, withNewTiming: timing) { take(moved, track) }
    }

    /// What a buffer is: the picture, the voice (the first sound track) or the sound of what is recorded (the second).
    enum Track { case picture, voice, sound }

    /// One buffer of the recording, timed on the host clock, from the stream or from a device. The first picture is
    /// the file's time 0; anything before it is dropped. On `queue`.
    func take(_ buffer: CMSampleBuffer, _ track: Track) {
        guard buffer.isValid, pausedAt == nil, failed == nil else { return }
        switch track {
        case .picture:
            guard let picture = fitted(buffer) else { return }
            if offset == nil {
                offset = picture.presentationTimeStamp
                writer.startSession(atSourceTime: .zero)
                onFirstFrame?(picture.presentationTimeStamp)
            }
            append(picture, to: video)
        case .voice: if let mic, let plain = micLayout.take(buffer) { append(plain, to: mic) }
        case .sound: if let system, let plain = systemLayout.take(buffer) { append(plain, to: system) }
        }
    }

    /// `buffer` in the file's size. A device turned on its side sends its picture the other way round, and the
    /// encoder would stretch it to the file's shape: it is put in the middle instead, whole, with black beside it. A
    /// picture of the file's size (every frame of a screen recording) is the buffer itself. nil when it cannot be made.
    private func fitted(_ buffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard let image = buffer.imageBuffer else { return nil }
        if CVPixelBufferGetWidth(image) == events.width, CVPixelBufferGetHeight(image) == events.height { return buffer }
        if fitter == nil {
            VTPixelTransferSessionCreate(allocator: nil, pixelTransferSessionOut: &fitter)
            if let fitter { VTSessionSetProperty(fitter, key: kVTPixelTransferPropertyKey_ScalingMode, value: kVTScalingMode_Letterbox) }
            let attributes: [CFString: Any] = [kCVPixelBufferWidthKey: events.width, kCVPixelBufferHeightKey: events.height,
                                               kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                               kCVPixelBufferIOSurfacePropertiesKey: [:] as CFDictionary]
            CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &fitPool)
        }
        var made: CVPixelBuffer?
        guard let fitter, let fitPool, CVPixelBufferPoolCreatePixelBuffer(nil, fitPool, &made) == kCVReturnSuccess, let made,
              VTPixelTransferSessionTransferImage(fitter, from: image, to: made) == noErr,
              let format = try? CMVideoFormatDescription(imageBuffer: made),
              let timing = try? buffer.sampleTimingInfos().first else { return nil }
        return try? CMSampleBuffer(imageBuffer: made, formatDescription: format, sampleTiming: timing)
    }

    /// The buffer at its time in the file: dropped before the first frame, when out of order (a buffer caught during a
    /// pause that arrives after it), or when the encoder is behind (dropping beats stalling the capture).
    private func append(_ buffer: CMSampleBuffer, to input: AVAssetWriterInput) {
        guard let offset, input.isReadyForMoreMediaData,
              var timing = try? buffer.sampleTimingInfos(), !timing.isEmpty else { return }
        for i in timing.indices {
            timing[i].presentationTimeStamp = timing[i].presentationTimeStamp - offset
            if timing[i].decodeTimeStamp.isValid { timing[i].decodeTimeStamp = timing[i].decodeTimeStamp - offset }
        }
        let at = timing[0].presentationTimeStamp
        let key = ObjectIdentifier(input)
        guard at >= .zero, at > (last[key] ?? .negativeInfinity),
              let moved = try? CMSampleBuffer(copying: buffer, withNewTiming: timing) else { return }
        if input.append(moved) { last[key] = at }
        else if writer.status == .failed { fail(writer.error ?? RecorderError.write("the encoder stopped")) }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.fail(error) }
    }

    private func fail(_ error: Error) {
        guard failed == nil else { return }
        failed = error
        onStop?(error)
    }
}

/// Record → toolbar → source → count-in → recording → a project folder and its preview. Shares go through `upload`.
@MainActor
final class Recorder: ObservableObject {
    enum Phase: Equatable { case idle, toolbar, countdown(Int), recording, paused, saving, uploading(Double) }

    @Published private(set) var phase = Phase.idle {
        // the large number is on screen only during the count-in, however that ends
        didSet { if case .countdown = phase {} else { CountIn.close() } }
    }
    /// The toolbar's choices (source kind, microphone, camera, Mac sound), remembered between recordings.
    let setup = RecordSetup()
    @AppStorage("recordingsFolder") private var folderPath = ""
    /// Uploads a recording's original file and returns the page to open (Shell → Site.uploadRecording).
    var upload: ((LocalProject, ShareDestination, @escaping @Sendable (Double) -> Void) async throws -> String)?
    var openPage: ((String) -> Void)?
    /// The list of recordings on this Mac changed (a stop, a delete): the /record page asks again.
    var onRecordingsChanged: (() -> Void)?

    init() { ScreenPermission.watchActivation() }

    static var available: Bool {
        if #available(macOS 15.0, *) { return true }
        return false
    }

    private var capture: AnyObject?
    private var camera: CameraRecorder?
    private var project: LocalProject?
    /// The recorded window or area in AppKit's global points (origin bottom left of the main display), nil for a
    /// whole display: the count-in, the bar and the panel after Stop are placed by it. Kept until `finish()`.
    private var recorded: CGRect?
    private var panel: NSPanel?
    private var monitors: [Any] = []
    private var saver: Timer?
    private var banked: TimeInterval = 0
    private var runFrom: Date?

    /// What the Screen Recorder page shows (src/lib/mac-record.ts): what it is doing and the folder.
    func pageState(_ phase: Phase? = nil) -> String {
        let name: String = switch phase ?? self.phase {
        case .idle: "idle"
        case .toolbar: "toolbar"
        case .countdown: "countdown"
        case .recording: "recording"
        case .paused: "paused"
        case .saving: "saving"
        case .uploading: "uploading"
        }
        let body: [String: Any] = ["phase": name, "folder": folder.path, "shortcut": RecordShortcut.shared.shortcut?.display ?? ""]
        return (try? JSONSerialization.data(withJSONObject: body)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    var elapsed: TimeInterval { banked + (runFrom.map { Date().timeIntervalSince($0) } ?? 0) }
    var busy: Bool { phase != .idle }

    /// Where recordings are kept (~/Movies/Creator Toolset unless picked). Static too: the ctlocal:// scheme reads it.
    var folder: URL { Self.folder }
    static var folder: URL {
        let picked = UserDefaults.standard.string(forKey: "recordingsFolder") ?? ""
        return picked.isEmpty
            ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies/Creator Toolset\(AppIdentity.tag())", isDirectory: true)
            : URL(fileURLWithPath: picked, isDirectory: true)
    }

    func pickFolder() {
        let open = NSOpenPanel()
        open.canChooseDirectories = true
        open.canChooseFiles = false
        open.canCreateDirectories = true
        open.prompt = "Keep recordings here"
        open.directoryURL = folder
        if open.runModal() == .OK, let url = open.url { folderPath = url.path }
        onRecordingsChanged?()
    }

    func showFolder() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(folder)
    }

    /// The recordings on this Mac, newest first, as the page lists them.
    var recordings: [LocalProject] { ProjectStore.list(root: folder) }

    // MARK: toolbar and source

    /// Record: the toolbar on the display under the pointer. Nothing records until a source is started.
    func openToolbar() {
        guard #available(macOS 15.0, *) else { return }
        if phase == .toolbar { return RecordToolbar.window?.orderFrontRegardless() ?? () }
        guard phase == .idle else { return }
        guard ScreenPermission.check() else { return }
        RecordingPreview.close()
        let screen = screenUnderPointer()
        phase = .toolbar
        RecordToolbar.show(on: screen, setup: setup,
                           onPick: { [weak self] kind in self?.pick(kind) },
                           onDevice: { [weak self] id in self?.pickDevice(id) },
                           onClose: { [weak self] in self?.closeToolbar() },
                           onFolder: { [weak self] in self?.pickFolder() },
                           onShowFolder: { [weak self] in self?.showFolder() })
        cameraPreview(on: screen)
        // the bubble follows the camera choice only: any other change of the toolbar leaves the open camera alone
        cameraWatch = setup.objectWillChange.sink { [weak self] in
            DispatchQueue.main.async {
                guard let self, self.phase == .toolbar, self.setup.cameraID != self.previewing else { return }
                self.cameraPreview(on: screen)
            }
        }
    }

    private var cameraWatch: AnyCancellable?
    /// The camera choice the bubble shows ("none" for none).
    private var previewing: String?

    /// The camera bubble follows the toolbar's camera choice while it is open.
    private func cameraPreview(on screen: NSScreen) {
        previewing = setup.cameraID
        guard let device = setup.cameraDevice else { return CameraPreview.close() }
        Task {
            if await CameraDevices.requestAccess(), self.phase == .toolbar { CameraPreview.show(device: device, on: screen) }
        }
    }

    private func closeToolbar() {
        SourcePicker.close()
        PhonePreview.close()
        RecordToolbar.close()
        CameraPreview.close()
        cameraWatch = nil
        previewing = nil
        if phase == .toolbar { phase = .idle }
    }

    func pick(_ kind: SourceKind) {
        guard phase == .toolbar, kind != .device else { return }
        PhonePreview.close()
        SourcePicker.pick(kind, onStart: { [weak self] source in
            guard let self, #available(macOS 15.0, *) else { return }
            Task { await self.begin(source) }
        }, onCancel: {})
    }

    /// Device → an iPhone or iPad: its picture in a panel with Start. macOS hands its screen over as a camera, so
    /// the camera permission is asked for here the first time.
    func pickDevice(_ id: String) {
        guard phase == .toolbar else { return }
        SourcePicker.close()
        Task {
            guard await CameraDevices.requestAccess() else {
                return alert("Allow the camera to record an iPhone or iPad",
                             "macOS hands a connected device's screen over as a camera. Turn Creator Toolset on in System Settings → Privacy & Security → Camera.")
            }
            guard phase == .toolbar else { return }
            guard let device = PhoneDevices.device(id) else { return alert("Couldn't open the device", RecorderError.noDevice.localizedDescription) }
            do {
                let phone = try PhoneSession(device: device)
                PhonePreview.show(phone, on: RecordToolbar.window?.screen ?? screenUnderPointer()) { [weak self] in
                    guard let self, #available(macOS 15.0, *) else { return }
                    Task { await self.begin(.device(id)) }
                }
            } catch {
                AppLog.write("device not opened: \(withCodes(error))")
                alert("Couldn't open \(device.localizedName)", "\(error.localizedDescription)\n\nUnlock it, and press Trust on it if it asks.")
            }
        }
    }

    /// A device's session between Start and the recording (the count-in), so that giving up stops it.
    private var phone: PhoneSession?

    // MARK: recording

    @available(macOS 15.0, *)
    func begin(_ source: RecordSource) async {
        guard phase == .toolbar else { return }   // one start at a time (a second pick while a prompt is open)
        phase = .countdown(3)
        let attempt = UUID()
        starting = attempt
        // Stop or Throw away during the count-in or the start sets the phase to idle: everything after an await checks
        let stillWanted = { [weak self] in self?.starting == attempt && self?.phase != .idle }
        var cameraDevice = setup.cameraDevice
        if cameraDevice != nil, !(await CameraDevices.requestAccess()) {
            AppLog.write("recording without the camera: access refused")
            cameraDevice = nil
        }
        SourcePicker.close()
        // the device's panel goes, its session stays: the device keeps sending through the count-in
        if case .device(let id) = source { phone = PhonePreview.handOver(id) }
        RecordToolbar.close()   // stops the level meter before the stream opens the same microphone
        cameraWatch = nil
        var micDevice = setup.micDevice
        if micDevice != nil, AVCaptureDevice.authorizationStatus(for: .audio) != .authorized,
           !(await AVCaptureDevice.requestAccess(for: .audio)) {
            AppLog.write("recording without the microphone: access refused")
            micDevice = nil
        }
        guard stillWanted() else { return }
        let screen = screen(of: source) ?? screenUnderPointer()
        recorded = appKitRect(of: source)
        showBar(on: screen)
        for n in [3, 2, 1] {
            phase = .countdown(n)
            CountIn.show(n, over: recorded ?? screen.frame, inside: screen.frame)
            NSSound(named: n == 1 ? "Pop" : "Tink")?.play()   // a beat per number; capture starts after the last one
            try? await Task.sleep(for: .seconds(1))
            if !stillWanted() { return }   // cancelled during the count-in
        }
        var made: (capture: Capture?, project: LocalProject?) = (nil, nil)
        do {
            // a device on a cable is recorded from its session; anything on the Mac's screen from the capture stream
            let feed = source.isDevice ? nil : try await screenFeed(source, on: screen, mic: micDevice)
            let device = source.isDevice ? phone : nil
            if source.isDevice, device == nil { throw RecorderError.noDevice }
            // the file is the size of the device's picture, which is known once it sends (Start can come before that)
            var sending: (width: Int, height: Int)?
            if let device {
                sending = await device.pixelsOnceSending(within: 5)
                if sending == nil { throw RecorderError.deviceSilent }
            }
            guard let size = feed?.size ?? sending else { throw RecorderError.noDevice }

            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let project = try LocalProject.create(in: folder, at: Date())
            made.project = project
            let capture = try Capture(file: project.screenURL, width: size.width, height: size.height,
                                      mic: micDevice != nil, system: setup.systemAudio)
            made.capture = capture
            capture.onStop = { [weak self] error in
                Task { @MainActor in self?.stoppedByItself(error) }
            }
            if let cameraDevice {
                do {
                    let camera = try CameraRecorder(device: cameraDevice, file: project.cameraURL)
                    camera.startSession()
                    capture.onFirstFrame = { host in camera.begin(atHost: host) }
                    self.camera = camera
                } catch {
                    AppLog.write("recording without the camera: \(error.localizedDescription)")   // the screen still records
                }
            }
            if let feed { try await capture.start(filter: feed.filter, config: feed.config) }
            else if let device { try capture.start(phone: device, mic: micDevice, sound: setup.systemAudio) }
            guard stillWanted() else { throw CancellationError() }
            self.capture = capture
            self.project = project
            phone = nil   // the recording has its session now, and stops it
            if let feed { watchPointer(capture, rect: feed.rect) }   // a device has no pointer
            saver = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { _ in
                capture.eventsSoFar { events in try? project.writeEvents(JSONEncoder().encode(events)) }
            }
            banked = 0
            runFrom = Date()
            phase = .recording
            AppLog.write("recording \(source.isDevice ? "a device, " : "")\(size.width)×\(size.height), mic \(micDevice != nil), \(source.isDevice ? "its" : "Mac") sound \(setup.systemAudio), camera \(cameraDevice != nil)")
        } catch {
            made.capture?.cancel()
            camera?.cancel()
            camera = nil
            phone?.stop()
            phone = nil
            try? made.project.map { try FileManager.default.removeItem(at: $0.folder) }   // nothing worth keeping yet
            if error is CancellationError { return }
            CameraPreview.close()
            closeBar()
            phase = .idle
            // without the permission, the failure is the permission flow's to show (check() asks or alerts once)
            if ScreenPermission.check() { alert("Couldn't start recording", error.localizedDescription) }
        }
    }

    /// What the capture stream records, and how, for a display, a window or an area: `rect` is the recorded part in
    /// global points (top left origin), `size` its pixels in the file.
    @available(macOS 15.0, *)
    private func screenFeed(_ source: RecordSource, on screen: NSScreen, mic micDevice: AVCaptureDevice?) async throws
        -> (filter: SCContentFilter, config: SCStreamConfiguration, rect: CGRect, size: (width: Int, height: Int)) {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        // our own floating windows stay out of the picture; the app's main window can still be recorded
        let ours = Set(ownWindows().map { CGWindowID($0.windowNumber) })
        let hidden = content.windows.filter { ours.contains($0.windowID) }
        var windowScale: CGFloat?
        let filter: SCContentFilter
        let rect: CGRect
        let config = SCStreamConfiguration()
        switch source {
        case .display(let id):
            guard let display = content.displays.first(where: { $0.displayID == id }) else { throw RecorderError.noDisplay }
            filter = SCContentFilter(display: display, excludingWindows: hidden)
            rect = CGDisplayBounds(id)
        case .window(let id, _):
            guard let window = content.windows.first(where: { $0.windowID == id }) else { throw RecorderError.noDisplay }
            filter = SCContentFilter(desktopIndependentWindow: window)
            // ponytail: the window's place at the start; a window moved while recording shifts the drawn pointer
            rect = window.frame
            let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
            let center = NSPoint(x: rect.midX, y: mainHeight - rect.midY)
            windowScale = NSScreen.screens.first { NSMouseInRect(center, $0.frame, false) }?.backingScaleFactor
        case .area(let id, let area):
            guard let display = content.displays.first(where: { $0.displayID == id }) else { throw RecorderError.noDisplay }
            filter = SCContentFilter(display: display, excludingWindows: hidden)
            config.sourceRect = area
            let bounds = CGDisplayBounds(id)
            rect = area.offsetBy(dx: bounds.minX, dy: bounds.minY)
        case .device:
            throw RecorderError.noDisplay   // not on the Mac's screen: begin() records it from its session
        }
        let size = captureSize(points: rect.size, scale: windowScale ?? screen.backingScaleFactor)
        config.width = size.width
        config.height = size.height
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.showsCursor = false
        config.queueDepth = 8
        config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        config.colorSpaceName = CGColorSpace.sRGB
        config.capturesAudio = setup.systemAudio
        // "Mac sound" is everything the Mac plays, this app's too: a recording of the app itself has its sound
        config.excludesCurrentProcessAudio = false
        config.sampleRate = 48_000
        config.channelCount = 2
        config.captureMicrophone = micDevice != nil
        if let micDevice, !setup.micID.isEmpty { config.microphoneCaptureDeviceID = micDevice.uniqueID }
        return (filter, config, rect, size)
    }

    /// The start in progress; `finish()` clears it, so a start interrupted by Stop or Throw away gives up.
    private var starting: UUID?

    private func watchPointer(_ capture: AnyObject, rect: CGRect) {
        guard #available(macOS 15.0, *), let capture = capture as? Capture else { return }
        let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
        let handle = { [weak self] (event: NSEvent) in
            let p = normalizedPointer(NSEvent.mouseLocation, display: rect, mainHeight: mainHeight)
            let own = self?.ownWindows() ?? []
            capture.note(x: p.x, y: p.y, click: logsClick(event.type, on: event.window, own: own),
                         release: logsRelease(event.type, on: event.window, own: own))
        }
        // pointer events need no permission (key presses would: not logged)
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .leftMouseDown, .rightMouseDown,
                                           .leftMouseUp, .rightMouseUp]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: handle) { monitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { handle($0); return $0 }) { monitors.append(local) }
        let start = normalizedPointer(NSEvent.mouseLocation, display: rect, mainHeight: mainHeight)
        capture.note(x: start.x, y: start.y, click: false)   // where it starts
    }

    func togglePause() {
        guard #available(macOS 15.0, *), let capture = capture as? Capture else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        if phase == .recording {
            capture.pause()
            camera?.pause(atHost: now)
            banked = elapsed
            runFrom = nil
            phase = .paused
        } else if phase == .paused {
            capture.resume()
            camera?.resume(atHost: now)
            runFrom = Date()
            phase = .recording
        }
    }

    /// The recording shortcut and the menu bar button (RecordShortcut.swift): start, or stop what is running.
    func toggle() {
        switch phase {
        case .idle: openToolbar()
        case .toolbar, .recording, .paused: stop()
        case .countdown: cancel()
        case .saving, .uploading: break
        }
    }

    /// Stop: the files are closed and the preview offers what to do with them. Nothing uploads here.
    func stop() {
        if case .countdown = phase { return finish() }
        if phase == .toolbar { return closeToolbar() }
        guard #available(macOS 15.0, *), let capture = capture as? Capture, var project,
              phase == .recording || phase == .paused else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        endWatching()
        phase = .saving
        let camera = self.camera
        Task {
            do {
                let events: ScreenEvents
                var early: Error?
                do { events = try await capture.stop() } catch {
                    // the writer failed midway: the file is written in fragments, so what came before plays. Keep it,
                    // with the pointer log so far, instead of leaving a folder nothing lists
                    guard let kept = try? await AVURLAsset(url: project.screenURL).load(.duration).seconds, kept >= 1 else {
                        camera?.cancel()
                        throw error
                    }
                    early = error
                    AppLog.write("recording stopped early, \(clockText(kept)) kept: \(withCodes(error))")
                    events = await withCheckedContinuation { done in capture.eventsSoFar { done.resume(returning: $0) } }
                    await rejoin(project.screenURL)
                }
                var hasCamera = camera != nil
                if let camera {
                    do { try await camera.stop(atHost: now) } catch {
                        AppLog.write("camera not kept: \(error.localizedDescription)")
                        hasCamera = false
                    }
                }
                try project.writeEvents(JSONEncoder().encode(events))
                let duration = try await AVURLAsset(url: project.screenURL).load(.duration)
                try project.markReady(durationMs: Int(duration.seconds * 1000), width: events.width, height: events.height,
                                      tracks: events.audio, camera: hasCamera)
                try? await project.writeThumb(from: project.screenURL)
                let near = recorded   // finish() forgets it
                let screen = near.flatMap(screen(holding:)) ?? panel?.screen ?? screenUnderPointer()
                finish()
                onRecordingsChanged?()
                showPreview(project, on: screen, near: near)
                if let early {
                    alert("The recording stopped early", "The first \(clockText(duration.seconds)) are kept.\n\n\(early.localizedDescription)")
                }
            } catch RecorderError.nothingRecorded {
                try? FileManager.default.removeItem(at: project.folder)
                finish()
            } catch {
                finish()
                alert("Couldn't save the recording", "\(error.localizedDescription)\n\nWhat was recorded is in \(project.folder.path).")
            }
        }
    }

    /// A recording that stopped early is a file of fragments, and the editor's export reads only the first of them
    /// (measured: 5 s of a 15 s take). Written again as one plain MP4, without encoding anything again; when that
    /// fails the fragments stay as they are, and still play.
    @available(macOS 15.0, *)
    private func rejoin(_ file: URL) async {
        let whole = file.deletingLastPathComponent().appendingPathComponent("screen-whole.mp4")
        try? FileManager.default.removeItem(at: whole)
        do {
            guard let export = AVAssetExportSession(asset: AVURLAsset(url: file), presetName: AVAssetExportPresetPassthrough) else { return }
            try await export.export(to: whole, as: .mp4)
            _ = try FileManager.default.replaceItemAt(file, withItemAt: whole)
        } catch {
            try? FileManager.default.removeItem(at: whole)
            AppLog.write("early recording kept as fragments: \(error.localizedDescription)")
        }
    }

    /// Throws the recording away. Once it has started, the bar asks first (RecorderBar), in the bar itself.
    func cancel() {
        if case .countdown = phase { return finish() }
        if phase == .toolbar { return closeToolbar() }
        guard #available(macOS 15.0, *), let capture = capture as? Capture else { return }
        capture.cancel()
        camera?.cancel()
        try? project?.delete()
        finish()
    }

    private func stoppedByItself(_ error: Error) {
        guard phase == .recording || phase == .paused else { return }
        AppLog.write("recording stopped: \(withCodes(error))")
        stop()
    }

    // MARK: after the recording

    private func showPreview(_ project: LocalProject, on screen: NSScreen, near recorded: CGRect?) {
        RecordingPreview.show(project, on: screen, near: recorded, actions: .init(
            edit: { [weak self] in
                RecordingPreview.close()
                self?.openPage?("/record/\(project.id)")
            },
            save: { [weak self] in self?.save(project) },
            copy: {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.writeObjects([project.screenURL as NSURL])
            },
            share: { [weak self] destination in Task { await self?.share(project, to: destination) } },
            reveal: { NSWorkspace.shared.activateFileViewerSelecting([project.screenURL]) },
            discard: { [weak self] in self?.delete(project) }))
    }

    /// The original file, saved where you choose.
    func save(_ project: LocalProject) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "\(project.name).mp4"
        panel.allowedContentTypes = [.mpeg4Movie]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            if FileManager.default.fileExists(atPath: url.path) { try FileManager.default.removeItem(at: url) }
            try FileManager.default.copyItem(at: project.screenURL, to: url)
        } catch {
            alert("Couldn't save the video", error.localizedDescription)
        }
    }

    /// The original file to Review, Video Notes or a new guide (a Video Notes clip the guide is made from).
    func share(_ project: LocalProject, to destination: ShareDestination) async {
        guard let upload, phase == .idle else { return }
        while true {
            phase = .uploading(0)
            RecordingPreview.setBusy("Uploading…")
            do {
                let page = try await upload(project, destination) { p in
                    Task { @MainActor in
                        if case .uploading = self.phase { self.phase = .uploading(p) }
                        RecordingPreview.setBusy("Uploading \(Int(p * 100))%")
                    }
                }
                phase = .idle
                RecordingPreview.close()
                openPage?(page)
                return
            } catch {
                AppLog.write("recording upload failed: \(error.localizedDescription)")
                phase = .idle
                RecordingPreview.setBusy(nil)
                let ask = NSAlert()
                ask.messageText = "The upload didn't finish"
                ask.informativeText = "\(error.localizedDescription)\n\nThe recording stays on this Mac."
                ask.addButton(withTitle: "Try Again")
                ask.addButton(withTitle: "OK")
                if ask.runModal() != .alertFirstButtonReturn { return }
            }
        }
    }

    /// Throws a finished recording away (to the Trash). The one who pressed asks first, in its own place: the page in the
    /// app's dialog ("trash:<id>"), the panel after Stop on the panel. `asking`: only for a page older than that, which
    /// sends "delete:<id>" and leaves the question to this app.
    func delete(_ project: LocalProject, asking: Bool = false) {
        if case .uploading = phase { return alert("Wait for the upload", "It can be thrown away when the upload is done.") }
        if asking {
            let ask = NSAlert()
            ask.messageText = "Throw \"\(project.name)\" away?"
            ask.informativeText = "It goes to the Trash."
            ask.addButton(withTitle: "Throw Away")
            ask.addButton(withTitle: "Cancel")
            guard ask.runModal() == .alertFirstButtonReturn else { return }
        }
        do {
            try project.delete()
            RecordingPreview.close()
            onRecordingsChanged?()
        } catch {
            alert("Couldn't throw it away", error.localizedDescription)
        }
    }

    // MARK: helpers

    private func endWatching() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors = []
        saver?.invalidate()
        saver = nil
        banked = elapsed
        runFrom = nil
    }

    private func finish() {
        starting = nil
        endWatching()
        capture = nil
        camera = nil
        project = nil
        recorded = nil
        phone?.stop()   // a start given up during the count-in
        phone = nil
        phase = .idle
        CameraPreview.close()
        PhonePreview.close()
        closeBar()
    }

    private func screenUnderPointer() -> NSScreen {
        let pointer = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens[0]
    }

    private func screen(of source: RecordSource) -> NSScreen? {
        let id: CGDirectDisplayID
        switch source {
        case .display(let d), .area(let d, _): id = d
        case .window: return appKitRect(of: source).flatMap(screen(holding:))
        case .device: return nil
        }
        return NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID) == id }
    }

    /// The screen a rect's centre is on (AppKit's global points).
    private func screen(holding rect: CGRect) -> NSScreen? {
        NSScreen.screens.first { NSMouseInRect(NSPoint(x: rect.midX, y: rect.midY), $0.frame, false) }
    }

    /// The window or area a source records, in AppKit's global points; nil for a whole display.
    private func appKitRect(of source: RecordSource) -> CGRect? {
        let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
        switch source {
        case .display, .device: return nil
        case .window(_, let frame): return PickerGeometry.topLeftFrame(frame, mainHeight: mainHeight)   // its own inverse
        case .area(let id, let area):
            let bounds = CGDisplayBounds(id)
            return PickerGeometry.topLeftFrame(area.offsetBy(dx: bounds.minX, dy: bounds.minY), mainHeight: mainHeight)
        }
    }

    /// The app's floating windows: never in the picture.
    private func ownWindows() -> [NSWindow] {
        ([panel, CountIn.window, RecordToolbar.window, CameraPreview.window, PhonePreview.window, RecordingPreview.window] as [NSWindow?]).compactMap { $0 }
            + SourcePicker.windows
    }

    // MARK: the floating bar

    private func showBar(on screen: NSScreen) {
        closeBar()
        let size = NSSize(width: 250, height: 44)
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.isFloatingPanel = true
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView: RecorderBar(recorder: self).frame(width: size.width, height: size.height))
        panel.setFrameOrigin(barOrigin(recorded: recorded, visible: screen.visibleFrame, size: size))
        panel.orderFrontRegardless()
        self.panel = panel
    }

    private func closeBar() {
        panel?.orderOut(nil)
        panel = nil
    }

    /// Shows a message in the open page's own dialog and answers whether it could (Shell sets it).
    var pageAlert: ((String, String, @escaping (Bool) -> Void) -> Void)?

    /// A message in the app's own dialog; the system's alert only when no page can draw it.
    private func alert(_ title: String, _ text: String) {
        let system = {
            let a = NSAlert()
            a.messageText = title
            a.informativeText = text
            a.runModal()
        }
        guard let pageAlert else { return system() }
        pageAlert(title, text) { shown in if !shown { system() } }
    }
}

/// The bar beside the recorded window or area, at the top of the screen for a whole display (left out of the
/// recording): the count-in, then time, Pause, Stop, Throw away.
struct RecorderBar: View {
    @ObservedObject var recorder: Recorder
    /// Throw away was pressed: the bar asks in its own place until Throw Away or Keep.
    @State private var asking = false

    var body: some View {
        HStack(spacing: 12) {
            switch recorder.phase {
            case .recording where asking, .paused where asking:
                Text("Throw away?")
                Button("Keep") { asking = false }
                Button("Throw Away") {
                    asking = false
                    recorder.cancel()
                }
                .foregroundStyle(.red)
            case .countdown(let n):
                Text("Recording in \(n)").monospacedDigit()
                Button("Cancel") { recorder.cancel() }
            case .recording, .paused:
                Circle().fill(recorder.phase == .paused ? Color.orange : Color.red).frame(width: 9, height: 9)
                TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                    Text(clockText(recorder.elapsed)).monospacedDigit().frame(width: 44, alignment: .leading)
                }
                Button { recorder.togglePause() } label: {
                    Image(systemName: recorder.phase == .paused ? "play.fill" : "pause.fill")
                }.help(recorder.phase == .paused ? "Resume" : "Pause")
                Button { recorder.stop() } label: { Image(systemName: "stop.fill") }.help("Stop (⌥⌘.)")
                Button { asking = true } label: { Image(systemName: "trash") }.help("Throw away")
            case .saving:
                ProgressView().controlSize(.small)
                Text("Saving…")
            case .idle, .toolbar, .uploading:
                EmptyView()
            }
        }
        .font(.system(size: 13, weight: .medium))
        .buttonStyle(.borderless)
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(.white)
        .background(Color.black.opacity(0.82), in: Capsule())
        .overlay(Capsule().strokeBorder(.white.opacity(0.12)))
        .environment(\.colorScheme, .dark)
    }
}

/// The count-in number, large, over what is about to be recorded (left out of the recording). Clicks pass through it.
@MainActor enum CountIn {
    static let size = NSSize(width: 120, height: 120)
    private static var panel: NSPanel?

    /// The panel on screen, nil when none is open.
    static var window: NSWindow? { panel }

    /// Shows `n` centred on `rect`, kept inside `bounds` (both in AppKit's global points).
    static func show(_ n: Int, over rect: CGRect, inside bounds: CGRect) {
        let view = NSHostingView(rootView: CountInView(n: n))
        if let panel { return panel.contentView = view }
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = view
        let centred = CGRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height)
        panel.setFrameOrigin(PickerGeometry.clamped(centred, to: bounds, scale: 1).origin)
        panel.orderFrontRegardless()
        self.panel = panel
    }

    static func close() {
        panel?.orderOut(nil)
        panel = nil
    }
}

struct CountInView: View {
    let n: Int

    var body: some View {
        Text("\(n)")
            .font(.system(size: 76, weight: .semibold).monospacedDigit())
            .foregroundStyle(.white)
            .frame(width: CountIn.size.width, height: CountIn.size.height)
            .background(Color.black.opacity(0.72), in: RoundedRectangle(cornerRadius: 28, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(.white.opacity(0.14)))
    }
}

extension Site {
    /// A recording's original file to Review (with its pointer log), Video Notes, or a new guide (a Video Notes clip the
    /// guide is made from), through the upload relay the server names (Review only), or the site's resumable upload (api/lib/uploads.ts: 16 MB parts, four at a time).
    /// Returns the page to open.
    func uploadRecording(_ project: LocalProject, to destination: ShareDestination, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        let file = project.screenURL
        let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
        let name = "\(project.name).mp4"
        let review = destination == .review
        var done = review ? try await viaRelay(file, name: name, size: size, progress: progress) : nil
        if done == nil { done = try await direct(file, name: name, size: size, review: review, progress: progress) }
        let finished = done ?? [:]
        guard let asset = finished["id"] as? String else { throw SiteError.status(0) }
        switch destination {
        case .notes: return "/clips/\(asset)"
        case .guide: return "/guides?clip=\(asset)"
        case .review: break
        }
        let n = ((finished["versions"] as? [[String: Any]])?.last?["n"] as? Int) ?? 1
        var put = request("PUT", "/api/review/assets/\(asset)/v/\(n)/screen/events")
        put.httpBody = try? Data(contentsOf: project.eventsURL)
        put.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // the video is in: a failed pointer log must not make Try Again upload it twice
        if (try? await checked(URLSession.shared.data(for: put))) == nil { AppLog.write("recording pointer log not sent to Review") }
        if let look = try? Data(contentsOf: project.lookURL) {
            var putLook = request("PUT", "/api/review/assets/\(asset)/v/\(n)/screen/look")
            putLook.httpBody = look
            putLook.setValue("application/json", forHTTPHeaderField: "Content-Type")
            _ = try? await checked(URLSession.shared.data(for: putLook))   // the zooms made on this Mac come along
        }
        return "/review/\(asset)?v=\(n)"
    }

    /// Review through the upload relay the server names (GET /api/uploads/relay, when it is not chunked or direct): tus
    /// straight to the relay in parts, then the server takes the file over and only the finish call is retried.
    /// nil = no such relay here, or it would not start: go direct.
    private func viaRelay(_ file: URL, name: String, size: Int, progress: @escaping @Sendable (Double) -> Void) async throws -> [String: Any]? {
        let view = try? await URLSession.shared.data(for: request("GET", "/api/uploads/relay"))
        let active = view.flatMap { (try? JSONSerialization.jsonObject(with: $0.0)) as? [String: Any] }?["active"] as? String
        guard let active, active != "chunked", active != "direct" else { return nil }
        var mint = request("POST", "/api/uploads/relay?relay=tus")
        mint.httpBody = try JSONSerialization.data(withJSONObject: ["name": name, "mime": "video/mp4", "size": size])
        mint.setValue("application/json", forHTTPHeaderField: "Content-Type")
        guard let minted = try? await URLSession.shared.data(for: mint),
              (minted.1 as? HTTPURLResponse)?.statusCode == 200,
              let start = (try? JSONSerialization.jsonObject(with: minted.0)) as? [String: Any],
              let uid = start["id"] as? String,
              let tus = start["tus"] as? [String: Any],
              let createURL = (tus["createUrl"] as? String).flatMap(URL.init(string:)),
              let tusHeaders = tus["headers"] as? [String: String],
              let metadata = tus["metadata"] as? String else { return nil }
        var create = URLRequest(url: createURL)
        create.httpMethod = "POST"
        tusHeaders.forEach { create.setValue($1, forHTTPHeaderField: $0) }
        create.setValue(String(size), forHTTPHeaderField: "Upload-Length")
        create.setValue(metadata, forHTTPHeaderField: "Upload-Metadata")
        guard let made = try? await URLSession.shared.data(for: create), (made.1 as? HTTPURLResponse)?.statusCode == 201,
              let location = (made.1 as? HTTPURLResponse)?.value(forHTTPHeaderField: "Location"),
              let url = URL(string: location, relativeTo: createURL) else { return nil }
        let chunk = (tus["partSize"] as? Int) ?? 16 * 1024 * 1024
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var offset = 0
        var failures = 0
        while offset < size {
            do {
                try handle.seek(toOffset: UInt64(offset))
                let body = try handle.read(upToCount: chunk) ?? Data()
                var patch = URLRequest(url: url)
                patch.httpMethod = "PATCH"
                tusHeaders.forEach { patch.setValue($1, forHTTPHeaderField: $0) }
                patch.setValue(String(offset), forHTTPHeaderField: "Upload-Offset")
                patch.setValue("application/offset+octet-stream", forHTTPHeaderField: "Content-Type")
                let (_, r) = try await URLSession.shared.upload(for: patch, from: body)
                guard let http = r as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw SiteError.status((r as? HTTPURLResponse)?.statusCode ?? 0) }
                offset = Int(http.value(forHTTPHeaderField: "Upload-Offset") ?? "") ?? offset + body.count
                failures = 0
                progress(Double(offset) / Double(max(1, size)))
            } catch {
                failures += 1
                if offset == 0 && failures >= 3 { return nil }   // this network can't reach the relay: go direct
                if failures >= 10 { throw error }
                try await Task.sleep(for: .seconds(min(30, 1 << failures)))
                var head = URLRequest(url: url)
                head.httpMethod = "HEAD"
                tusHeaders.forEach { head.setValue($1, forHTTPHeaderField: $0) }
                if let (_, r) = try? await URLSession.shared.data(for: head), let http = r as? HTTPURLResponse, http.statusCode < 300 {
                    offset = Int(http.value(forHTTPHeaderField: "Upload-Offset") ?? "") ?? offset
                }
            }
        }
        // the bytes are at the relay: from here on only finish, never start over
        for attempt in 0..<6 {
            var finish = request("POST", "/api/uploads/relay/\(uid)/complete")
            finish.httpBody = Data("{}".utf8)
            finish.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let (data, r) = try? await URLSession.shared.data(for: finish), let http = r as? HTTPURLResponse {
                if (200..<300).contains(http.statusCode) { return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:] }
                if http.statusCode < 500 { throw SiteError.status(http.statusCode) }
            }
            try await Task.sleep(for: .seconds(2 * (attempt + 1)))   // the server restarting
        }
        throw SiteError.status(503)
    }

    /// The site's own resumable upload; returns the finishing call's JSON.
    private func direct(_ file: URL, name: String, size: Int, review: Bool, progress: @escaping @Sendable (Double) -> Void) async throws -> [String: Any] {
        // Review: the server picks the relay (api/uploads/relay). "direct" sends the parts straight to its bucket.
        if review, await uploadRelay() == "direct" {
            return try await directToBucket(file, name: name, size: size, progress: progress)
        }
        let started = try await json("POST", review ? "/api/uploads/relay" : "/api/clips/init",
                                     ["name": name, "mime": "video/mp4", "size": size])
        guard let id = started["id"] as? String, let partSize = started["partSize"] as? Int, partSize > 0 else { throw SiteError.status(0) }
        let root = review ? "/api/uploads/relay/\(id)" : "/api/clips/\(id)"
        let count = (size + partSize - 1) / partSize
        let tally = Tally()
        try await withThrowingTaskGroup(of: Void.self) { group in
            for n in 1...max(1, count) {
                if n > 4 { try await group.next() }
                group.addTask {
                    try await self.part(file, n: n, partSize: partSize, total: size, root: root)
                    progress(Double(await tally.bump()) / Double(count))
                }
            }
            try await group.waitForAll()
        }
        return try await json("POST", "\(root)/complete", [:])
    }

    /// The relay the server picks for Review uploads (GET /api/uploads/relay): "chunked" or "direct". Unreachable = chunked.
    private func uploadRelay() async -> String {
        guard let got = try? await URLSession.shared.data(for: request("GET", "/api/uploads/relay")),
              (got.1 as? HTTPURLResponse)?.statusCode == 200,
              let view = (try? JSONSerialization.jsonObject(with: got.0)) as? [String: Any],
              let active = view["active"] as? String else { return "chunked" }
        return active
    }

    /// Review's direct relay: presigned part URLs from the server, 4 parts at a time straight to the bucket, then the
    /// server's complete call with the ETags. Nothing about the bucket is kept here.
    private func directToBucket(_ file: URL, name: String, size: Int, progress: @escaping @Sendable (Double) -> Void) async throws -> [String: Any] {
        let started = try await json("POST", "/api/uploads/relay", ["name": name, "mime": "video/mp4", "size": size])
        guard let id = started["id"] as? String, let partSize = started["partSize"] as? Int, partSize > 0,
              let urls = started["urls"] as? [String], !urls.isEmpty else { throw SiteError.status(0) }
        let etags = try await withThrowingTaskGroup(of: (Int, String).self) { group -> [(Int, String)] in
            var done: [(Int, String)] = []
            for (i, url) in urls.enumerated() {
                if i >= 4, let finished = try await group.next() {
                    done.append(finished)
                    progress(Double(done.count) / Double(urls.count))
                }
                group.addTask { try await self.bucketPart(file, index: i, partSize: partSize, url: url) }
            }
            while let finished = try await group.next() {
                done.append(finished)
                progress(Double(done.count) / Double(urls.count))
            }
            return done
        }
        // the bucket wants the parts in order, whatever order they finished in
        let parts = etags.sorted { $0.0 < $1.0 }.map { ["number": $0.0 + 1, "etag": $0.1] as [String: Any] }
        return try await json("POST", "/api/uploads/relay/\(id)/complete", ["parts": parts])
    }

    /// One part PUT to its presigned URL (the bucket, no cookies), retried like the server's parts. Returns its number and ETag.
    private func bucketPart(_ file: URL, index: Int, partSize: Int, url: String) async throws -> (Int, String) {
        guard let target = URL(string: url) else { throw SiteError.status(0) }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64(index * partSize))
        let data = try handle.read(upToCount: partSize) ?? Data()
        var req = URLRequest(url: target)
        req.httpMethod = "PUT"
        req.httpShouldHandleCookies = false
        for attempt in 0..<4 {
            do {
                let (_, response) = try await URLSession.shared.upload(for: req, from: data)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                guard (200..<300).contains(code), let etag = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "ETag") else {
                    throw SiteError.status(code)
                }
                return (index, etag)
            } catch SiteError.status(let code) where code >= 400 && code < 500 && code != 408 && code != 429 {
                throw SiteError.status(code)
            } catch where attempt < 3 {
                try await Task.sleep(for: .seconds(2 << attempt))
            }
        }
        throw SiteError.status(0)
    }

    private func part(_ file: URL, n: Int, partSize: Int, total: Int, root: String) async throws {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        try handle.seek(toOffset: UInt64((n - 1) * partSize))
        let data = try handle.read(upToCount: partSize) ?? Data()
        var req = request("POST", "\(root)/parts/\(n)")
        req.setValue(String(total), forHTTPHeaderField: "upload-length")
        req.setValue(String(partSize), forHTTPHeaderField: "upload-part-size")
        req.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        for attempt in 0..<4 {
            do {
                _ = try await checked(URLSession.shared.upload(for: req, from: data))
                return
            } catch SiteError.status(let code) where code >= 400 && code < 500 && code != 408 && code != 429 {
                throw SiteError.status(code)
            } catch where attempt < 3 {
                try await Task.sleep(for: .seconds(2 << attempt))   // the server restarting, the line dropping
            }
        }
    }

    private func request(_ method: String, _ path: String) -> URLRequest {
        var req = URLRequest(url: URL(string: path, relativeTo: base) ?? base)
        req.httpMethod = method
        req.httpShouldHandleCookies = false
        req.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: cookies)
        return req
    }

    private func json(_ method: String, _ path: String, _ body: [String: Any]) async throws -> [String: Any] {
        var req = request(method, path)
        req.httpBody = try JSONSerialization.data(withJSONObject: body)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let data = try await checked(URLSession.shared.data(for: req))
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func checked(_ result: (Data, URLResponse)) throws -> Data {
        let code = (result.1 as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw SiteError.status(code) }
        return result.0
    }
}

private actor Tally {
    private var n = 0
    func bump() -> Int {
        n += 1
        return n
    }
}
