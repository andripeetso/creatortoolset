import AVFoundation
import CoreAudio
import Darwin
import Foundation

/// Captures microphone audio while recording is active and returns a 16 kHz
/// mono Float32 buffer when stopped. Format-converts on the fly so callers
/// don't have to worry about the input device's native rate.
///
/// The microphone runs only between `start()` and `stop()`, through a
/// Core Audio input unit (`HALInput`); the checks before it (permission, a
/// usable device) and the conversion and bookkeeping after it are here.
final class AudioCapture {
    static let targetSampleRate: Double = 16_000

    static let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: targetSampleRate,
        channels: 1,
        interleaved: false
    )!

    /// Called for every audio buffer with the buffer's RMS level (0…~1).
    /// Invoked on an arbitrary thread; hop to main if you touch UI.
    var onLevel: ((Float) -> Void)?


    /// Counts and timings of the last finished capture, including press to
    /// first sample. Nil until one finishes.
    private(set) var lastStats: CaptureBuffer.Stats?

    /// Buffers any input delivered while no recording was open. Stays 0
    /// unless an input ran between presses.
    var buffersWhileStopped: Int { buffer.buffersWhileClosed }

    /// The recording so far, for callers that wait on the first sample.
    var currentStats: CaptureBuffer.Stats { buffer.currentStats }

    private let input: CaptureInput
    private var recording = false
    private var device = InputDevice(sampleRate: 0, channels: 0)
    private var delivered = InputDevice(sampleRate: 0, channels: 0)
    private var startDelay: TimeInterval = 0
    private let converters = ConverterCache(targetFormat: AudioCapture.targetFormat)
    private let buffer = CaptureBuffer()

    init() {
        self.input = HALInput(keepsPrepared: false)
        input.prepareIdle()
    }

    /// Begin recording. Idempotent — calling while already recording is a no-op.
    /// Throws `CaptureError`; on a throw nothing is left running.
    func start() throws {
        guard !recording else { return }
        // The press. Press-to-first-sample is measured from here.
        let startedAt = HostClock.now()

        if let error = MicrophoneAccess.captureError(for: MicrophoneAccess.status) {
            // A press is the one moment the user is looking; ask again if the
            // system never has (a no-op while its prompt is open).
            MicrophoneAccess.requestIfUndetermined()
            throw error
        }

        // Check the device before any input touches it: a missing input or a
        // 0 Hz / 0 channel format raises an ObjC exception in AVAudioEngine.
        let device = try InputDevice.current()

        converters.resetAll()
        buffer.reset(startedAt: startedAt)
        let buffer = self.buffer
        let sink = InputSink(
            deliver: Self.inputHandler(buffer: buffer, converters: converters, onLevel: onLevel),
            routeChanged: { buffer.markRouteChanged() },
            inputFailed: { buffer.recordInputFailure() }
        )
        do {
            delivered = try input.start(device: device, sink: sink)
        } catch {
            _ = try? buffer.finish()
            throw error
        }
        recording = true
        self.device = device
        startDelay = HostClock.seconds(from: startedAt, to: HostClock.now())
    }

    /// Stop recording and return all captured samples (16 kHz mono Float32).
    /// Returns nothing if the capture failed, for example because the input
    /// route changed mid-recording; the failure is logged. `finish()` is the
    /// same with the failure thrown instead.
    @discardableResult
    func stop() -> [Float] {
        do {
            return try finish()
        } catch {
            DictationLog.error("capture failed: \(error)")
            return []
        }
    }

    /// Stop recording, stop the input, and return the captured samples.
    /// Throws `CaptureError.routeChanged` instead of returning a partial
    /// capture if the input route changed mid-recording.
    func finish() throws -> [Float] {
        guard recording else { return [] }
        recording = false
        input.stop()

        // The input has stopped; flush what the resampler still holds.
        converters.drain { buffer.appendTail($0) }
        let stats = buffer.currentStats
        lastStats = stats
        logStats(stats)
        return try buffer.finish()
    }

    /// The body of an input callback: note when the buffer's first sample,
    /// and its first non-zero sample, were captured, then convert to 16 kHz
    /// and append. `firstFrame` and `now` are `HostClock` nanoseconds. A
    /// buffer outside a recording is counted and dropped.
    static func inputHandler(
        buffer: CaptureBuffer,
        converters: ConverterCache,
        onLevel: ((Float) -> Void)?
    ) -> (_ pcm: AVAudioPCMBuffer, _ firstFrame: UInt64, _ now: UInt64) -> Void {
        return { pcm, firstFrame, now in
            guard buffer.admit() else { return }
            var firstSound: UInt64?
            if buffer.awaitingSound, pcm.format.sampleRate > 0, let frame = firstNonZeroFrame(pcm) {
                firstSound = firstFrame &+ UInt64(Double(frame) / pcm.format.sampleRate * 1_000_000_000)
            }
            buffer.noteInput(firstFrameAt: firstFrame, firstSoundAt: firstSound)
            let converted = converters.convert(pcm) { chunk in
                buffer.append(chunk, inputFrames: Int(pcm.frameLength), at: now)
                onLevel?(computeRMS(chunk))
            }
            if !converted { buffer.recordConversionFailure() }
        }
    }

    /// The first frame in which any channel is not exactly zero, or nil.
    static func firstNonZeroFrame(_ pcm: AVAudioPCMBuffer) -> Int? {
        guard let channels = pcm.floatChannelData else { return nil }
        let interleaved = pcm.format.isInterleaved
        let stride = pcm.stride
        var first: Int?
        for c in 0..<Int(pcm.format.channelCount) {
            let data = channels[interleaved ? 0 : c]
            let offset = interleaved ? c : 0
            var i = 0
            let limit = first ?? Int(pcm.frameLength)
            while i < limit {
                if data[i * stride + offset] != 0 {
                    first = i
                    break
                }
                i += 1
            }
        }
        return first
    }

    /// One line per recording: counts and timings, never audio. Press to
    /// first sample is the start of the dictation the user loses.
    private func logStats(_ stats: CaptureBuffer.Stats) {
        func ms(_ delay: TimeInterval?) -> String { delay.map { String(format: "%.0f ms", $0 * 1000) } ?? "none" }
        var line = String(
            format: "  input %.0f Hz × %u · delivered %.0f Hz × %u · %@ start %.0f ms",
            device.sampleRate, device.channels, delivered.sampleRate, delivered.channels,
            "hal", startDelay * 1000
        )
        line += " · press→first sample \(ms(stats.firstSampleDelay)) · first sound \(ms(stats.firstSoundDelay))"
        line += " · first buffer \(ms(stats.firstBufferDelay)) · \(stats.buffers) buffers · \(stats.inputFrames) frames"
        if stats.conversionFailures > 0 {
            line += " · \(stats.conversionFailures) conversion failures"
        }
        if stats.inputFailures > 0 {
            line += " · \(stats.inputFailures) input failures"
        }
        DictationLog.info(line)
    }
}

