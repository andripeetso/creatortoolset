import XCTest
@testable import CreatorToolsetMac

final class MicMeterTests: XCTestCase {
    func testDecibelsMapOntoZeroToOne() {
        XCTAssertEqual(MicLevel.fromDecibels(-60), 0, accuracy: 0.0001)
        XCTAssertEqual(MicLevel.fromDecibels(-30), 0.5, accuracy: 0.0001)
        XCTAssertEqual(MicLevel.fromDecibels(0), 1, accuracy: 0.0001)
        // outside the scale is clamped
        XCTAssertEqual(MicLevel.fromDecibels(-90), 0, accuracy: 0.0001)
        XCTAssertEqual(MicLevel.fromDecibels(6), 1, accuracy: 0.0001)
    }

    func testRMSMapsThroughDecibels() {
        XCTAssertEqual(MicLevel.fromRMS(1), 1, accuracy: 0.0001)     // 0 dB
        XCTAssertEqual(MicLevel.fromRMS(0.0316), 0.5, accuracy: 0.01) // about -30 dB
        XCTAssertEqual(MicLevel.fromRMS(0), 0)                        // silence, no log of zero
    }
}
