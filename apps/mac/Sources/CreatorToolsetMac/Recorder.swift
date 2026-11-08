// Screen recording: the display under the pointer, at its own sharpness up to 4K, 60 fps. The system pointer is left
// out of the picture and its path and clicks are logged beside the video instead, so Review can draw a smooth, larger
// pointer and zoom in where you click (src/lib/screen-recording.ts). The voice is the file's first sound track, the
// Mac's own sound a second one, never mixed. On Stop the file uploads to Review (or Video Notes) on the open server and
// that page opens in the window; the file stays in the recordings folder. Needs macOS 15 (the microphone comes through
// the same capture stream, so voice and picture share one clock).
import AVFoundation
import AppKit
import ScreenCaptureKit
import SwiftUI

/// Where a recording goes when it stops: uploaded to Review or Video Notes, or only kept in the recordings folder.
enum RecordingTarget: String { case review, notes, mac }

/// What Review reads beside the video (api/review.ts, PUT …/screen/events): seconds from the first frame,
/// positions as 0–1 of the recorded display (top left 0,0; outside 0–1 = the pointer was on another display).
struct ScreenEvents: Codable {
    var v = 1
    var width = 0
    var height = 0
    var moves: [[Double]] = []    // [t, x, y]
    var clicks: [[Double]] = []   // [t, x, y], the press
    var audio: [String] = []      // the sound tracks in file order: "mic", "system"
}

/// The pointer at `location` (NSEvent.mouseLocation: global points, origin bottom left of the main display) as 0–1 of
/// `display` (CGDisplayBounds: global points, origin top left), rounded to 1/10000.
func normalizedPointer(_ location: CGPoint, display: CGRect, mainHeight: CGFloat) -> (x: Double, y: Double) {
    let round = { (v: CGFloat) in (Double(v) * 10_000).rounded() / 10_000 }
    return (round((location.x - display.minX) / display.width), round((mainHeight - location.y - display.minY) / display.height))
}

/// The capture size: the display's pixels, scaled down to fit 3840 on the long side (H.264's hardware limit is about
/// 4K), even numbers for the encoder.
func captureSize(points: CGSize, scale: CGFloat) -> (width: Int, height: Int) {
    let k = min(1, 3840 / max(points.width * scale, points.height * scale))
    let even = { (v: CGFloat) in max(2, Int((v * scale * k) / 2) * 2) }
    return (even(points.width), even(points.height))
}

private func hostNow() -> CMTime { CMClockGetTime(CMClockGetHostTimeClock()) }

enum RecorderError: LocalizedError {
    case noDisplay, nothingRecorded, write(String)

    var errorDescription: String? {
        switch self {
        case .noDisplay: return "Couldn't find the display to record."
        case .nothingRecorded: return "Nothing was recorded."
        case .write(let why): return "Couldn't save the recording: \(why)"
        }
    }
}