// MARK: - WAV writer (saved recordings)

enum WAVWriter {
    /// Float32 mono samples as a 16-bit PCM WAV file in memory.
    static func data(samples: [Float], sampleRate: Int) -> Data {
        let bytesPerSample = 2
        let dataSize = samples.count * bytesPerSample

        var data = Data()
        data.append(contentsOf: Array("RIFF".utf8))
        data.append(uint32LE(36 + UInt32(dataSize)))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        data.append(uint32LE(16))                       // fmt chunk size
        data.append(uint16LE(1))                        // PCM
        data.append(uint16LE(1))                        // mono
        data.append(uint32LE(UInt32(sampleRate)))
        data.append(uint32LE(UInt32(sampleRate * bytesPerSample)))
        data.append(uint16LE(UInt16(bytesPerSample)))   // block align
        data.append(uint16LE(16))                       // bits per sample
        data.append(contentsOf: Array("data".utf8))
        data.append(uint32LE(UInt32(dataSize)))

        for s in samples {
            let clamped = max(-1.0, min(1.0, s))
            let i = Int16(clamped * 32767.0)
            data.append(uint16LE(UInt16(bitPattern: i)))
        }
        return data
    }

    private static func uint32LE(_ v: UInt32) -> Data {
        var x = v.littleEndian
        return Data(bytes: &x, count: 4)
    }
    private static func uint16LE(_ v: UInt16) -> Data {
        var x = v.littleEndian
        return Data(bytes: &x, count: 2)
    }
}

