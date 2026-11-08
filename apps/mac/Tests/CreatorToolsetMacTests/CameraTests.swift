import CoreMedia
import XCTest
@testable import CreatorToolsetMac

final class CameraTests: XCTestCase {
    private func t(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 600) }

    func testFramesBeforeBeginAreDropped() {
        XCTAssertNil(CameraTiming.outputTime(host: t(99), begin: t(100), pauses: []))
        XCTAssertNil(CameraTiming.outputTime(host: t(50), begin: nil, pauses: []))
    }

    func testFrameAfterBeginIsItsOffsetFromBegin() {
        XCTAssertEqual(CameraTiming.outputTime(host: t(101.5), begin: t(100), pauses: [])?.seconds ?? -1, 1.5, accuracy: 0.001)
    }

    func testPausedSpanIsRemovedAndFramesInsideItAreDropped() {
        let pauses = [CameraPause(start: t(102), end: t(105))]
        XCTAssertNil(CameraTiming.outputTime(host: t(103), begin: t(100), pauses: pauses))      // during the pause
        XCTAssertEqual(CameraTiming.outputTime(host: t(101), begin: t(100), pauses: pauses)?.seconds ?? -1, 1, accuracy: 0.001)
        XCTAssertEqual(CameraTiming.outputTime(host: t(106), begin: t(100), pauses: pauses)?.seconds ?? -1, 3, accuracy: 0.001)
    }

    func testOpenPauseDropsEverythingFromItsStart() {
        let pauses = [CameraPause(start: t(102), end: nil)]
        XCTAssertNil(CameraTiming.outputTime(host: t(104), begin: t(100), pauses: pauses))
        XCTAssertEqual(CameraTiming.outputTime(host: t(101), begin: t(100), pauses: pauses)?.seconds ?? -1, 1, accuracy: 0.001)
    }

    func testTwoPausesAddUp() {
        let pauses = [CameraPause(start: t(101), end: t(102)), CameraPause(start: t(104), end: t(106))]
        XCTAssertEqual(CameraTiming.outputTime(host: t(107), begin: t(100), pauses: pauses)?.seconds ?? -1, 4, accuracy: 0.001)
    }
}
