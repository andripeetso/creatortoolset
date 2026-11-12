import XCTest
@testable import CreatorToolset

/// Native Caption Studio reads a project as creatortoolset.com sends it
/// (captured from a local server, a text overlay added by hand) and sends
/// back what it doesn't edit untouched.
final class CaptionStudioTests: XCTestCase {
    private let project = Data(##"{"id":"994cafde-2bd9-4625-b48d-8bef086d8e05","name":"test","revision":4,"createdAt":1790645903648,"updatedAt":1790646143408,"duration":11.72,"fps":30,"model":"cloud/deepgram","autoCadence":true,"script":"","clips":[{"id":"3124a562-3352-424e-929e-11fd4e0a2b37","name":"test","duration":11.72,"createdAt":1790645903648,"srcWidth":1080,"srcHeight":1920,"srcFps":30,"style":{"fontFamily":"Montserrat","fontSizePct":2.5,"textColor":"#FFFFFF","highlightColor":"#FFFFFF","outlineColor":"#000000","outlineWidth":0,"shadowDepth":0,"boxEnabled":true,"boxColor":"#000000","boxOpacity":1,"uppercase":false,"lowercase":false,"position":"bottom","marginVPct":7,"animation":"none","wordsPerCaption":3,"maxCharsPerLine":24,"fitBox":true,"boxX":50,"boxY":63.9,"boxW":68.5,"boxH":4.17},"words":[{"end":0.55,"start":0.3,"text":"Hi,","timing":"aligned","utterance":0,"id":1,"confidence":0.98},{"end":0.85,"start":0.6,"text":"this","timing":"aligned","utterance":0,"id":2,"confidence":0.98},{"end":1.15,"start":0.9,"text":"is","timing":"aligned","utterance":0,"id":3,"confidence":0.98},{"end":1.45,"start":1.2,"text":"a","timing":"aligned","utterance":0,"id":4,"confidence":0.98},{"end":1.75,"start":1.5,"text":"quick","timing":"aligned","utterance":0,"id":5,"confidence":0.98},{"end":2.05,"start":1.8,"text":"test","timing":"aligned","utterance":0,"id":6,"confidence":0.98},{"start":2.1,"end":2.35,"text":"of","timing":"aligned","utterance":0,"id":7,"confidence":0.98},{"start":2.4,"end":2.65,"text":"Caption","timing":"aligned","utterance":0,"id":8,"confidence":0.98},{"confidence":0.98,"utterance":0,"timing":"aligned","text":"Studio","start":2.7,"end":2.95,"id":9}],"originalWords":[{"end":0.55,"start":0.3,"text":"Hi,","timing":"aligned","utterance":0,"id":1,"confidence":0.98},{"end":0.85,"start":0.6,"text":"this","timing":"aligned","utterance":0,"id":2,"confidence":0.98}],"cues":[{"start":0.3,"id":1,"end":2.099,"lines":[6],"words":[{"end":0.55,"start":0.3,"text":"Hi,","timing":"aligned","utterance":0,"id":1,"confidence":0.98},{"end":0.85,"start":0.6,"text":"this","timing":"aligned","utterance":0,"id":2,"confidence":0.98},{"end":1.15,"start":0.9,"text":"is","timing":"aligned","utterance":0,"id":3,"confidence":0.98},{"end":1.45,"start":1.2,"text":"a","timing":"aligned","utterance":0,"id":4,"confidence":0.98},{"end":1.75,"start":1.5,"text":"quick","timing":"aligned","utterance":0,"id":5,"confidence":0.98},{"end":2.05,"start":1.8,"text":"test","timing":"aligned","utterance":0,"id":6,"confidence":0.98}]},{"start":2.1,"id":2,"end":2.999,"lines":[3],"words":[{"start":2.1,"end":2.35,"text":"of","timing":"aligned","utterance":0,"id":7,"confidence":0.98},{"start":2.4,"end":2.65,"text":"Caption","timing":"aligned","utterance":0,"id":8,"confidence":0.98},{"confidence":0.98,"utterance":0,"timing":"aligned","text":"Studio","start":2.7,"end":2.95,"id":9}]}],"posSegments":[],"texts":[{"id":"t1","text":"Hello","x":50,"y":20,"sizePct":4,"future":true}],"cadenceApplied":false,"cadenceFit":null,"cadenceDirty":false,"done":false,"peaks":null,"hasOriginal":true,"originalBytes":37723012}]}"##.utf8)

    func testProjectDecodesAndRoundTrips() throws {
        let decoded = try JSONDecoder().decode(CapProject.self, from: project)
        let clip = try XCTUnwrap(decoded.clips.first)
        XCTAssertEqual(clip.style?.fontFamily, "Montserrat")
        XCTAssertEqual(clip.cues?.first?.text, "Hi, this is a quick test")
        XCTAssertEqual(clip.cues?.first?.lines, [6])

        // what the phone saves: the web's clip fields, the ones it doesn't edit as they came
        let saved = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(clip)) as? [String: Any])
        let original = try XCTUnwrap((JSONSerialization.jsonObject(with: project) as? [String: Any])?["clips"] as? [[String: Any]]).first!
        for key in ["style", "texts", "posSegments", "cues", "originalWords"] {
            XCTAssertEqual(saved[key] as? NSObject, original[key] as? NSObject, key)
        }
        // file facts stay server-side
        XCTAssertNil(saved["hasOriginal"])
        XCTAssertNil(saved["srcWidth"])
    }

    func testStyleEditsKeepTheRest() throws {
        var style = try XCTUnwrap(JSONDecoder().decode(CapProject.self, from: project).clips.first?.style)
        let before = style.values.count
        style.fontSizePct = 4
        style.boxY = 80
        XCTAssertEqual(style.values.count, before)
        XCTAssertEqual(style.values["fontSizePct"], .number(4))
        XCTAssertEqual(style.maxChars(width: 1080, height: 1920), Int((0.685 * 1080) / (0.04 * 1920 * 0.55)))
    }

    /// Lines per caption is the box height against the font size, as the
    /// web's boxCaps reads it; a new size keeps the count.
    func testLinesSetTheBoxHeight() throws {
        var style = try XCTUnwrap(JSONDecoder().decode(CapProject.self, from: project).clips.first?.style)
        XCTAssertEqual(style.lines, 1)   // a box 4.17 high against a 2.5 font
        for n in 1...4 {
            style.lines = n
            XCTAssertEqual(style.lines, n)
            // boxCaps: floor((boxH - 0.24 f) / (1.18 f))
            XCTAssertEqual(Int(((style.boxH - 0.24 * style.fontSizePct) / (1.18 * style.fontSizePct)).rounded(.down)), n)
        }
        style.lines = 2
        style.resize(5)
        XCTAssertEqual(style.fontSizePct, 5)
        XCTAssertEqual(style.lines, 2)
    }

    func testLinesFollowTheLayoutElseWrap() {
        let words = ["one", "two", "three", "four"].enumerated().map { CapWord(id: $0 + 1, text: $1, start: 0, end: 1) }
        var cue = CapCue(id: 1, start: 0, end: 1, words: words, lines: [1, 3])
        XCTAssertEqual(cue.lineWords(maxChars: 40).map(\.count), [1, 3])
        cue.lines = [2]   // stale counts: wrap to the box
        XCTAssertEqual(cue.lineWords(maxChars: 9).map { $0.map(\.text).joined(separator: " ") }, ["one two", "three", "four"])
    }

    func testWavHeader() {
        let header = CaptionAudio.header(bytes: 32000)
        XCTAssertEqual(header.count, 44)
        XCTAssertEqual(String(decoding: header[0..<4], as: UTF8.self), "RIFF")
        XCTAssertEqual(header[24..<28].withUnsafeBytes { $0.loadUnaligned(as: UInt32.self) }, 16000)
    }

    func testRenderStatusDecodesWithUnknownFallback() throws {
        XCTAssertEqual(try JSONDecoder().decode(CaptionEditor.RenderStatus.self, from: Data(#""running""#.utf8)), .running)
        XCTAssertEqual(try JSONDecoder().decode(CaptionEditor.RenderStatus.self, from: Data(#""paused""#.utf8)), .unknown)
    }

    /// A video picked for a project stays on the phone until the server has it, filed under the server it was
    /// picked for: another server's list never touches it.
    func testKeptCopiesStayWithTheirServer() throws {
        let saved = CaptionSources.root
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("kept-\(UUID().uuidString)", isDirectory: true)
        CaptionSources.root = root
        defer {
            CaptionSources.root = saved
            try? FileManager.default.removeItem(at: root)
        }
        func picked(_ name: String) throws -> URL {
            let file = root.appendingPathComponent("picker-\(UUID().uuidString)/\(name)")
            try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data("video".utf8).write(to: file)
            return file
        }
        let home = "tinyacrobatics.example-admin", other = "localhost-3000-local"
        let kept = CaptionSources.keep(try picked("roll.mov"), for: "p1", server: home)
        XCTAssertEqual(kept.lastPathComponent, "roll.mov")
        _ = CaptionSources.keep(try picked("crawl.mov"), for: "p2", server: other)
        XCTAssertEqual(CaptionSources.kept(server: home), ["p1"])
        XCTAssertEqual(CaptionSources.kept(server: other), ["p2"])
        XCTAssertNil(CaptionSources.file(for: "p1", server: other))
        CaptionSources.forget("p1", server: home)
        XCTAssertEqual(CaptionSources.kept(server: home), [])
        XCTAssertEqual(CaptionSources.file(for: "p2", server: other)?.lastPathComponent, "crawl.mov")
    }

    /// Sending the original again sends only the 16 MB parts the server doesn't have whole.
    func testOnlyTheMissingPartsAreSentAgain() {
        let mb = 1024 * 1024
        let total = 40 * mb   // parts of 16, 16 and 8 MB
        XCTAssertEqual(API.partsToSend(total: total, serverPartSize: nil, received: []), [1, 2, 3])
        XCTAssertEqual(API.partsToSend(total: total, serverPartSize: 16 * mb, received: [(1, 16 * mb), (3, 8 * mb)]), [2])
        // a part cut short is sent again
        XCTAssertEqual(API.partsToSend(total: total, serverPartSize: 16 * mb, received: [(1, 16 * mb), (2, 3 * mb)]), [2, 3])
        // parts of another size than the phone cuts: all of it again
        XCTAssertEqual(API.partsToSend(total: total, serverPartSize: 8 * mb, received: [(1, 8 * mb)]), [1, 2, 3])
        XCTAssertEqual(API.partsToSend(total: total, serverPartSize: 16 * mb,
                                       received: [(1, 16 * mb), (2, 16 * mb), (3, 8 * mb)]), [])
    }
}