func computeRMS<C: Collection>(_ samples: C) -> Float where C.Element == Float {
    guard !samples.isEmpty else { return 0 }
    var sum: Double = 0
    for s in samples { sum += Double(s * s) }
    return Float((sum / Double(samples.count)).squareRoot())
}

/// Where an input delivers what it captures. Called on the input's own
/// realtime thread.
struct InputSink {
    /// One buffer at the input's own format, the host time its first frame
    /// was captured, and the host time of the callback (`HostClock`
    /// nanoseconds).
    var deliver: (_ pcm: AVAudioPCMBuffer, _ firstFrame: UInt64, _ now: UInt64) -> Void
    /// The input route changed; the recording must be discarded.
    var routeChanged: () -> Void
    /// The input failed to produce a buffer it was due.
    var inputFailed: () -> Void
}

/// One way of running the microphone for a single recording. `AudioCapture`
/// owns the checks before it and the conversion and bookkeeping after it.
///
/// `start` and `stop` are called in pairs on one thread. Between them the
/// input delivers to the sink; after `stop` returns it delivers nothing and
/// the device is no longer running for this process.
protocol CaptureInput: AnyObject {
    /// Starts the input on `device` (already validated). Throws
    /// `CaptureError`; on a throw nothing is left running. Returns the
    /// format the input delivers.
    func start(device: InputDevice, sink: InputSink) throws -> InputDevice
    /// Stops the input. Safe to call when not started.
    func stop()
    /// Does whatever setup can happen before a press without running the
    /// device. Best effort: `start` redoes whatever this could not.
    func prepareIdle()
}

extension CaptureInput {
    func prepareIdle() {}
}

/// What one recording has captured so far. The audio thread appends to it;
/// `AudioCapture.stop()` reads it once. It holds no engine, so the rules
/// about what a stop returns are testable without hardware.
final class CaptureBuffer: @unchecked Sendable {
    /// Counts and timings for one recording. Never audio.
    struct Stats: Equatable {
        /// Tap callbacks that delivered converted audio.
        var buffers = 0
        /// Frames received at the input's own sample rate.
        var inputFrames = 0
        /// Buffers the converter failed on.
        var conversionFailures = 0
        /// Seconds from `start()` to the first buffer, or nil if none arrived.
        var firstBufferDelay: TimeInterval?
        /// Seconds from `start()` (the press) to the moment the first sample
        /// of the recording was captured, by the buffer's host timestamp:
        /// anything said before it is lost. Nil if no buffer arrived.
        var firstSampleDelay: TimeInterval?
        /// The same to the first sample that is not exactly zero. Some inputs
        /// deliver digital silence while they settle; that is lost too.
        var firstSoundDelay: TimeInterval?
        /// Buffers the input failed to deliver (a render error).
        var inputFailures = 0
    }

    private let lock = NSLock()
    private var samples: [Float] = []
    private var stats = Stats()
    private var routeChanged = false
    private var startedAt: UInt64 = 0
    private var isOpen = false
    private var closedBuffers = 0

    /// Clears everything for a new recording that started at `startedAt`
    /// (`HostClock` nanoseconds).
    func reset(startedAt: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        samples.removeAll(keepingCapacity: true)
        stats = Stats()
        routeChanged = false
        self.startedAt = startedAt
        isOpen = true
    }

