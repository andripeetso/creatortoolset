import AppKit
import XCTest
@testable import CreatorToolsetMac

/// One neutral fixture kit draws a card at the right size and length, and the page it runs in has no network. The
/// fixture is a generic kit with a neutral title; no design system from any pack is used here.
/// Background red channel grows with t (0 → 191 over the frames below); the title is the card's content.
private let fixtureKit = """
function kitFrame(t, card) {
  const stage = document.getElementById('stage');
  stage.style.background = 'rgb(' + Math.round(255 * t) + ',80,160)';
  stage.textContent = card.title;
}
"""

/// Every frame of the card as a bitmap of exactly the card's size.
@MainActor
func kitFrames(_ card: KitCard, limit: TimeInterval = KitRunner.cardLimit) async throws -> [NSBitmapImageRep] {
    var out: [NSBitmapImageRep] = []
    try await KitRunner.draw(card, limit: limit) { _, image in
        guard let exact = onBlack(image, width: card.width, height: card.height)?.makeImage() else { throw KitRunnerError.snapshotFailed }
        out.append(NSBitmapImageRep(cgImage: exact))
    }
    return out
}

@MainActor
final class KitRunnerTests: XCTestCase {
    private func card(kit: String = fixtureKit, seconds: Double = 1, fps: Double = 4) -> KitCard {
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
        XCTAssertThrowsError(try KitRunner.html(for: KitCard(kit: "", width: 320, height: 180, seconds: 1, fps: 0, content: [:])))
        XCTAssertThrowsError(try KitRunner.html(for: KitCard(kit: "", width: 320, height: 180, seconds: 1, fps: 4, content: ["when": Date()])))
    }

    func testNeitherTheScriptNorTheContentCanCloseItsScriptElement() throws {
        let page = try KitRunner.html(for: KitCard(kit: "var a = '</SCRIPT><p>out</p>';", width: 320, height: 180, seconds: 1, fps: 4,
                                                   content: ["title": "</script><p>out</p>"]))
        XCTAssertEqual(page.lowercased().components(separatedBy: "</script").count, 3, "two script elements, each closed once, by the page itself")
    }

    func testOneSecondAtFourFramesGivesFourFramesOfCardSize() async throws {
        let c = card(seconds: 1, fps: 4)
        XCTAssertEqual(c.frameCount, 4)
        XCTAssertEqual(card(seconds: 2.4, fps: 29.97).frameCount, 72)
        let frames = try await kitFrames(c)
        XCTAssertEqual(frames.count, 4)
        for rep in frames {
            XCTAssertEqual(rep.pixelsWide, 320)
            XCTAssertEqual(rep.pixelsHigh, 180)
        }
    }

    func testFramesFollowTheKitsTime() async throws {
        let frames = try await kitFrames(card(seconds: 1, fps: 4))
        let redFirst = try XCTUnwrap(frames[0].colorAt(x: 2, y: 2)).redComponent * 255
        let redLast = try XCTUnwrap(frames[3].colorAt(x: 2, y: 2)).redComponent * 255
        XCTAssertLessThan(redFirst, 4, "t = 0 paints the background black in red")
        XCTAssertEqual(redLast, 191, accuracy: 4, "t = 0.75 paints 255 × 0.75 in red")
    }

    func testTheContentReachesTheScriptAsTheServerSentIt() async throws {
        // numbers and nested values, not only text: the stage goes green only when all of them arrived as sent
        let kit = "function kitFrame(t, card) { if (card.n === 3 && card.tags[1] === 'b' && card.title === 'Tiny Acrobatics') document.getElementById('stage').style.background = 'rgb(0,255,0)'; }"
        let frames = try await kitFrames(KitCard(kit: kit, width: 320, height: 180, seconds: 1, fps: 1, content: ["title": "Tiny Acrobatics", "n": 3, "tags": ["a", "b"]]))
        XCTAssertEqual(try XCTUnwrap(frames[0].colorAt(x: 2, y: 2)).greenComponent, 1, accuracy: 0.02)
    }

    func testAPictureInTheScriptItselfDraws() async throws {
        // nothing loads from anywhere, so a picture a card needs comes inside its script, as a data: address
        let green = "data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%278%27 height=%278%27%3E%3Crect width=%278%27 height=%278%27 fill=%27rgb(0,255,0)%27/%3E%3C/svg%3E"
        let kit = "function kitFrame(t, card) { const s = document.getElementById('stage'); if (!s.firstChild) s.innerHTML = '<img src=\"\(green)\" style=\"display:block;width:320px;height:180px\">'; }"
        var last: NSBitmapImageRep?
        try await KitRunner.draw(card(kit: kit, seconds: 1, fps: 8)) { _, image in
            try await Task.sleep(nanoseconds: 40_000_000)   // a picture is decoded a moment after it is asked for
            last = onBlack(image, width: 320, height: 180)?.makeImage().map { NSBitmapImageRep(cgImage: $0) }
        }
        let c = try XCTUnwrap(last?.colorAt(x: 160, y: 90))
        XCTAssertEqual(c.greenComponent, 1, accuracy: 0.02)
        XCTAssertEqual(c.redComponent, 0, accuracy: 0.02)
    }

    func testAnEmptyStageIsBlack() async throws {
        // a clip has no see-through, so what the script leaves unpainted is black on every Mac, light or dark
        let frames = try await kitFrames(card(kit: "function kitFrame() {}", seconds: 1, fps: 1))
        let c = try XCTUnwrap(frames[0].colorAt(x: 160, y: 90))
        XCTAssertEqual(c.redComponent + c.greenComponent + c.blueComponent, 0, accuracy: 0.01)
    }

    func testAKitWithoutKitFrameIsAnError() async {
        let broken = card(kit: "function somethingElse() {}")
        do {
            _ = try await kitFrames(broken)
            XCTFail("a kit with no kitFrame must not render")
        } catch let KitRunnerError.badCard(message) {
            XCTAssertTrue(message.contains("kitFrame"), message)
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }
}
