import AppKit
import AVFoundation

/// What a recording captures: a whole display, one window, or an area of a display.
enum RecordSource: Equatable {
    case display(CGDirectDisplayID)
    /// The window's frame when it was picked: global points, top-left origin.
    case window(CGWindowID, CGRect)
    /// `rect` in the display's points, top-left origin.
    case area(CGDirectDisplayID, CGRect)
}

/// The toolbar's three source buttons.
enum SourceKind: String, CaseIterable { case display, window, area }

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