    /// True while a recording is open. A buffer arriving outside one is
    /// counted and must be dropped: it means the input ran between presses.
    func admit() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if !isOpen { closedBuffers += 1 }
        return isOpen
    }

    /// Buffers that arrived while no recording was open, over this buffer's
    /// lifetime. Zero unless an input ran between presses.
    var buffersWhileClosed: Int {
        lock.lock()
        defer { lock.unlock() }
        return closedBuffers
    }

    func recordInputFailure() {
        lock.lock()
        defer { lock.unlock() }
        stats.inputFailures += 1
    }

    /// Appends converted 16 kHz samples from one tap callback.
    func append(_ chunk: UnsafeBufferPointer<Float>, inputFrames: Int, at now: UInt64) {
        lock.lock()
        defer { lock.unlock() }
        if stats.firstBufferDelay == nil {
            stats.firstBufferDelay = HostClock.seconds(from: startedAt, to: now)
        }
        stats.buffers += 1
        stats.inputFrames += inputFrames
        samples.append(contentsOf: chunk)
    }

    /// Records when the first frame of an input buffer was captured, and
    /// the first non-zero frame if it has one (host nanoseconds). Only the
    /// first of each counts.
    func noteInput(firstFrameAt: UInt64, firstSoundAt: UInt64?) {
        lock.lock()
        defer { lock.unlock() }
        if stats.firstSampleDelay == nil {
            stats.firstSampleDelay = HostClock.seconds(from: startedAt, to: firstFrameAt)
        }
        if stats.firstSoundDelay == nil, let firstSoundAt {
            stats.firstSoundDelay = HostClock.seconds(from: startedAt, to: firstSoundAt)
        }
    }

    /// True until a non-zero sample has been noted, so the audio thread
    /// scans for one only while it matters.
    var awaitingSound: Bool {
        lock.lock()
        defer { lock.unlock() }
        return stats.firstSoundDelay == nil
    }

    /// Appends the converter's tail after the last callback. Not counted as
    /// a buffer.
    func appendTail(_ chunk: UnsafeBufferPointer<Float>) {
        lock.lock()
        defer { lock.unlock() }
        samples.append(contentsOf: chunk)
    }

    func recordConversionFailure() {
        lock.lock()
        defer { lock.unlock() }
        stats.conversionFailures += 1
    }

    /// Called from the configuration-change notification. Only sets a flag;
    /// the engine is torn down in `stop()`, never inside the notification.
    func markRouteChanged() {
        lock.lock()
        defer { lock.unlock() }
        routeChanged = true
    }

    var currentStats: Stats {
        lock.lock()
        defer { lock.unlock() }
        return stats
    }

    /// Ends the recording and returns its samples. If the route changed at
    /// any point, the partial capture is discarded and this throws
    /// `CaptureError.routeChanged`, so it is never delivered as a success.
    /// Either way the buffer is empty afterwards.
    func finish() throws -> [Float] {
        lock.lock()
        let captured = samples
        let changed = routeChanged
        samples.removeAll(keepingCapacity: true)
        routeChanged = false
        isOpen = false
        lock.unlock()
        if changed { throw CaptureError.routeChanged }
        return captured
    }
}

/// Converts tap buffers to the capture's target format, keeping one
/// `AVAudioConverter` and one output buffer per input format.
///
/// The tap is installed with `format: nil`, so the first buffer is the first
/// time the real input format is known. Building the converter then, and
/// reusing it for every later buffer in that format, keeps allocation out of
/// the realtime callback after the first buffer.
final class ConverterCache: @unchecked Sendable {
    private final class Entry {
        let format: AVAudioFormat
        let converter: AVAudioConverter
        var output: AVAudioPCMBuffer

        init(format: AVAudioFormat, converter: AVAudioConverter, output: AVAudioPCMBuffer) {
            self.format = format
            self.converter = converter
            self.output = output
        }
    }

    let targetFormat: AVAudioFormat
    private let lock = NSLock()
    private var entries: [Entry] = []

    init(targetFormat: AVAudioFormat) {
        self.targetFormat = targetFormat
    }

