import XCTest
@testable import CreatorToolsetMac

final class ThisMacAsksTests: XCTestCase {
    func testThePageMayAskOnlyTheQuestionsItNeeds() {
        // the Access button sends "access"; the AI questions stay as they were; anything else is answered as off
        XCTAssertTrue(thisMacAsks.contains("access"))
        XCTAssertTrue(thisMacAsks.contains("start"))
        XCTAssertTrue(thisMacAsks.contains("state"))
        XCTAssertFalse(thisMacAsks.contains("forget"))
        XCTAssertFalse(thisMacAsks.contains("ai:on"))
    }
}