/// One recording: the capture stream into an MP4, and the pointer log. Every mutable field is touched only on `queue`
/// (the stream's sample queue), so no locks.
@available(macOS 15.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "com.creatortoolset.recorder")
    private let writer: AVAssetWriter
    private let video: AVAssetWriterInput
    private let mic: AVAssetWriterInput?
    private let system: AVAssetWriterInput?
    private var stream: SCStream?
    /// Host time of the first frame plus every pause so far: a buffer's time in the file is its host time minus this.
    private var offset: CMTime?
    private var pausedAt: CMTime?
    private var last: [ObjectIdentifier: CMTime] = [:]
    private var lastMove = -1.0
    private var failed: Error?
    private(set) var events: ScreenEvents
    /// The stream stopped by itself (display gone, permission taken away): called once, on `queue`.
    var onStop: ((Error) -> Void)?

    init(file: URL, width: Int, height: Int, mic withMic: Bool, system withSystem: Bool) throws {
        writer = try AVAssetWriter(outputURL: file, fileType: .mp4)
        writer.movieFragmentInterval = CMTime(seconds: 5, preferredTimescale: 600)   // a crash leaves a playable file
        video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                // ponytail: one bitrate for every screen (~20 Mbit/s at 4K, more than text needs); per-content rate control if files run big
                AVVideoAverageBitRateKey: max(6_000_000, width * height * 60 / 25),
                AVVideoExpectedSourceFrameRateKey: 60,
                AVVideoMaxKeyFrameIntervalDurationKey: 2,   // Review seeks fast
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ])
        video.expectsMediaDataInRealTime = true
        let aac: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000, AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000]
        mic = withMic ? AVAssetWriterInput(mediaType: .audio, outputSettings: aac) : nil
        system = withSystem ? AVAssetWriterInput(mediaType: .audio, outputSettings: aac) : nil
        events = ScreenEvents(width: width, height: height)
        super.init()
        writer.add(video)
        // the voice first: players, Review's transcode and the export all take the first sound track
        if let mic { writer.add(mic); mic.expectsMediaDataInRealTime = true; events.audio.append("mic") }
        if let system { writer.add(system); system.expectsMediaDataInRealTime = true; events.audio.append("system") }
    }

    func start(filter: SCContentFilter, config: SCStreamConfiguration) async throws {
        guard writer.startWriting() else { throw RecorderError.write(writer.error?.localizedDescription ?? "the writer refused") }
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
        if config.capturesAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue) }
        if config.captureMicrophone { try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: queue) }
        self.stream = stream
        try await stream.startCapture()
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
        return try await withCheckedThrowingContinuation { done in
            queue.async {
                guard let offset = self.offset, self.failed == nil else {
                    self.writer.cancelWriting()
                    done.resume(throwing: self.failed ?? RecorderError.nothingRecorded)
                    return
                }
                [self.video, self.mic, self.system].compactMap { $0 }.forEach { $0.markAsFinished() }
                self.writer.endSession(atSourceTime: max((self.pausedAt ?? now) - offset, self.last[ObjectIdentifier(self.video)] ?? .zero))
                self.writer.finishWriting {
                    if self.writer.status == .completed { done.resume(returning: self.events) }
                    else { done.resume(throwing: RecorderError.write(self.writer.error?.localizedDescription ?? "unknown")) }
                }
            }
        }
    }

    func cancel() {
        Task { try? await stream?.stopCapture() }
        queue.async { self.writer.cancelWriting() }
    }

    /// The pointer moved (`click` = a button went down), as 0–1 of the display.
    func note(x: Double, y: Double, click: Bool) {
        let now = hostNow()
        queue.async {
            guard self.pausedAt == nil, let offset = self.offset else { return }
            let t = ((now - offset).seconds * 1000).rounded() / 1000
            guard t >= 0 else { return }
            if click { self.events.clicks.append([t, x, y]) }
            // ponytail: moves at most 30 a second (an hour ≈ 3 MB); Review interpolates between them
            else if t - self.lastMove >= 1.0 / 30 { self.events.moves.append([t, x, y]); self.lastMove = t }
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard buffer.isValid, pausedAt == nil, failed == nil else { return }
        switch type {
        case .screen:
            // only frames with a picture (a still screen sends "idle" ones without)
            guard let info = (CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
                  let raw = info[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete else { return }
            if offset == nil {
                offset = buffer.presentationTimeStamp
                writer.startSession(atSourceTime: .zero)
            }
            append(buffer, to: video)
        case .microphone: if let mic { append(buffer, to: mic) }
        case .audio: if let system { append(buffer, to: system) }
        @unknown default: break
        }
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

/// Start, pause, stop and the upload; the small floating bar while it records (RecorderBar).
@MainActor
final class Recorder: ObservableObject {
    enum Phase: Equatable { case idle, countdown(Int), recording, paused, saving, uploading(Double) }

    @Published private(set) var phase = Phase.idle
    @AppStorage("recordMic") var withMic = true
    @AppStorage("recordSystemAudio") var withSystemAudio = false
    @AppStorage("recordingsFolder") private var folderPath = ""
    /// Uploads a finished recording and returns the page to open (Shell.uploadRecording).
    var upload: ((URL, ScreenEvents, RecordingTarget, @escaping @Sendable (Double) -> Void) async throws -> String)?
    var openPage: ((String) -> Void)?

    static var available: Bool {
        if #available(macOS 15.0, *) { return true }
        return false
    }

    private var capture: AnyObject?
    private var panel: NSPanel?
    private var monitors: [Any] = []
    private var target = RecordingTarget.review
    private var file: URL?
    private var banked: TimeInterval = 0
    private var runFrom: Date?

    /// What the Screen Recorder page shows (src/lib/mac-record.ts): what it is doing, the sound choices, the folder.
    func pageState(_ phase: Phase? = nil) -> String {
        let name: String = switch phase ?? self.phase {
        case .idle: "idle"
        case .countdown: "countdown"
        case .recording: "recording"
        case .paused: "paused"
        case .saving: "saving"
        case .uploading: "uploading"
        }
        let body: [String: Any] = ["phase": name, "mic": withMic, "sound": withSystemAudio, "folder": folder.path]
        return (try? JSONSerialization.data(withJSONObject: body)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
    }

    var elapsed: TimeInterval { banked + (runFrom.map { Date().timeIntervalSince($0) } ?? 0) }
    var busy: Bool { phase != .idle }

    /// Where recordings are kept (~/Movies/Creator Toolset unless picked).
    var folder: URL {
        folderPath.isEmpty
            ? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Movies/Creator Toolset", isDirectory: true)
            : URL(fileURLWithPath: folderPath, isDirectory: true)
    }

    func pickFolder() {
        let open = NSOpenPanel()
        open.canChooseDirectories = true
        open.canChooseFiles = false
        open.canCreateDirectories = true
        open.prompt = "Keep recordings here"
        open.directoryURL = folder
        if open.runModal() == .OK, let url = open.url { folderPath = url.path }
    }

    func showFolder() {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        NSWorkspace.shared.open(folder)
    }

    func start(to target: RecordingTarget) {
        guard #available(macOS 15.0, *), phase == .idle else { return }
        guard CGPreflightScreenCaptureAccess() else {
            CGRequestScreenCaptureAccess()
            alert("Allow screen recording",
                  "Turn on Creator Toolset in System Settings → Privacy & Security → Screen & System Audio Recording, then start again.",
                  settings: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            return
        }
        self.target = target
        Task { await begin() }
    }

    @available(macOS 15.0, *)
    private func begin() async {
        var mic = withMic
        if mic, AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
            mic = await AVCaptureDevice.requestAccess(for: .audio)
            if !mic { AppLog.write("recording without the microphone: access refused") }
        }
        // the display under the pointer
        let pointer = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(pointer, $0.frame, false) }) ?? NSScreen.main,
              let displayID = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID else {
            alert("Can't record", RecorderError.noDisplay.localizedDescription)
            return
        }
        showBar(on: screen)
        for n in [3, 2, 1] {
            phase = .countdown(n)
            try? await Task.sleep(for: .seconds(1))
            if phase == .idle { return }   // cancelled during the countdown
        }
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == displayID }) else { throw RecorderError.noDisplay }
            // everything on the display but the bar itself
            let bar = content.windows.filter { $0.windowID == CGWindowID(panel?.windowNumber ?? -1) }
            let filter = SCContentFilter(display: display, excludingWindows: bar)
            let size = captureSize(points: CGSize(width: display.width, height: display.height), scale: screen.backingScaleFactor)
            let config = SCStreamConfiguration()
            config.width = size.width
            config.height = size.height
            config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
            config.showsCursor = false
            config.queueDepth = 8
            config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            config.colorSpaceName = CGColorSpace.sRGB
            config.capturesAudio = withSystemAudio
            config.excludesCurrentProcessAudio = true
            config.sampleRate = 48_000
            config.channelCount = 2
            config.captureMicrophone = mic

            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let stamp = DateFormatter()
            stamp.dateFormat = "yyyy-MM-dd HH.mm.ss"
            let file = folder.appendingPathComponent("Screen recording \(stamp.string(from: Date())).mp4")
            let capture = try Capture(file: file, width: size.width, height: size.height, mic: mic, system: withSystemAudio)
            capture.onStop = { [weak self] error in
                Task { @MainActor in self?.stoppedByItself(error) }
            }
            try await capture.start(filter: filter, config: config)
            self.capture = capture
            self.file = file
            watchPointer(capture, display: CGDisplayBounds(displayID))
            banked = 0
            runFrom = Date()
            phase = .recording
            AppLog.write("recording \(size.width)×\(size.height), mic \(mic), Mac sound \(withSystemAudio)")
        } catch {
            closeBar()
            phase = .idle
            alert("Couldn't start recording", error.localizedDescription)
        }
    }

    private func watchPointer(_ capture: AnyObject, display: CGRect) {
        guard #available(macOS 15.0, *), let capture = capture as? Capture else { return }
        let mainHeight = CGDisplayBounds(CGMainDisplayID()).height
        let handle = { (event: NSEvent) in
            let p = normalizedPointer(NSEvent.mouseLocation, display: display, mainHeight: mainHeight)
            capture.note(x: p.x, y: p.y, click: [.leftMouseDown, .rightMouseDown].contains(event.type))
        }
        // pointer events need no permission (key presses would: not logged)
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDragged, .rightMouseDragged, .leftMouseDown, .rightMouseDown]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: handle) { monitors.append(global) }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { handle($0); return $0 }) { monitors.append(local) }
        let start = normalizedPointer(NSEvent.mouseLocation, display: display, mainHeight: mainHeight)
        capture.note(x: start.x, y: start.y, click: false)   // where it starts
    }

    func togglePause() {
        guard #available(macOS 15.0, *), let capture = capture as? Capture else { return }
        if phase == .recording {
            capture.pause()
            banked = elapsed
            runFrom = nil
            phase = .paused
        } else if phase == .paused {
            capture.resume()
            runFrom = Date()
            phase = .recording
        }
    }

    func stop() {
        if case .countdown = phase { return finish() }
        guard #available(macOS 15.0, *), let capture = capture as? Capture, let file,
              phase == .recording || phase == .paused else { return }
        endWatching()
        phase = .saving
        Task {
            do {
                let events = try await capture.stop()
                self.capture = nil
                let json = file.deletingPathExtension().appendingPathExtension("screen.json")
                try? JSONEncoder().encode(events).write(to: json)
                await send(file, events)
            } catch {
                finish()
                alert("Couldn't save the recording", error.localizedDescription)
            }
        }
    }

    /// Throws the recording away (asks first once it has started).
    func cancel() {
        if case .countdown = phase {
            finish()
            return
        }
        guard #available(macOS 15.0, *), let capture = capture as? Capture else { return }
        let ask = NSAlert()
        ask.messageText = "Throw this recording away?"
        ask.addButton(withTitle: "Throw Away")
        ask.addButton(withTitle: "Keep Recording")
        guard ask.runModal() == .alertFirstButtonReturn else { return }
        capture.cancel()
        if let file { try? FileManager.default.removeItem(at: file) }
        finish()
    }

    private func stoppedByItself(_ error: Error) {
        guard phase == .recording || phase == .paused else { return }
        AppLog.write("recording stopped: \(error.localizedDescription)")
        stop()
    }

    private func send(_ file: URL, _ events: ScreenEvents) async {
        guard let upload, target != .mac else {
            finish()
            if target == .mac { NSWorkspace.shared.activateFileViewerSelecting([file]) }
            return
        }
        while true {
            phase = .uploading(0)
            do {
                let page = try await upload(file, events, target) { p in
                    Task { @MainActor in if case .uploading = self.phase { self.phase = .uploading(p) } }
                }
                finish()
                openPage?(page)
                return
            } catch {
                AppLog.write("recording upload failed: \(error.localizedDescription)")
                let ask = NSAlert()
                ask.messageText = "The upload didn't finish"
                ask.informativeText = "\(error.localizedDescription)\n\nThe recording is saved in \(folder.path)."
                ask.addButton(withTitle: "Try Again")
                ask.addButton(withTitle: "Show in Finder")
                ask.addButton(withTitle: "OK")
                let answer = ask.runModal()
                if answer == .alertFirstButtonReturn { continue }
                if answer == .alertSecondButtonReturn { NSWorkspace.shared.activateFileViewerSelecting([file]) }
                return finish()
            }
        }
    }

    private func endWatching() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors = []
        banked = elapsed
        runFrom = nil
    }

    private func finish() {
        endWatching()
        capture = nil
        file = nil
        phase = .idle
        closeBar()
    }

    // MARK: the floating bar

    private func showBar(on screen: NSScreen) {
        let size = NSSize(width: 230, height: 44)
        let panel = NSPanel(contentRect: NSRect(origin: .zero, size: size), styleMask: [.nonactivatingPanel, .borderless], backing: .buffered, defer: false)
        panel.level = .statusBar
        panel.isFloatingPanel = true
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.contentView = NSHostingView(rootView: RecorderBar(recorder: self).frame(width: size.width, height: size.height))
        let area = screen.visibleFrame
        panel.setFrameOrigin(NSPoint(x: area.midX - size.width / 2, y: area.maxY - size.height - 12))
        panel.orderFrontRegardless()
        self.panel = panel
    }

    private func closeBar() {
        panel?.orderOut(nil)
        panel = nil
    }

    private func alert(_ title: String, _ text: String, settings: String? = nil) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = text
        if settings != nil { a.addButton(withTitle: "Open System Settings") }
        a.addButton(withTitle: "OK")
        if let settings, a.runModal() == .alertFirstButtonReturn, let url = URL(string: settings) { NSWorkspace.shared.open(url) }
        else if settings == nil { a.runModal() }
    }
}