    /// Converters built so far, one per distinct input format.
    var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return entries.count
    }

    /// Clears each converter's internal state (resampler history), so a new
    /// recording does not start with the tail of the previous one.
    func resetAll() {
        lock.lock()
        defer { lock.unlock() }
        entries.forEach { $0.converter.reset() }
    }

    /// Converts `input` and passes the result to `body`. The pointer is only
    /// valid inside `body`. Returns false if no converter could be built for
    /// the input format or the conversion failed.
    @discardableResult
    func convert(_ input: AVAudioPCMBuffer, _ body: (UnsafeBufferPointer<Float>) -> Void) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard input.format.sampleRate > 0, let entry = entry(for: input.format) else { return false }

        let ratio = targetFormat.sampleRate / input.format.sampleRate
        let needed = AVAudioFrameCount(Double(input.frameLength) * ratio) + 64
        if entry.output.frameCapacity < needed {
            guard let bigger = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: needed) else { return false }
            entry.output = bigger
        }
        let output = entry.output
        output.frameLength = 0

        var consumed = false
        var error: NSError?
        let status = entry.converter.convert(to: output, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return input
        }
        guard status != .error, let channels = output.floatChannelData else { return false }
        body(UnsafeBufferPointer(start: channels[0], count: Int(output.frameLength)))
        return true
    }

    /// Flushes the audio the most recently used converter still holds and
    /// passes it to `body`, possibly in several pieces. The resampler works
    /// in blocks, so without this the last ~85 ms of a recording (the end of
    /// the last word) never comes out. Call once the tap has stopped.
    func drain(_ body: (UnsafeBufferPointer<Float>) -> Void) {
        lock.lock()
        defer { lock.unlock() }
        guard let entry = entries.last else { return }
        let output = entry.output
        for _ in 0..<16 {
            output.frameLength = 0
            var error: NSError?
            let status = entry.converter.convert(to: output, error: &error) { _, outStatus in
                outStatus.pointee = .endOfStream
                return nil
            }
            guard status != .error, let channels = output.floatChannelData else { return }
            if output.frameLength > 0 {
                body(UnsafeBufferPointer(start: channels[0], count: Int(output.frameLength)))
            }
            guard status == .haveData else { return }
        }
    }

    /// The entry for `format`, built on first use. Caller holds the lock.
    private func entry(for format: AVAudioFormat) -> Entry? {
        if let last = entries.last, last.format == format { return last }
        if let index = entries.firstIndex(where: { $0.format == format }) {
            let hit = entries.remove(at: index)
            entries.append(hit)
            return hit
        }
        guard let converter = AVAudioConverter(from: format, to: targetFormat),
              let output = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: 4096)
        else { return nil }
        let entry = Entry(format: format, converter: converter, output: output)
        entries.append(entry)
        return entry
    }
}

/// The default input device as Core Audio reports it, read before any
/// capture path touches it.
///
/// With no input device, or one that reports 0 Hz or 0 channels,
/// `AVAudioEngine` raises an Objective-C exception on `installTap` or
/// `start()`, which Swift cannot catch. Checking here turns that into a
/// `CaptureError`.
struct InputDevice: Equatable {
    var sampleRate: Double
    var channels: UInt32
    /// The Core Audio device, or `kAudioObjectUnknown` when not read from one.
    var id: AudioDeviceID = kAudioObjectUnknown

    /// The current default input. Throws `CaptureError.noInputDevice` if there
    /// is none, or `.invalidInputFormat` if it cannot be recorded.
    static func current() throws -> InputDevice {
        guard let id = defaultInputID() else { throw CaptureError.noInputDevice }
        let device = InputDevice(sampleRate: nominalSampleRate(id), channels: inputChannels(id), id: id)
        try validate(sampleRate: device.sampleRate, channels: device.channels)
        return device
    }

    /// The device's name as the Sound settings show it, or nil.
    static func name(of id: AudioDeviceID) -> String? {
        var name: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioObjectPropertyName,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &name) == noErr,
              let value = name?.takeRetainedValue()
        else { return nil }
        return value as String
    }

    /// Throws `CaptureError.invalidInputFormat` unless both are positive.
    static func validate(sampleRate: Double, channels: UInt32) throws {
        guard sampleRate > 0, sampleRate.isFinite, channels > 0 else {
            throw CaptureError.invalidInputFormat(sampleRate: sampleRate, channels: channels)
        }
    }

    static func defaultInputID() -> AudioDeviceID? {
        var id = AudioDeviceID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id
        )
        guard status == noErr, id != kAudioObjectUnknown else { return nil }
        return id
    }

    static func nominalSampleRate(_ id: AudioDeviceID) -> Double {
        var rate: Float64 = 0
        var size = UInt32(MemoryLayout<Float64>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyNominalSampleRate,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &rate) == noErr else { return 0 }
        return rate
    }

    static func inputChannels(_ id: AudioDeviceID) -> UInt32 {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreamConfiguration,
            mScope: kAudioDevicePropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let raw = UnsafeMutableRawPointer.allocate(
            byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment
        )
        defer { raw.deallocate() }
        let list = raw.bindMemory(to: AudioBufferList.self, capacity: 1)
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, list) == noErr else { return 0 }
        return UnsafeMutableAudioBufferListPointer(list).reduce(0) { $0 + $1.mNumberChannels }
    }
}

