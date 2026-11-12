import SwiftUI
import UIKit

/// One block of a reply, as it was written: a paragraph, a heading, a list item, code, a table or a rule.
struct MarkdownBlock: Identifiable, Equatable {
    enum Kind: Equatable {
        case paragraph
        case heading(Int)
        case code
        case rule
        case table
    }

    let id: Int
    var kind: Kind
    var text = AttributedString()
    /// How deep in lists it sits; 0 is in none.
    var depth = 0
    /// What stands in front of a list item's first line: "•", "3.", "☐". Nil on the item's later paragraphs.
    var marker: String?
    var quoted = false
    /// A table's cells, row by row; the first row is its header.
    var rows: [[AttributedString]] = []
}

/// A reply read into its blocks. The reading is the system's own, and as the website draws its replies: lists nest,
/// tables are tables, and a single line end inside a paragraph stays a line end. Only text comes out: a picture keeps
/// its description and loses its address, and HTML is dropped, so nothing in a reply is ever fetched or shown as an address.
enum Markdown {
    static func blocks(_ text: String) -> [MarkdownBlock] {
        let options = AttributedString.MarkdownParsingOptions(
            allowsExtendedAttributes: false, interpretedSyntax: .full, failurePolicy: .returnPartiallyParsedIfPossible)
        guard let whole = try? AttributedString(markdown: text, options: options) else {
            return [MarkdownBlock(id: 0, kind: .paragraph, text: AttributedString(text))]
        }
        var blocks: [MarkdownBlock] = []
        var open: Int?                      // the block being filled, by the reader's own number for it
        var row: Int?                       // in a table: the row being filled
        var started = Set<Int>()            // list items whose marker is already drawn

        for run in whole.runs {
            if let inline = run.inlinePresentationIntent, !inline.isDisjoint(with: [.inlineHTML, .blockHTML]) { continue }
            var piece = AttributedString(whole[run.range])
            // the reader makes a line end inside a paragraph a space; it stays a line end here, as on the website
            if run.inlinePresentationIntent?.contains(.softBreak) == true { piece = AttributedString("\n") }
            piece.imageURL = nil
            piece.presentationIntent = nil
            let parts = run.presentationIntent?.components ?? []

            if let table = parts.first(where: { if case .table = $0.kind { true } else { false } }) {
                if open != table.identity {
                    open = table.identity
                    row = nil
                    blocks.append(MarkdownBlock(id: blocks.count, kind: .table))
                }
                var column = 0
                for part in parts {
                    switch part.kind {
                    case .tableHeaderRow, .tableRow:
                        if row != part.identity { row = part.identity; blocks[blocks.count - 1].rows.append([]) }
                    case .tableCell(let index):
                        column = index
                    default: break
                    }
                }
                guard !blocks[blocks.count - 1].rows.isEmpty else { continue }
                let last = blocks[blocks.count - 1].rows.count - 1
                // an empty cell has no text of its own: the ones before this one are filled in
                while blocks[blocks.count - 1].rows[last].count <= column { blocks[blocks.count - 1].rows[last].append(AttributedString()) }
                blocks[blocks.count - 1].rows[last][column].append(piece)
                continue
            }

            let inner = parts.first
            // text the reader gave no block: it carries on the paragraph before it, or starts one
            let key = inner?.identity ?? (open.flatMap { $0 < 0 ? $0 : nil } ?? -(blocks.count + 1))
            if open != key {
                open = key
                var block = MarkdownBlock(id: blocks.count, kind: .paragraph)
                switch inner?.kind {
                case .header(let level): block.kind = .heading(level)
                case .codeBlock: block.kind = .code
                case .thematicBreak: block.kind = .rule
                default: break
                }
                let lists = parts.filter { $0.kind == .orderedList || $0.kind == .unorderedList }
                block.depth = lists.count
                block.quoted = parts.contains { $0.kind == .blockQuote }
                for part in parts {
                    guard case .listItem(let ordinal) = part.kind else { continue }
                    if started.insert(part.identity).inserted { block.marker = lists.first?.kind == .orderedList ? "\(ordinal)." : "•" }
                    break   // the innermost item only: an item under another draws its own marker
                }
                blocks.append(block)
            }
            if blocks[blocks.count - 1].kind != .rule { blocks[blocks.count - 1].text.append(piece) }
        }

        for index in blocks.indices {
            let characters = String(blocks[index].text.characters)
            if blocks[index].kind == .code, characters.hasSuffix("\n") {
                blocks[index].text.removeSubrange(blocks[index].text.index(beforeCharacter: blocks[index].text.endIndex)..<blocks[index].text.endIndex)
            }
            // "- [ ] " and "- [x] ": a box in place of the dot
            guard blocks[index].marker == "•", let box = ["[ ] ": "☐", "[x] ": "☑", "[X] ": "☑"].first(where: { characters.hasPrefix($0.key) }) else { continue }
            blocks[index].marker = box.value
            let text = blocks[index].text
            blocks[index].text.removeSubrange(text.startIndex..<text.index(text.startIndex, offsetByCharacters: 4))
        }
        return blocks
    }

