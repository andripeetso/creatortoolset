import XCTest
@testable import CreatorToolset

final class MarkdownTests: XCTestCase {
    /// Every word a reply's blocks would draw, cells included.
    static func words(_ blocks: [MarkdownBlock]) -> String {
        blocks.map { block in
            ([String(block.text.characters)] + block.rows.flatMap { $0.map { String($0.characters) } }).joined(separator: " ")
        }.joined(separator: "\n")
    }

    private func line(_ block: MarkdownBlock) -> String {
        "\(block.depth)|\(block.marker ?? "-")|\(String(block.text.characters))"
    }

    func testAListKeepsItsItemsItsNestingAndTheLineThatIntroducesIt() {
        let blocks = Markdown.blocks("""
        None of the 11 is posted.
        They are all drafts.

        - **Hanging basics:** posted on Oct 26.
        - **Rolling cues:**
          - On Oct 10 you posted V1A.
          - V1C was never posted.
        - **Tummy time:** done.

        Two other things are stuck:
        - one
        - two
        """)
        XCTAssertEqual(blocks.map(line), [
            "0|-|None of the 11 is posted.\nThey are all drafts.",  // one line end inside a paragraph stays a line end
            "1|•|Hanging basics: posted on Oct 26.",
            "1|•|Rolling cues:",
            "2|•|On Oct 10 you posted V1A.",
            "2|•|V1C was never posted.",
            "1|•|Tummy time: done.",
            "0|-|Two other things are stuck:",                      // a list right under a line, no empty line between
            "1|•|one",
            "1|•|two",
        ])
        // a list sits close under the line that introduces it, its items closer still
        XCTAssertLessThan(Markdown.gap(above: blocks[7], under: blocks[6]), Markdown.gap(above: blocks[6], under: blocks[5]))
        XCTAssertLessThan(Markdown.gap(above: blocks[8], under: blocks[7]), Markdown.gap(above: blocks[7], under: blocks[6]))
    }

    func testNumbersBoxesHeadingsQuotesRulesAndCode() {
        let blocks = Markdown.blocks("""
        ## Next
        3. third

           still the third
        4. fourth

        - [ ] open
        - [x] done

        ---

        > quoted

        ```swift
        let a = 1
        ```
        """)
        XCTAssertEqual(blocks.map(\.kind), [.heading(2), .paragraph, .paragraph, .paragraph, .paragraph, .paragraph, .rule, .paragraph, .code])
        XCTAssertEqual(blocks.map(line), [
            "0|-|Next", "1|3.|third", "1|-|still the third", "1|4.|fourth", "1|☐|open", "1|☑|done", "0|-|", "0|-|quoted", "0|-|let a = 1",
        ])
        XCTAssertEqual(blocks.map(\.quoted), [false, false, false, false, false, false, false, true, false])
    }

    func testATableKeepsItsRowsAndAnEmptyCellItsPlace() {
        let blocks = Markdown.blocks("""
        Before.

        | Video | Posted | Plays |
        |---|---|---|
        | **Hanging basics** |  | 2,886 |
        | [Rolling cues](/review/r9?v=2) | Oct 11 | 24,869 |

        After.
        """)
        XCTAssertEqual(blocks.map(\.kind), [.paragraph, .table, .paragraph])
        XCTAssertEqual(blocks[1].rows.map { $0.map { String($0.characters) } }, [
            ["Video", "Posted", "Plays"],
            ["Hanging basics", "", "2,886"],
            ["Rolling cues", "Oct 11", "24,869"],
        ])
        // a link in a cell keeps its path: it opens the app's own screen
        XCTAssertEqual(blocks[1].rows[2][0].runs.compactMap(\.link).first?.absoluteString, "/review/r9?v=2")
    }

    func testOnlyWordsComeOutOfAReply() {
        let blocks = Markdown.blocks("""
        Open [the cut](/review/r9?v=2). Look ![shot](https://elsewhere.example.test/p.png?x=secret) here <img src="https://elsewhere.example.test/a.png"> end.

        <div><img src="https://elsewhere.example.test/b.png"></div>
        """)
        let words = Self.words(blocks)
        XCTAssertFalse(words.contains("elsewhere"))
        // names with underscores are names, not slanted text; a chat row's line is one line
        XCTAssertEqual(Markdown.plain("You posted Clip_V4_FINAL.\nV1B_D28 is older."), "You posted Clip_V4_FINAL. V1B_D28 is older.")
        XCTAssertTrue(words.contains("shot"))   // a picture keeps its description
        let runs = blocks.flatMap { $0.text.runs.map { $0 } }
        XCTAssertEqual(runs.compactMap(\.link).map(\.absoluteString), ["/review/r9?v=2"])
        XCTAssertTrue(runs.allSatisfy { $0.imageURL == nil })
    }

    #if DEBUG
    /// A reply is drawn while it is being written: every beginning of it must read, and one that ends on a word must show.
    func testEveryBeginningOfAReplyReads() throws {
        let view = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(AssistantFixtures.longReply.utf8)) as? [String: Any])
        let reply = try XCTUnwrap((view["messages"] as? [[String: Any]])?[1]["text"] as? String)
        var kinds = Set<String>()
        for end in reply.indices {
            let beginning = String(reply[..<end])
            let blocks = Markdown.blocks(beginning)
            if beginning.last?.isLetter == true { XCTAssertFalse(blocks.isEmpty, "nothing drawn for: …\(beginning.suffix(20))") }
            for block in blocks { kinds.insert("\(block.kind)".components(separatedBy: "(")[0]) }
        }
        XCTAssertEqual(kinds, ["paragraph", "heading", "code", "table"])
        XCTAssertEqual(Markdown.cached(reply), Markdown.blocks(reply))
    }
    #endif
}
