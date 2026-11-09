import XCTest
@testable import CreatorToolsetMac

final class ScreenPermissionTests: XCTestCase {
    func testGrantedAlwaysProceeds() {
        XCTAssertEqual(screenAccessStep(requestedBefore: false, granted: true), .proceed)
        XCTAssertEqual(screenAccessStep(requestedBefore: true, granted: true), .proceed)
    }

    func testFirstTimeAsksMacOSOnly() {
        XCTAssertEqual(screenAccessStep(requestedBefore: false, granted: false), .requestSystem)
    }

    func testLaterAttemptsWhileOffShowTheAlert() {
        XCTAssertEqual(screenAccessStep(requestedBefore: true, granted: false), .showAlert)
    }

    func testReopenOfferOnlyAfterSettingsVisitAndStillOff() {
        XCTAssertTrue(offerReopenAfterSettings(awaiting: true, granted: false))
        XCTAssertFalse(offerReopenAfterSettings(awaiting: false, granted: false))
        XCTAssertFalse(offerReopenAfterSettings(awaiting: true, granted: true))
        XCTAssertFalse(offerReopenAfterSettings(awaiting: false, granted: true))
    }
}