    /// A reply's words on one line, with none of its marks: a chat row's second line.
    static func plain(_ text: String) -> String {
        blocks(text).map { String($0.text.characters) }.filter { !$0.isEmpty }.joined(separator: " ").replacingOccurrences(of: "\n", with: " ")
    }

    /// The space above a block. Items of one list sit close, a list sits close under the line that
    /// introduces it, and a heading has air above it and little below.
    static func gap(above block: MarkdownBlock, under previous: MarkdownBlock) -> CGFloat {
        if case .heading = block.kind { return 20 }
        if case .heading = previous.kind { return 8 }
        if block.depth > 0 { return previous.depth > 0 ? 7 : 9 }
        return 14
    }

    private final class Read { let blocks: [MarkdownBlock]; init(_ blocks: [MarkdownBlock]) { self.blocks = blocks } }
    private static let cache: NSCache<NSString, Read> = {
        let cache = NSCache<NSString, Read>()
        cache.countLimit = 200
        return cache
    }()

    /// The same text is read once: a chat redraws far more often than its replies change.
    static func cached(_ text: String) -> [MarkdownBlock] {
        if let read = cache.object(forKey: text as NSString) { return read.blocks }
        let blocks = blocks(text)
        cache.setObject(Read(blocks), forKey: text as NSString)
        return blocks
    }
}

/// What the AI wrote, across the width with no bubble, laid out as it was written: paragraphs with air between them,
/// lists whose lines hang under their own text and step in when nested, headings, tables, code, quotes and rules.
/// A link to a page of the website opens the app's own screen for it. The size follows the font set around it.
struct MarkdownText: View {
    let text: String
    @Environment(\.font) private var font

    var body: some View {
        let blocks = Markdown.cached(text)
        let base = font ?? .callout
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                MarkdownBlockView(block: block, base: base)
                    .padding(.top, index == 0 ? 0 : Markdown.gap(above: block, under: blocks[index - 1]))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
        .environment(\.openURL, OpenURLAction { url in
            Task { @MainActor in AppNavigator.shared.open(href: url.absoluteString) }
            return .handled
        })
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock
    let base: Font
    @ScaledMetric(relativeTo: .title3) private var h1: CGFloat = 21
    @ScaledMetric(relativeTo: .headline) private var h2: CGFloat = 19
    @ScaledMetric(relativeTo: .headline) private var h3: CGFloat = 17
    /// How far a list's text stands in from its marker, and a nested list from the one around it. It grows with the text size.
    @ScaledMetric(relativeTo: .callout) private var step: CGFloat = 20
    /// The air between the lines of running text: with it a 16 point line is 23 points tall.
    private static let leading: CGFloat = 4

    var body: some View {
        if block.quoted {
            HStack(spacing: 12) {
                RoundedRectangle(cornerRadius: 1).fill(.tertiary).frame(width: 2)
                content
            }
            .fixedSize(horizontal: false, vertical: true)
            .foregroundStyle(.secondary)
        } else {
            content
        }
    }

    @ViewBuilder private var content: some View {
        switch block.kind {
        case .rule:
            Divider().padding(.vertical, 2)
        case .code:
            Text(block.text)
                .font(.footnote.monospaced())
                .lineSpacing(2)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 8))
                .padding(.leading, CGFloat(block.depth) * step)
        case .table:
            MarkdownTable(rows: block.rows, base: base)
                .padding(.leading, CGFloat(block.depth) * step)
        case .heading(let level):
            Text(block.text)
                .font(level == 1 ? .system(size: h1, weight: .bold) : level == 2 ? .system(size: h2, weight: .bold) : level == 3 ? .system(size: h3, weight: .bold) : base.weight(.bold))
                .frame(maxWidth: .infinity, alignment: .leading)
        case .paragraph:
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                if block.depth > 0 {
                    Text(block.marker ?? "")
                        .font(block.marker == "•" ? base.weight(.heavy) : base)
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                        .fixedSize()
                        .padding(.trailing, 6)   // a wide number never touches its text
                        .frame(minWidth: step, alignment: .leading)
                        .accessibilityHidden(block.marker == nil)
                }
                Text(block.text)
                    .font(base)
                    .lineSpacing(Self.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.leading, CGFloat(max(0, block.depth - 1)) * step)
        }
    }
}

/// A table with its lines. It is as wide as its words need; when that is wider than the screen its cells wrap
/// sooner, and a table that still does not fit scrolls sideways instead of squeezing its columns.
private struct MarkdownTable: View {
    let rows: [[AttributedString]]
    let base: Font
    @Environment(\.displayScale) private var scale

