import AppKit
import AVFoundation

/// What a recording captures: a whole display, one window, an area of a display, or the screen of an iPhone or iPad
/// on a cable.
enum RecordSource: Equatable {
    case display(CGDirectDisplayID)
    /// The window's frame when it was picked: global points, top-left origin.
    case window(CGWindowID, CGRect)
    /// `rect` in the display's points, top-left origin.
    case area(CGDirectDisplayID, CGRect)
    /// The device's uniqueID (Phone.swift).
    case device(String)

    var isDevice: Bool {
        if case .device = self { return true }
        return false
    }
}

/// The toolbar's source buttons. Display, Window and Area open the picker over the screen; Device lists the iPhones
/// and iPads on a cable.
enum SourceKind: String, CaseIterable { case display, window, area, device }

/// Where a finished recording is sent from the preview or the /record page.
enum ShareDestination: String { case review, notes, guide }

/// How the recorder's files are encoded (the screen and the camera): H.264, High profile, a key frame every 2 s
/// (Review seeks fast), and every frame in the order it is shown. Never with the encoder's frame reordering: the
/// files are written in fragments (movieFragmentInterval, so a crash leaves a playable file), and a file written
/// that way from frames that arrive at uneven times often fails to close once it is longer than about 9 s
/// (AVFoundation -11800, under it -16341), leaving only the fragments written until then. Measured with this
/// writer fed made-up frames in real time: with reordering between 2 of 24 and 12 of 16 takes failed, batch by
/// batch (none of 54 under 8 s); without it none of 177 (10 to 21 s, also at 2826×2934, also with a screen that
/// stands still).
func recorderVideoSettings(width: Int, height: Int, bitRate: Int, frameRate: Int) -> [String: Any] {
    [
        AVVideoCodecKey: AVVideoCodecType.h264,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: [
            AVVideoAverageBitRateKey: bitRate,
            AVVideoExpectedSourceFrameRateKey: frameRate,
            AVVideoMaxKeyFrameIntervalDurationKey: 2,
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            AVVideoAllowFrameReorderingKey: false,
        ],
    ]
}

/// A sound track's buffers in the one layout it is written in: 32-bit float samples, interleaved, at the track's own
/// rate and channel count. The writer reads every buffer of a track as laid out like its first one, and an audio
/// interface can hand over its first buffers in another layout than the rest (measured on a USB interface: 24-bit
/// samples in 4 bytes each for one or two buffers, then in 3, in about half of the takes). Read by the first
/// layout, the rest came out as noise at three quarters of its length: the whole voice track.
struct SoundLayout {
    private var converter: AVAudioConverter?
    private var plain: AVAudioFormat?
    private var rate = 0.0
    private var channels: AVAudioChannelCount = 0
    /// Buffers that could not be read or came at another rate or channel count than the track's, for the log.
    private(set) var leftOut = 0

    /// `buffer` as float samples at the same time, or nil when it is left out. A track whose layout cannot be made
    /// (more channels than a layout is known for) is written as it comes.
    mutating func take(_ buffer: CMSampleBuffer) -> CMSampleBuffer? {
        guard let description = buffer.formatDescription else { return nil }
        let from = AVAudioFormat(cmAudioFormatDescription: description)
        if rate == 0 {
            rate = from.sampleRate
            channels = from.channelCount
            plain = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: channels, interleaved: true)
        }
        guard let plain else { return buffer }
        let frames = AVAudioFrameCount(buffer.numSamples)
        if converter?.inputFormat != from { converter = AVAudioConverter(from: from, to: plain) }
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: CMTimeScale(rate)),
                                        presentationTimeStamp: buffer.presentationTimeStamp, decodeTimeStamp: .invalid)
        var made: CMSampleBuffer?
        guard from.sampleRate == rate, from.channelCount == channels, let converter,
              let input = AVAudioPCMBuffer(pcmFormat: from, frameCapacity: frames),
              let output = AVAudioPCMBuffer(pcmFormat: plain, frameCapacity: frames) else {
            leftOut += 1
            return nil
        }
        input.frameLength = frames
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(buffer, at: 0, frameCount: Int32(frames),
                                                           into: input.mutableAudioBufferList) == noErr,
              (try? converter.convert(to: output, from: input)) != nil,
              CMSampleBufferCreate(allocator: nil, dataBuffer: nil, dataReady: false, makeDataReadyCallback: nil,
                                   refcon: nil, formatDescription: plain.formatDescription,
                                   sampleCount: CMItemCount(output.frameLength), sampleTimingEntryCount: 1,
                                   sampleTimingArray: &timing, sampleSizeEntryCount: 0, sampleSizeArray: nil,
                                   sampleBufferOut: &made) == noErr, let made,
              CMSampleBufferSetDataBufferFromAudioBufferList(made, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil,
                                                             flags: 0, bufferList: output.audioBufferList) == noErr
        else {
            leftOut += 1
            return nil
        }
        return made
    }
}
