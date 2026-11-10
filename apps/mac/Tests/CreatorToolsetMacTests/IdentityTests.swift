import XCTest
@testable import CreatorToolsetMac

final class IdentityTests: XCTestCase {
    func testReleasedAppKeepsTodaysNames() {
        let id = "com.creatortoolset.mac"
        XCTAssertEqual(AppIdentity.keychain("server", id), "com.creatortoolset.mac.server")
        XCTAssertEqual(AppIdentity.keychain("account", id), "com.creatortoolset.mac.account")
        XCTAssertEqual(AppIdentity.keychain("device", id), "com.creatortoolset.mac.device")
        XCTAssertEqual(AppIdentity.keychain("env", id), "com.creatortoolset.mac.env")
        XCTAssertEqual(AppIdentity.tag(id), "")
        XCTAssertEqual(AppIdentity.port(id), 43128)
    }

    func testABuildWithItsOwnBundleIdKeepsTodaysNamesToo() {
        for id in ["com.example.creatortoolset.mac", "com.apple.dt.xctest.tool", "com.creatortoolset.mac.", "com.creatortoolset.macx"] {
            XCTAssertEqual(AppIdentity.keychain("device", id), "com.creatortoolset.mac.device", id)
            XCTAssertEqual(AppIdentity.tag(id), "", id)
            XCTAssertEqual(AppIdentity.port(id), 43128, id)
        }
    }

    func testACopyGetsItsOwnNames() {
        let id = "com.creatortoolset.mac.fresh"
        XCTAssertEqual(AppIdentity.keychain("device", id), "com.creatortoolset.mac.fresh.device")
        XCTAssertNotEqual(AppIdentity.keychain("device", id), AppIdentity.keychain("device", "com.creatortoolset.mac"))
        XCTAssertEqual(AppIdentity.tag(id), " (fresh)")
        XCTAssertEqual(AppIdentity.port(id), 43129)
    }
}