    var body: some View {
        // the widest columns that fit the screen; cells wrap sooner at each step down
        ViewThatFits(in: .horizontal) {
            grid(cap: 260)
            grid(cap: 190)
            grid(cap: 150)
            grid(cap: 125)
            grid(cap: 105)
            ScrollView(.horizontal, showsIndicators: false) { grid(cap: 180) }
        }
    }

    /// Each column as wide as its longest cell, up to `cap`: past that the cell wraps.
    private func widths(cap: CGFloat) -> [CGFloat] {
        // measured in the heavier weight, so a bold word never wraps where it was counted as fitting
        let size = UIFont.preferredFont(forTextStyle: .callout).pointSize
        let font = UIFont.systemFont(ofSize: size, weight: .semibold)
        let columns = rows.map(\.count).max() ?? 0
        return (0..<columns).map { column in
            let widest = rows.map { row in
                column < row.count ? (String(row[column].characters) as NSString).size(withAttributes: [.font: font]).width : 0
            }.max() ?? 0
            return min(cap, max(24, widest.rounded(.up) + 2))
        }
    }

    private func grid(cap: CGFloat) -> some View {
        let widths = widths(cap: cap)
        let line = Color(.separator)
        let hair = 1 / max(1, scale)
        return Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Rectangle().fill(line).frame(height: hair).gridCellUnsizedAxes(.horizontal) }
                GridRow {
                    ForEach(Array(widths.enumerated()), id: \.offset) { column, width in
                        Text(column < row.count ? row[column] : AttributedString())
                            .font(index == 0 ? base.weight(.semibold) : base)
                            .lineSpacing(3)
                            .frame(width: width, alignment: .leading)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 7)
                            .frame(maxHeight: .infinity, alignment: .topLeading)
                            .overlay(alignment: .leading) { if column > 0 { Rectangle().fill(line).frame(width: hair) } }
                    }
                }
                .background(index == 0 ? Color(.secondarySystemBackground) : Color.clear)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(line, lineWidth: hair))
    }
}

#if DEBUG
extension AssistantFixtures {
    private static let lists = """
        I checked your Instagram and Finals, and you're right. None of the 11 I cleared is a version you posted. They're all earlier drafts, so clearing them was the right call.

        - **Hanging basics:** You posted Hanging basics V4 on Oct 26 ([reel](/review/r1), 2,886 plays). V3A, V3B and V3C are older versions.
        - **Rolling cues:**
          - On Oct 10 you posted V1A, V1B, V1D, V1E and V1F as trial reels. V1B won with 28,068 plays and went on your grid on Oct 11.
          - The drafts in Review are from Oct 9, the day before your final cuts.
          - V1C, V1G and V1H were never posted.
        - **Tummy time:** You posted V1B as a trial reel on Oct 2 (16,163 plays). It's already marked approved in Review.

        Two other things are still stuck in the same way, if you want them tidied:
        - **Hanging basics V2A and V2B** are still "In progress" in Review. They're also older than V4.
        - [Sleep routine](/workshop/sessions/s1) looks like the Workshop session for this video, and it's marked shelved even though the video is out.
        """
    private static let rest = """


        ## What I would do next

        1. Mark the session published and link the V1B reel to it.
        2. Leave V2A and V2B where they are.

        | Video | Posted | Plays |
        |---|---|---|
        | Hanging basics V4 | Oct 26 | 2,886 |
        | Rolling cues V1B | Oct 11 | 24,869 |
        | Tummy time V1B | Oct 2, as a trial reel | 16,163 |

        > A trial reel only reaches people who don't follow you.

        ```
        ffprobe -v error -show_format clip.mov
        ```

        Should I do one or both?
        """

    private static func chat(_ reply: String, more: Bool) -> String {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        var messages: [[String: Any]] = [
            ["id": "m1", "role": "user", "text": "Did I clear anything I had posted?", "at": now - 60_000],
            ["id": "m2", "role": "assistant", "text": reply, "at": now - 30_000, "status": "done",
             "steps": ["Looking at your Instagram posts", "Looking through Finals", "Looking through Review"]],
        ]
        if more {
            messages += [
                ["id": "m3", "role": "user", "text": "Leave them", "at": now - 20_000],
                ["id": "m4", "role": "assistant", "text": "OK, I won't touch Hanging basics V2A and V2B or the Sleep routine session.", "at": now - 10_000, "status": "done"],
            ]
        }
        let view: [String: Any] = [
            "id": "c-long", "provider": "claude", "aiName": "Claude Code", "tools": true, "past": [],
            "pending": NSNull(), "navigate": NSNull(), "messages": messages,
        ]
        return String(data: (try? JSONSerialization.data(withJSONObject: view)) ?? Data(), encoding: .utf8) ?? ""
    }

    /// `-AssistantFixture long`: a long answer with every kind of block, to look at how a reply reads.
    static let longReply = chat(lists + rest, more: true)
    /// `-AssistantFixture lists`: its first half alone (the screen opens on the end of a chat).
    static let listsReply = chat(lists, more: false)
}
#endif
