import AppKit
import Carbon.HIToolbox
import XCTest
@testable import CreatorToolsetMac

final class RecordShortcutTests: XCTestCase {
    func testShortcutNeedsCommandOptionOrControl() {
        XCTAssertNil(Shortcut.from(keyCode: UInt16(kVK_ANSI_R), flags: [.shift], characters: "r"))
        let s = Shortcut.from(keyCode: UInt16(kVK_ANSI_R), flags: [.option, .shift], characters: "r")
        XCTAssertEqual(s, .standard)
        XCTAssertEqual(Shortcut.from(keyCode: UInt16(kVK_F5), flags: [.control, .command], characters: nil)?.display, "⌃⌘F5")
    }
}
