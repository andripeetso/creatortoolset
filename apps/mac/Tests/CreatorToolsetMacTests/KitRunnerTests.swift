import AppKit
import XCTest
@testable import CreatorToolsetMac

/// The kit spike: one neutral fixture kit draws a card at the right size and length, and the page it runs in has no
/// network. The fixture is a generic kit with a neutral title; no design system from any pack is used here.
/// Background red channel grows with t (0 → 191 over the frames below); the title is the card's content.
private let fixtureKit = """
function kitFrame(t, card) {
  const stage = document.getElementById('stage');
  stage.style.background = 'rgb(' + Math.round(255 * t) + ',80,160)';
  stage.textContent = card.title;
}
"""

@MainActor
final class KitRunnerTests: XCTestCase {
    private func card(kit: String = fixtureKit, seconds: Double = 1, fps: Int = 4) -> KitCard {
        KitCard(kit: kit, width: 320, height: 180, seconds: seconds, fps: fps, content: ["title": "Tiny Acrobatics"])
    }

    func testPageHasNoNetworkAndSizesTheStage() throws {
        let page = try KitRunner.html(for: card())
        XCTAssertTrue(page.contains("default-src 'none'"))
        XCTAssertFalse(page.contains("connect-src"), "default-src 'none' already blocks connect, frames and images")
        XCTAssertTrue(page.contains("width:320px;height:180px"))
        XCTAssertTrue(page.contains("\"title\":\"Tiny Acrobatics\""))
        XCTAssertTrue(page.contains("function kitFrame"))
    }

    func testRejectsAnEmptyCard() {
        XCTAssertThrowsError(try KitRunner.html(for: KitCard(kit: "", width: 0, height: 180, seconds: 1, fps: 4, content: [:])))
        XCTAssertThrowsError(try KitRunner.html(for: KitCard(kit: "", width: 320, height: 180, seconds: 0, fps: 4, content: [:])))
    }

    func testOneSecondAtFourFramesGivesFourFramesOfCardSize() async throws {
        let c = card(seconds: 1, fps: 4)
        XCTAssertEqual(c.frameCount, 4)
        let frames = try await KitRunner.frames(c)
        XCTAssertEqual(frames.count, 4)
        for data in frames {
            let rep = try XCTUnwrap(NSBitmapImageRep(data: data))
            XCTAssertEqual(rep.pixelsWide, 320)
            XCTAssertEqual(rep.pixelsHigh, 180)
        }
    }

    func testFramesFollowTheKitsTime() async throws {
        let frames = try await KitRunner.frames(card(seconds: 1, fps: 4))
        let first = try XCTUnwrap(NSBitmapImageRep(data: frames[0]))
        let last = try XCTUnwrap(NSBitmapImageRep(data: frames[3]))
        let redFirst = try XCTUnwrap(first.colorAt(x: 2, y: 2)).redComponent * 255
        let redLast = try XCTUnwrap(last.colorAt(x: 2, y: 2)).redComponent * 255
        XCTAssertLessThan(redFirst, 4, "t = 0 paints the background black in red")
        XCTAssertEqual(redLast, 191, accuracy: 4, "t = 0.75 paints 255 × 0.75 in red")
    }

    func testAKitWithoutKitFrameIsAnError() async {
        let broken = card(kit: "function somethingElse() {}")
        do {
            _ = try await KitRunner.frames(broken)
            XCTFail("a kit with no kitFrame must not render")
        } catch let KitRunnerError.badCard(message) {
            XCTAssertTrue(message.contains("kitFrame"), message)
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}
