import XCTest
import CreatorToolsetShared

/// The host rules both apps read: loopback, private and tailnet addresses, in their bracketed and trailing-dot forms.
final class HostClassTests: XCTestCase {
    func testLoopbackPrivateAndPublicHosts() {
        XCTAssertTrue(HostClass.isLoopback("[::1]"))
        XCTAssertTrue(HostClass.isLoopback("127.0.0.2"))
        XCTAssertTrue(HostClass.isLoopback("LOCALHOST."))
        XCTAssertFalse(HostClass.isLoopback("tinyacrobatics.example"))
        XCTAssertTrue(HostClass.isPrivate("10.0.0.2"))
        XCTAssertTrue(HostClass.isPrivate("fe80::1"))
        XCTAssertTrue(HostClass.isTailnet("fd7a:115c:a1e0::1"))
        XCTAssertFalse(HostClass.isPrivate("8.8.8.8"))
        XCTAssertNil(HostClass.ipv4("256.1.1.1"))
    }
}