/// Host time in nanoseconds: the clock Core Audio stamps each buffer with
/// (`mach_absolute_time`), so a press and the capture time of a sample can
/// be compared directly.
enum HostClock {
    private static let timebase: mach_timebase_info_data_t = {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return info
    }()

    /// Now, in host nanoseconds.
    static func now() -> UInt64 {
        nanoseconds(fromHostTime: mach_absolute_time())
    }

    /// A Core Audio host time (`AudioTimeStamp.mHostTime`,
    /// `AVAudioTime.hostTime`) in host nanoseconds.
    static func nanoseconds(fromHostTime hostTime: UInt64) -> UInt64 {
        let info = timebase
        if info.numer == info.denom { return hostTime }
        return UInt64((Double(hostTime) * Double(info.numer) / Double(info.denom)).rounded())
    }

    /// Seconds from `start` to `end`, negative if `end` came first.
    static func seconds(from start: UInt64, to end: UInt64) -> Double {
        Double(Int64(bitPattern: end &- start)) / 1_000_000_000
    }
}

/// Microphone authorization for the running daemon.
///
/// `Startup` exits on denied access before the daemon runs. This covers the
/// rest: asking once when the system has never asked, and refusing to start
/// the engine on a press when access is missing, so the user sees what to do
/// instead of a bare Core Audio error.
enum MicrophoneAccess {
    static var status: AVAuthorizationStatus {
        AVCaptureDevice.authorizationStatus(for: .audio)
    }

    /// Shows the system prompt if the user has never answered it. Returns at
    /// once; the answer is logged, then `answered` runs on the main queue
    /// (at once if there was nothing to ask). Never blocks the main thread.
    static func requestIfUndetermined(then answered: (@Sendable () -> Void)? = nil) {
        guard status == .notDetermined else {
            answered?()
            return
        }
        DictationLog.info("requesting microphone access")
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            DictationLog.info(granted ? "microphone access granted" : CaptureError.microphoneDenied.userMessage)
            if let answered { DispatchQueue.main.async(execute: answered) }
        }
    }

    /// The error a press should fail with for `status`, or nil if capture may
    /// start.
    static func captureError(for status: AVAuthorizationStatus) -> CaptureError? {
        switch status {
        case .authorized:
            return nil
        case .denied, .restricted:
            return .microphoneDenied
        case .notDetermined:
            return .microphonePending
        @unknown default:
            return nil
        }
    }
}

/// Why a recording could not start or produced nothing usable. Each case has
/// a one-line `userMessage` for the overlay; `description` adds the details
/// for the log. Neither ever contains audio or transcript text.
enum CaptureError: Error, UserFacingError, CustomStringConvertible {
    /// Microphone access is denied or restricted for this app.
    case microphoneDenied
    /// The system has not asked yet, or the prompt is still open.
    case microphonePending
    /// Core Audio reports no default input device.
    case noInputDevice
    /// The input reports a format that cannot be recorded (0 Hz or 0 channels).
    case invalidInputFormat(sampleRate: Double, channels: UInt32)
    /// `AVAudioEngine.start()` threw.
    case engineStartFailed(Error)
    /// The input route changed mid-recording (a device was connected or
    /// removed, or its format changed). The partial capture was discarded.
    case routeChanged

    var userMessage: String {
        switch self {
        case .microphoneDenied:
            return "microphone access denied: System Settings → Privacy & Security → Microphone"
        case .microphonePending:
            return "microphone access not granted yet: answer the macOS prompt, then try again"
        case .noInputDevice, .invalidInputFormat:
            return "no microphone available: choose an input in System Settings → Sound"
        case .engineStartFailed:
            return "microphone failed to start: try again, or check System Settings → Sound"
        case .routeChanged:
            return "microphone changed while recording: nothing captured, try again"
        }
    }

    var description: String {
        switch self {
        case .invalidInputFormat(let sampleRate, let channels):
            return "\(userMessage) (input reports \(sampleRate) Hz, \(channels) ch)"
        case .engineStartFailed(let error):
            let code = (error as NSError).code
            return "\(userMessage) (engine start: \((error as NSError).domain) \(code))"
        default:
            return userMessage
        }
    }
}