/// The bar at the top of the recorded display (left out of the recording): the count-in, then time, Pause, Stop, Throw away.
struct RecorderBar: View {
    @ObservedObject var recorder: Recorder

    var body: some View {
        HStack(spacing: 12) {
            switch recorder.phase {
            case .countdown(let n):
                Text("Recording in \(n)").monospacedDigit()
                Button("Cancel") { recorder.cancel() }
            case .recording, .paused:
                Circle().fill(recorder.phase == .paused ? Color.orange : Color.red).frame(width: 9, height: 9)
                TimelineView(.periodic(from: .now, by: 0.5)) { _ in
                    Text(clock(recorder.elapsed)).monospacedDigit().frame(width: 44, alignment: .leading)
                }
                Button { recorder.togglePause() } label: {
                    Image(systemName: recorder.phase == .paused ? "play.fill" : "pause.fill")
                }.help(recorder.phase == .paused ? "Resume" : "Pause")
                Button { recorder.stop() } label: { Image(systemName: "stop.fill") }.help("Stop and upload")
                Button { recorder.cancel() } label: { Image(systemName: "trash") }.help("Throw away")
            case .saving:
                ProgressView().controlSize(.small)
                Text("Saving…")
            case .uploading(let p):
                ProgressView(value: p).frame(width: 90)
                Text("Uploading \(Int(p * 100))%").monospacedDigit()
            case .idle:
                EmptyView()
            }
        }
        .font(.system(size: 13, weight: .medium))
        .buttonStyle(.borderless)
        .padding(.horizontal, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial, in: Capsule())
    }

