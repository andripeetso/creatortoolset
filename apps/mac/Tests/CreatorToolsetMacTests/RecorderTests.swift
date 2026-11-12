import AppKit
import AVFoundation
import XCTest
@testable import CreatorToolsetMac

final class RecorderTests: XCTestCase {

    func testTheRecordersFilesAreEncodedWithoutFrameReordering() {
        // With reordering, a file written in fragments failed to close in most takes longer than about 9 s
        // (AVFoundation -11800 / -16341) and only its first fragments were kept; see recorderVideoSettings.
        for settings in [recorderVideoSettings(width: 2826, height: 2934, bitRate: 19_900_000, frameRate: 60),
                         recorderVideoSettings(width: 1280, height: 720, bitRate: 6_000_000, frameRate: 30)] {
            let compression = settings[AVVideoCompressionPropertiesKey] as? [String: Any]
            XCTAssertEqual(compression?[AVVideoAllowFrameReorderingKey] as? Bool, false)
            XCTAssertEqual(compression?[AVVideoMaxKeyFrameIntervalDurationKey] as? Int, 2)
        }
    }

    /// A sound buffer of 512 frames at half of full level: 24-bit samples, two channels, each sample in `bytes`
    /// bytes (3 = packed, 4 = in the high bits of 32).
    private func sound(bytes: Int, at seconds: Double = 0) throws -> CMSampleBuffer {
        let asbd = AudioStreamBasicDescription(
            mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | (bytes == 3 ? kAudioFormatFlagIsPacked : kAudioFormatFlagIsAlignedHigh),
            mBytesPerPacket: UInt32(bytes * 2), mFramesPerPacket: 1, mBytesPerFrame: UInt32(bytes * 2), mChannelsPerFrame: 2,
            mBitsPerChannel: 24, mReserved: 0)
        let format = try CMAudioFormatDescription(audioStreamBasicDescription: asbd)
        let sample: [UInt8] = bytes == 3 ? [0, 0, 0x40] : [0, 0, 0, 0x40]   // 0x400000 of 0x800000, little-endian
        let data = Data((0..<1024).flatMap { _ in sample })
        let block = try CMBlockBuffer(length: data.count)
        try data.withUnsafeBytes { try block.replaceDataBytes(with: $0) }
        return try CMSampleBuffer(dataBuffer: block, formatDescription: format, numSamples: 512,
                                  presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 48_000), packetDescriptions: [])
    }

    private func floats(_ buffer: CMSampleBuffer) throws -> [Float] {
        try XCTUnwrap(buffer.dataBuffer).dataBytes().withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
    }

    func testASoundTrackIsWrittenInOneLayoutWhateverLayoutItsBuffersComeIn() throws {
        // an audio interface's first buffers in another layout than the rest: the track reads each by its own layout
        var layout = SoundLayout()
        let odd = try XCTUnwrap(layout.take(try sound(bytes: 4)))
        let oddToo = try XCTUnwrap(layout.take(try sound(bytes: 4, at: 0.01)))
        let rest = try XCTUnwrap(layout.take(try sound(bytes: 3, at: 0.02)))
        XCTAssertTrue(CMFormatDescriptionEqual(try XCTUnwrap(odd.formatDescription), otherFormatDescription: try XCTUnwrap(rest.formatDescription)))
        XCTAssertEqual(rest.formatDescription?.audioStreamBasicDescription?.mBytesPerFrame, 8)   // two float samples
        for made in [odd, oddToo, rest] {
            XCTAssertEqual(made.numSamples, 512)
            let samples = try floats(made)
            XCTAssertEqual(samples.count, 1024)
            XCTAssertTrue(samples.allSatisfy { abs($0 - 0.5) < 0.0001 }, "read by the wrong layout: \(samples.prefix(4))")
        }
        XCTAssertEqual(rest.presentationTimeStamp.seconds, 0.02, accuracy: 0.0001)
        XCTAssertEqual(layout.leftOut, 0)
    }

    /// Float samples at half level, `channels` of them, each channel in its own buffer or all in one.
    /// 512 frames of float sound, every sample of channel c at `levels[c]` (0.5 in all when not said).
    private func floatSound(rate: Double, channels: Int, interleaved: Bool, at: CMTime = .zero, levels: [Float]? = nil) throws -> CMSampleBuffer {
        let format = try XCTUnwrap(AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: AVAudioChannelCount(channels), interleaved: interleaved))
        let pcm = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 512))
        pcm.frameLength = 512
        let level = { (c: Int) in levels?[c] ?? 0.5 }
        for (b, buffer) in UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList).enumerated() {
            let samples = UnsafeMutableBufferPointer<Float>(buffer)
            for i in samples.indices { samples[i] = level(interleaved ? i % channels : b) }
        }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(rate)), presentationTimeStamp: at, decodeTimeStamp: .invalid)
        var made: CMSampleBuffer?
        XCTAssertEqual(CMSampleBufferCreate(allocator: nil, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil, refcon: nil,
                                            formatDescription: format.formatDescription, sampleCount: 512, sampleTimingEntryCount: 1,
                                            sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil, sampleBufferOut: &made), noErr)
        let buffer = try XCTUnwrap(made)
        XCTAssertEqual(CMSampleBufferSetDataBufferFromAudioBufferList(buffer, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
                                                                      flags: 0, bufferList: pcm.audioBufferList), noErr)
        return buffer
    }

    func testEveryUsualMicrophoneAndTheMacsSoundComeThroughWhole() throws {
        // a built-in or wireless microphone (one channel, float), 44.1 kHz, and the Mac's sound (two channels, each in its own buffer)
        for (rate, channels, interleaved) in [(48_000.0, 1, true), (44_100.0, 1, false), (24_000.0, 1, true), (48_000.0, 2, false), (44_100.0, 2, true)] {
            var layout = SoundLayout()
            let made = try XCTUnwrap(layout.take(try floatSound(rate: rate, channels: channels, interleaved: interleaved)), "\(rate) Hz, \(channels) ch")
            let asbd = try XCTUnwrap(made.formatDescription?.audioStreamBasicDescription)
            XCTAssertEqual(asbd.mSampleRate, rate)
            XCTAssertEqual(Int(asbd.mChannelsPerFrame), channels)
            XCTAssertEqual(made.numSamples, 512)
            let samples = try floats(made)
            XCTAssertEqual(samples.count, 512 * channels)
            XCTAssertTrue(samples.allSatisfy { abs($0 - 0.5) < 0.0001 }, "\(rate) Hz, \(channels) ch: \(samples.prefix(4))")
            XCTAssertEqual(layout.leftOut, 0)
        }
    }

    /// A frame of one grey (`luma`, 16 black to 235 white), `width`×`height`, in the layout the recorder captures in,
    /// at `at` on the host clock.
    private func frame(width: Int, height: Int, at: CMTime, luma: Int32 = 128) throws -> CMSampleBuffer {
        var pixels: CVPixelBuffer?
        XCTAssertEqual(CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange,
                                           [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixels), kCVReturnSuccess)
        let image = try XCTUnwrap(pixels)
        CVPixelBufferLockBaseAddress(image, [])
        for plane in 0..<2 {
            memset(CVPixelBufferGetBaseAddressOfPlane(image, plane), plane == 0 ? luma : 128, CVPixelBufferGetBytesPerRowOfPlane(image, plane) * CVPixelBufferGetHeightOfPlane(image, plane))
        }
        CVPixelBufferUnlockBaseAddress(image, [])
        let format = try CMVideoFormatDescription(imageBuffer: image)
        let timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: at, decodeTimeStamp: .invalid)
        return try CMSampleBuffer(imageBuffer: image, formatDescription: format, sampleTiming: timing)
    }

    /// The voice is one channel whatever the microphone sends: an interface's voice on one input of two comes through
    /// at its own level (not halved, not in one ear), the same voice on both inputs once, a one-channel microphone as it
    /// is; and from the moment a channel carries sound, an input with nothing plugged in is left out.
    func testTheVoiceIsOneChannelOfTheChannelsThatCarrySound() throws {
        let cases: [(channels: Int, interleaved: Bool, levels: [Float], expect: Float)] = [
            (2, true, [0.5, 0], 0.5),       // the interface: voice on input 1, input 2 empty
            (2, false, [0, 0.5], 0.5),      // plugged into input 2
            (2, true, [0.5, 0.5], 0.5),     // the same voice on both
            (2, true, [0.4, 0.2], 0.3),     // two voices
            (1, true, [0.5], 0.5),          // a built-in microphone
        ]
        for c in cases {
            var layout = SoundLayout(mono: true)
            let made = try XCTUnwrap(layout.take(try floatSound(rate: 48_000, channels: c.channels, interleaved: c.interleaved, levels: c.levels)))
            XCTAssertEqual(made.formatDescription?.audioStreamBasicDescription?.mChannelsPerFrame, 1, "\(c.levels)")
            let samples = try floats(made)
            XCTAssertEqual(samples.count, 512)
            XCTAssertTrue(samples.allSatisfy { abs($0 - c.expect) < 0.0001 }, "\(c.levels): \(samples.prefix(3))")
        }
        // the room before anyone speaks, an empty input's faint hum, then the voice: from then on the hum is not in it
        var layout = SoundLayout(mono: true)
        _ = layout.take(try floatSound(rate: 48_000, channels: 2, interleaved: true, levels: [0.003, 0.002]))
        let spoken = try floats(XCTUnwrap(layout.take(try floatSound(rate: 48_000, channels: 2, interleaved: true, levels: [0.5, 0.002]))))
        XCTAssertTrue(spoken.allSatisfy { abs($0 - 0.5) < 0.0001 }, "\(spoken.prefix(3))")
        // the Mac's sound stays in two channels
        var mac = SoundLayout()
        XCTAssertEqual(try XCTUnwrap(mac.take(try floatSound(rate: 48_000, channels: 2, interleaved: true))).formatDescription?.audioStreamBasicDescription?.mChannelsPerFrame, 2)
    }

    /// What a device on a cable sends (Capture.take): pictures, its own sound and the Mac's microphone, each timed on
    /// the host clock. The file has the picture and both sound tracks, the voice first, starts at the first picture
    /// and has no pointer log, since a phone has no pointer.
    func testADevicesPictureAndSoundAreWrittenAsOneRecording() async throws {
        guard #available(macOS 15.0, *) else { throw XCTSkip("the recorder needs macOS 15") }
        guard let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"] else {
            throw XCTSkip("Set CT_SCRATCH_DIR to a folder on the external disk: this test writes a video there")
        }
        let folder = URL(fileURLWithPath: base).appendingPathComponent("device-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("screen.mp4")
        // a phone held upright: taller than wide
        let capture = try Capture(file: file, width: 320, height: 692, mic: true, system: true, soundName: "device")
        try capture.open()
        let host = { CMClockGetTime(CMClockGetHostTimeClock()) }
        let send = { (buffer: CMSampleBuffer, track: Capture.Track) in capture.queue.sync { capture.take(buffer, track) } }
        // sound that comes before the first picture is not in the file
        try send(floatSound(rate: 48_000, channels: 2, interleaved: true, at: host()), .sound)
        let began = host()
        for _ in 0..<45 {   // a second and a half, as it happens
            let now = host()
            try send(frame(width: 320, height: 692, at: now), .picture)
            for part in 0..<3 {   // 512 samples every 11 ms: about real time at 48 kHz
                let at = now + CMTime(value: CMTimeValue(part * 512), timescale: 48_000)
                try send(floatSound(rate: 48_000, channels: 2, interleaved: true, at: at), .sound)
                try send(floatSound(rate: 48_000, channels: 1, interleaved: true, at: at), .voice)
            }
            try await Task.sleep(for: .milliseconds(33))
        }
        let events = try await capture.stop()
        let lasted = (host() - began).seconds
        XCTAssertEqual(events.audio, ["mic", "device"])   // the editor calls it Device sound
        XCTAssertTrue(events.moves.isEmpty && events.clicks.isEmpty)
        XCTAssertEqual([events.width, events.height], [320, 692])
        let asset = AVURLAsset(url: file)
        let duration = try await asset.load(.duration).seconds
        // a second and a half of pictures went in; on a busy Mac the writer drops what it cannot take in time
        XCTAssertGreaterThan(duration, 1.0)
        XCTAssertLessThanOrEqual(duration, lasted + 0.25)
        let video = try await asset.loadTracks(withMediaType: .video)
        XCTAssertEqual(video.count, 1)
        let size = try await video[0].load(.naturalSize)
        XCTAssertEqual([size.width, size.height], [320, 692])
        let sound = try await asset.loadTracks(withMediaType: .audio)
        XCTAssertEqual(sound.count, 2)
        for track in sound {
            let range = try await track.load(.timeRange)
            XCTAssertGreaterThan(range.duration.seconds, 1.0)
        }
        // the voice in one channel, the device's sound in two
        var channels: [UInt32] = []
        for track in sound { channels.append(try await track.load(.formatDescriptions).first?.audioStreamBasicDescription?.mChannelsPerFrame ?? 0) }
        XCTAssertEqual(channels, [1, 2])
    }

    /// A device turned on its side while it records sends its picture the other way round: it goes into the file
    /// whole, in the middle, with black above and below, not stretched to the file's shape.
    func testAPictureTurnedOnItsSideGoesInWholeNotStretched() async throws {
        guard #available(macOS 15.0, *) else { throw XCTSkip("the recorder needs macOS 15") }
        guard let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"] else {
            throw XCTSkip("Set CT_SCRATCH_DIR to a folder on the external disk: this test writes a video there")
        }
        let folder = URL(fileURLWithPath: base).appendingPathComponent("device-turn-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appendingPathComponent("screen.mp4")
        let capture = try Capture(file: file, width: 320, height: 692, mic: false, system: false)
        try capture.open()
        let host = { CMClockGetTime(CMClockGetHostTimeClock()) }
        // upright for half a second, then on its side, all in white
        for n in 0..<36 {
            let turned = n >= 15
            let picture = try frame(width: turned ? 692 : 320, height: turned ? 320 : 692, at: host(), luma: 235)
            capture.queue.sync { capture.take(picture, .picture) }
            try await Task.sleep(for: .milliseconds(33))
        }
        _ = try await capture.stop()
        let asset = AVURLAsset(url: file)
        let end = try await asset.load(.duration).seconds
        let images = AVAssetImageGenerator(asset: asset)
        images.requestedTimeToleranceBefore = .zero
        images.requestedTimeToleranceAfter = .zero
        let brightness = { (image: CGImage, x: Int, y: Int) -> Int in
            let rep = NSBitmapImageRep(cgImage: image)
            let c = rep.colorAt(x: x, y: y)?.usingColorSpace(.deviceRGB)
            return Int(((c?.redComponent ?? 0) + (c?.greenComponent ?? 0) + (c?.blueComponent ?? 0)) / 3 * 255)
        }
        let upright = try await images.image(at: CMTime(seconds: 0.2, preferredTimescale: 600)).image
        let onItsSide = try await images.image(at: CMTime(seconds: end - 0.25, preferredTimescale: 600)).image
        XCTAssertEqual([upright.width, upright.height, onItsSide.width, onItsSide.height], [320, 692, 320, 692])
        XCTAssertGreaterThan(brightness(upright, 160, 20), 200)      // upright: white to the top
        XCTAssertLessThan(brightness(onItsSide, 160, 20), 40)        // on its side: black above
        XCTAssertLessThan(brightness(onItsSide, 160, 672), 40)       // and below
        XCTAssertGreaterThan(brightness(onItsSide, 160, 346), 200)   // the picture in the middle
        XCTAssertGreaterThan(brightness(onItsSide, 4, 346), 200)     // as wide as the file
    }

    /// The microphone's level changes 20 times a second while the toolbar is open; the toolbar's choices are not told
    /// each time (the camera bubble follows them, and reopened the camera on every one).
    @MainActor func testTheMicrophonesLevelIsNotAChangeOfTheToolbarsChoices() {
        let setup = RecordSetup()
        var told = 0
        let watch = setup.objectWillChange.sink { told += 1 }
        for n in 0..<20 { setup.level.value = Float(n) / 20 }
        withExtendedLifetime(watch) { XCTAssertEqual(told, 0) }
    }

    /// An update waits until the person is away from the Mac, not just away from this app.
    func testAnUpdateWaitsUntilNobodyIsAtTheMac() {
        XCTAssertTrue(updateMayInstall(appActive: false, aiJobs: 0, recording: false, secondsSinceInput: 301))
        XCTAssertFalse(updateMayInstall(appActive: false, aiJobs: 0, recording: false, secondsSinceInput: 60))   // working in another app
        XCTAssertFalse(updateMayInstall(appActive: true, aiJobs: 0, recording: false, secondsSinceInput: 900))
        XCTAssertFalse(updateMayInstall(appActive: false, aiJobs: 1, recording: false, secondsSinceInput: 900))
        XCTAssertFalse(updateMayInstall(appActive: false, aiJobs: 0, recording: true, secondsSinceInput: 900))
    }

    func testPointerOnTheMainDisplay() {
        // main display 1512×982 points: bottom-left origin in, top-left 0–1 out
        let main = CGRect(x: 0, y: 0, width: 1512, height: 982)
        XCTAssertEqual(normalizedPointer(CGPoint(x: 0, y: 982), display: main, mainHeight: 982).x, 0)
        XCTAssertEqual(normalizedPointer(CGPoint(x: 0, y: 982), display: main, mainHeight: 982).y, 0)
        let corner = normalizedPointer(CGPoint(x: 1512, y: 0), display: main, mainHeight: 982)
        XCTAssertEqual(corner.x, 1)
        XCTAssertEqual(corner.y, 1)
    }

    func testPointerOnASecondDisplayAboveAndRight() {
        // a 3008×1692 display whose top left sits at (1512, -1692) in global top-left coordinates
        let second = CGRect(x: 1512, y: -1692, width: 3008, height: 1692)
        let middle = normalizedPointer(CGPoint(x: 1512 + 1504, y: 982 + 846), display: second, mainHeight: 982)
        XCTAssertEqual(middle.x, 0.5)
        XCTAssertEqual(middle.y, 0.5)
        // still on the main display: outside 0–1, Review hides it
        XCTAssertLessThan(normalizedPointer(CGPoint(x: 10, y: 10), display: second, mainHeight: 982).x, 0)
    }

    func testCaptureSizeCapsAt4K() {
        XCTAssertTrue(captureSize(points: CGSize(width: 3008, height: 1692), scale: 2) == (3840, 2160))
        XCTAssertTrue(captureSize(points: CGSize(width: 1512, height: 982), scale: 2) == (3024, 1964))
        XCTAssertTrue(captureSize(points: CGSize(width: 1921, height: 1081), scale: 1) == (1920, 1080))   // even
        let tall = captureSize(points: CGSize(width: 1504, height: 1565), scale: 2)   // a tall window: 4K's pixels at most
        XCTAssertTrue(tall.width * tall.height <= 3840 * 2160 && tall.width > 2800, "\(tall)")
    }

    // Placement, in AppKit's global points (y grows upwards). A 3008×1692 screen above and right of a 1512×982 main
    // display, so its origin is not zero: the menu bar is off the top and a 70 pt Dock off the bottom.
    private let visible = CGRect(x: 1512, y: 982 + 70, width: 3008, height: 1692 - 70 - 25)
    private let bar = CGSize(width: 250, height: 44)

    func testBarSitsUnderTheRecordedWindow() {
        let window = CGRect(x: 2400, y: 1600, width: 1157, height: 563)
        XCTAssertEqual(barOrigin(recorded: window, visible: visible, size: bar), CGPoint(x: 2400 + 578.5 - 125, y: 1600 - 10 - 44))
    }

    func testBarGoesAboveWhenThereIsNoRoomBelow() {
        let window = CGRect(x: 2400, y: visible.minY + 20, width: 1157, height: 563)   // 20 pt over the Dock
        XCTAssertEqual(barOrigin(recorded: window, visible: visible, size: bar).y, window.maxY + 10)
    }

    func testBarGoesInsideAWindowAsTallAsTheScreen() {
        let window = CGRect(x: 2400, y: visible.minY, width: 1157, height: visible.height)
        XCTAssertEqual(barOrigin(recorded: window, visible: visible, size: bar).y, window.minY + 16)
    }

    func testBarStaysOnTheScreen() {
        // a window hanging off the left and bottom edges: the bar is pulled fully inside
        let off = barOrigin(recorded: CGRect(x: 1300, y: 900, width: 300, height: 400), visible: visible, size: bar)
        XCTAssertEqual(off.x, visible.minX)
        XCTAssertTrue(visible.contains(CGRect(origin: off, size: bar)))
        let right = barOrigin(recorded: CGRect(x: 4400, y: 1600, width: 300, height: 400), visible: visible, size: bar)
        XCTAssertEqual(right.x, visible.maxX - 250)
    }

    func testBarKeepsTheTopCentreForAWholeDisplay() {
        XCTAssertEqual(barOrigin(recorded: nil, visible: visible, size: bar), CGPoint(x: visible.midX - 125, y: visible.maxY - 44 - 12))
    }

    func testPreviewOpensAtTheRecordedCorner() {
        let size = CGSize(width: 340, height: 210)
        let window = CGRect(x: 2400, y: 1600, width: 1157, height: 563)
        XCTAssertEqual(previewOrigin(recorded: window, visible: visible, size: size), CGPoint(x: window.maxX - 340 - 16, y: 1616))
        // a whole display: the screen's bottom right, as before
        XCTAssertEqual(previewOrigin(recorded: nil, visible: visible, size: size), CGPoint(x: visible.maxX - 356, y: visible.minY + 16))
        // a window off the right and bottom edges: still fully on the screen
        let off = previewOrigin(recorded: CGRect(x: 4300, y: 900, width: 600, height: 400), visible: visible, size: size)
        XCTAssertEqual(off, CGPoint(x: visible.maxX - 340, y: visible.minY))
    }

    @MainActor
    func testAPressOnTheAppsOwnFloatingWindowIsNotAClick() {
        let bar = NSWindow(), main = NSWindow()
        XCTAssertTrue(logsClick(.leftMouseDown, on: nil, own: [bar]))          // another app's window
        XCTAssertTrue(logsClick(.rightMouseDown, on: main, own: [bar]))        // the app's main window can be what is recorded
        XCTAssertFalse(logsClick(.leftMouseDown, on: bar, own: [bar]))         // Stop on the bar
        XCTAssertFalse(logsClick(.mouseMoved, on: nil, own: [bar]))
        XCTAssertFalse(logsClick(.leftMouseDragged, on: main, own: []))
        // a release is logged by the same rule, and never as a click
        XCTAssertTrue(logsRelease(.leftMouseUp, on: nil, own: [bar]))
        XCTAssertTrue(logsRelease(.rightMouseUp, on: main, own: [bar]))
        XCTAssertFalse(logsRelease(.leftMouseUp, on: bar, own: [bar]))
        XCTAssertFalse(logsRelease(.leftMouseDown, on: nil, own: [bar]))
        XCTAssertFalse(logsClick(.leftMouseUp, on: nil, own: [bar]))
    }

    func testClockText() {
        XCTAssertEqual(clockText(42.9), "0:42")
        XCTAssertEqual(clockText(3725), "1:02:05")
    }
}
