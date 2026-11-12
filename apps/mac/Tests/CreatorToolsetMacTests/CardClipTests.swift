import AVFoundation
import AppKit
import XCTest
@testable import CreatorToolsetMac

/// A card's files: the clip is H.264 with every frame and no sound, at the card's own size, rate and length, and the
/// three stills are the first, middle and last frame at 540 px wide.
@MainActor
final class CardClipTests: XCTestCase {
    /// Red grows with t, so a frame says how far into the card it is.
    private let kit = """
    function kitFrame(t, card) {
      const stage = document.getElementById('stage');
      stage.style.background = 'rgb(' + Math.round(200 * t) + ',80,160)';
      stage.textContent = card.title;
    }
    """

    private func clipFile() -> URL {
        let dir = testFolder("card-clip")
        addTeardownBlock { try? FileManager.default.removeItem(at: dir) }
        return dir.appendingPathComponent("card.mp4")
    }

    private func card(kit: String? = nil, seconds: Double = 1, fps: Double = 12) -> KitCard {
        KitCard(kit: kit ?? self.kit, width: 320, height: 568, seconds: seconds, fps: fps, content: ["title": "Tiny Acrobatics"])
    }

    /// How many pictures the clip holds, counted by reading every one.
    private func frameCount(_ asset: AVURLAsset) async throws -> Int {
        let videos = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(videos.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var count = 0
        while output.copyNextSampleBuffer() != nil { count += 1 }
        return count
    }

    func testACardBecomesAnH264ClipWithNoSoundAndThreeStills() async throws {
        let file = clipFile()
        let stills = try await drawCard(card(), clip: file, limit: KitRunner.cardLimit)

        let asset = AVURLAsset(url: file)
        let videos = try await asset.loadTracks(withMediaType: .video)
        XCTAssertEqual(videos.count, 1)
        let sound = try await asset.loadTracks(withMediaType: .audio)
        XCTAssertTrue(sound.isEmpty)
        let track = try XCTUnwrap(videos.first)
        let formats = try await track.load(.formatDescriptions)
        let format = try XCTUnwrap(formats.first)
        XCTAssertEqual(CMFormatDescriptionGetMediaSubType(format), kCMVideoCodecType_H264)
        let size = try await track.load(.naturalSize)
        XCTAssertEqual(size, CGSize(width: 320, height: 568))
        let rate = try await track.load(.nominalFrameRate)
        XCTAssertEqual(rate, 12, accuracy: 0.01)
        let length = try await asset.load(.duration).seconds
        XCTAssertEqual(length, 1, accuracy: 0.001)
        let frames = try await frameCount(asset)
        XCTAssertEqual(frames, 12)

        XCTAssertEqual(stills.count, 3)
        let reps = try stills.map { try XCTUnwrap(NSBitmapImageRep(data: $0)) }
        for rep in reps {
            XCTAssertEqual(rep.pixelsWide, 540)
            XCTAssertEqual(rep.pixelsHigh, 959)   // 568 × 540 / 320, rounded
        }
        // frames 0, 6 and 11 of 12: red is 200 × t
        let red = try reps.map { try XCTUnwrap($0.colorAt(x: 500, y: 900)).redComponent * 255 }
        XCTAssertEqual(red[0], 0, accuracy: 5)
        XCTAssertEqual(red[1], 100, accuracy: 5)
        XCTAssertEqual(red[2], 183, accuracy: 5)
    }

    func testAFractionalFrameRateKeepsItsLength() async throws {
        let file = clipFile()
        _ = try await drawCard(card(seconds: 1, fps: 29.97), clip: file, limit: KitRunner.cardLimit)
        let asset = AVURLAsset(url: file)
        let videos = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(videos.first)
        let rate = try await track.load(.nominalFrameRate)
        XCTAssertEqual(rate, 29.97, accuracy: 0.01)
        let length = try await asset.load(.duration).seconds
        XCTAssertEqual(length, 30 / 29.97, accuracy: 0.001)
        let frames = try await frameCount(asset)
        XCTAssertEqual(frames, 30)
    }

    func testAClipCanBeAsLargeAsACameraFile() async throws {
        // the server sends the size of the edit's own footage, which can be 4K either way up
        for (width, height) in [(3840, 2160), (2160, 3840)] {
            let file = clipFile()
            let big = KitCard(kit: kit, width: width, height: height, seconds: 0.1, fps: 20, content: ["title": "Tiny Acrobatics"])
            let stills = try await drawCard(big, clip: file, limit: KitRunner.cardLimit)
            XCTAssertEqual(stills.count, 3)
            let videos = try await AVURLAsset(url: file).loadTracks(withMediaType: .video)
            let track = try XCTUnwrap(videos.first)
            let size = try await track.load(.naturalSize)
            XCTAssertEqual(size, CGSize(width: width, height: height))
            let still = try XCTUnwrap(NSBitmapImageRep(data: stills[0]))
            XCTAssertEqual(still.pixelsWide, 540)
        }
    }

    func testStillsAreTheFirstMiddleAndLastFrame() {
        XCTAssertEqual(CardStill.frames(of: 72), [0, 36, 71])
        XCTAssertEqual(CardStill.frames(of: 2), [0, 1, 1])
        XCTAssertEqual(CardStill.frames(of: 1), [0, 0, 0])
        XCTAssertEqual(CardStill.height(cardWidth: 1080, cardHeight: 1920), 960)
        XCTAssertEqual(CardStill.height(cardWidth: 1920, cardHeight: 1080), 304)
    }

    func testACardThatPaintsNothingFailsAndLeavesNoFile() async {
        let file = clipFile()
        do {
            _ = try await drawCard(card(kit: "function kitFrame() {}"), clip: file, limit: KitRunner.cardLimit)
            XCTFail("an empty stage is not a card")
        } catch {
            XCTAssertEqual(error as? KitRunnerError, .blank)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
        // black drawn on purpose in the middle of a card is still a card: only all three stills empty is nothing
        let late = "function kitFrame(t) { if (t > 0.4) document.getElementById('stage').style.background = '#fff' }"
        let stills = try? await drawCard(card(kit: late), clip: file, limit: KitRunner.cardLimit)
        XCTAssertEqual(stills?.count, 3)
    }

    func testACardThatThrowsLeavesNoFile() async {
        let file = clipFile()
        do {
            _ = try await drawCard(card(kit: "function kitFrame(t) { if (t > 0.5) throw new Error('no such font') }"), clip: file, limit: KitRunner.cardLimit)
            XCTFail("a script that throws is not a card")
        } catch {
            XCTAssertEqual(error as? KitRunnerError, .badCard("Error: no such font"))
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path))
    }
}