    private func clock(_ t: TimeInterval) -> String {
        let s = Int(t)
        return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, s / 60 % 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
    }
}

extension Site {
    /// A finished recording to Review (with its pointer log) or Video Notes, through the site's resumable upload
    /// (api/lib/uploads.ts: 16 MB parts, four at a time). Returns the page to open.
    func uploadRecording(_ file: URL, events: ScreenEvents, to target: RecordingTarget, progress: @escaping @Sendable (Double) -> Void) async throws -> String {
        let size = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
        let finished = try await direct(file, name: file.lastPathComponent, size: size, to: target, progress: progress)
        guard let asset = finished["id"] as? String else { throw SiteError.status(0) }
        if target == .notes { return "/clips/\(asset)" }
        let n = ((finished["versions"] as? [[String: Any]])?.last?["n"] as? Int) ?? 1
        var put = request("PUT", "/api/review/assets/\(asset)/v/\(n)/screen/events")
        put.httpBody = try JSONEncoder().encode(events)
        put.setValue("application/json", forHTTPHeaderField: "Content-Type")
        _ = try await checked(URLSession.shared.data(for: put))
        return "/review/\(asset)?v=\(n)"
    }

    /// The site's own resumable upload; returns the finishing call's JSON.
    private func direct(_ file: URL, name: String, size: Int, to target: RecordingTarget, progress: @escaping @Sendable (Double) -> Void) async throws -> [String: Any] {
        let started = try await json("POST", target == .review ? "/api/review/uploads" : "/api/clips/init",
                                     ["name": name, "mime": "video/mp4", "size": size])
        guard let id = started["id"] as? String, let partSize = started["partSize"] as? Int, partSize > 0 else { throw SiteError.status(0) }
        let root = target == .review ? "/api/review/uploads/\(id)" : "/api/clips/\(id)"
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