/// Cuts leading and trailing silence from a 16 kHz capture with a simple
/// energy threshold. Pure, so it is tested.
///
/// A push-to-talk capture starts before the first word and ends after the
/// last. Whisper pads every window to 30 s, so trimming does not shorten the
/// encoder's work within a window; it matters where the silence pushes a
/// capture past 30 s into a second window, and on quiet tails, where Whisper
/// can hallucinate text.
///
/// It errs toward keeping audio: a margin stays on each side, and a capture
/// whose loudest frame never clears the threshold comes back unchanged.
enum SilenceTrimmer {
    static let sampleRate = 16_000
    /// 10 ms frames.
    static let frameLength = 160
    /// Frames quieter than this RMS are silence whatever the rest of the capture.
    static let minimumLevel: Float = 0.003
    /// Frames quieter than this fraction of the loudest frame's RMS (−26 dB) are silence.
    static let relativeLevel: Float = 0.05
    /// Audio kept before the first voiced frame, for soft onsets.
    static let leadMargin = 0.25
    /// Audio kept after the last voiced frame, for trailing consonants.
    static let trailMargin = 0.35

    /// `audio` without its leading and trailing silence, margins kept.
    static func trim(_ audio: [Float]) -> [Float] {
        guard let range = voicedRange(audio) else { return audio }
        if range.count == audio.count { return audio }
        return Array(audio[range])
    }

    /// The sample range to keep, or nil if nothing clears the threshold.
    static func voicedRange(_ audio: [Float]) -> Range<Int>? {
        let frames = audio.count / frameLength
        guard frames > 0 else { return nil }
        var levels = [Float](repeating: 0, count: frames)
        audio.withUnsafeBufferPointer { samples in
            for f in 0..<frames {
                var sum: Float = 0
                for s in samples[(f * frameLength)..<((f + 1) * frameLength)] { sum += s * s }
                levels[f] = (sum / Float(frameLength)).squareRoot()
            }
        }
        let peak = levels.max() ?? 0
        let threshold = max(minimumLevel, peak * relativeLevel)
        guard peak >= threshold,
              let first = levels.firstIndex(where: { $0 >= threshold }),
              let last = levels.lastIndex(where: { $0 >= threshold })
        else { return nil }
        let start = max(0, first * frameLength - Int(leadMargin * Double(sampleRate)))
        let end = min(audio.count, (last + 1) * frameLength + Int(trailMargin * Double(sampleRate)))
        return start..<end
    }
}

enum AudioFileLoader {
    enum LoaderError: Error {
        case invalidFormat
        case conversionFailed(Error?)
    }

    static func load(url: URL) throws -> [Float] {
        let file = try AVAudioFile(forReading: url)
        let sourceFormat = file.processingFormat
        guard sourceFormat.sampleRate > 0, sourceFormat.channelCount > 0 else {
            throw LoaderError.invalidFormat
        }

        let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: AudioCapture.targetSampleRate,
            channels: 1,
            interleaved: false
        )!
        guard let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) else {
            throw LoaderError.invalidFormat
        }

        var samples: [Float] = []
        let chunkSize: AVAudioFrameCount = 16_384
        while file.framePosition < file.length {
            let framesToRead = min(chunkSize, AVAudioFrameCount(file.length - file.framePosition))
            guard let input = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: framesToRead) else {
                throw LoaderError.invalidFormat
            }
            try file.read(into: input, frameCount: framesToRead)
            guard input.frameLength > 0 else { break }

            let ratio = targetFormat.sampleRate / sourceFormat.sampleRate
            let outputCapacity = AVAudioFrameCount(Double(input.frameLength) * ratio) + 128
            guard let output = AVAudioPCMBuffer(
                pcmFormat: targetFormat,
                frameCapacity: outputCapacity
            ) else {
                throw LoaderError.invalidFormat
            }

            var supplied = false
            var conversionError: NSError?
            let status = converter.convert(to: output, error: &conversionError) { _, status in
                guard !supplied else {
                    status.pointee = .noDataNow
                    return nil
                }
                supplied = true
                status.pointee = .haveData
                return input
            }
            guard status != .error, let channelData = output.floatChannelData else {
                throw LoaderError.conversionFailed(conversionError)
            }
            samples.append(contentsOf: UnsafeBufferPointer(start: channelData[0], count: Int(output.frameLength)))
        }
        return samples
    }
}
