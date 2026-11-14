// Splitting a still picture into what a design is made of, for the server (api/lib/cutouts.ts, SPLIT_KIND). It takes the
// cut-out's road (Cutout.swift): claimed the same way, then with the device token
//   GET  /api/devices/relay/cutout/:id        the picture (PNG, JPEG or HEIC)
//   POST /api/devices/relay/cutout/:id        multipart `layout` (JSON), `background` (PNG), `piece0`, `piece1`… (PNG)
//   or   /api/devices/relay/cutout/:id/fail   { error } with a reason a person can read
// The words are read with the text reader macOS has built in, each line with where it lies, its colour and how much of
// its box its letters cover; the letters are painted over from what is around them. Then each thing that stands out is
// cut out (the foreground mask the cut-out uses) and painted over too. What is left is the background. No model is
// fetched, and no request goes anywhere but the server.
import CoreImage
import Foundation
import Vision

/// The step kind this Mac lists for a split (contracts/devices.ts SPLIT_KIND).
let splitKind = "split"

enum Split {
    /// A picture is split at this size on its long side: more than a slide shows, and quick to read and paint.
    static let maxSide = 2048
    /// A piece smaller than this part of the picture is a speck, and one bigger than this is the picture itself.
    static let pieceArea = (least: 0.003, most: 0.9)
    static let maxPieces = 12
    /// The most lines a split sends (the server's cap): a picture full of small print keeps its biggest ones.
    static let maxLines = 60

    struct Line: Equatable {
        let text: String
        /// in the picture's pixels, from its top left
        let box: CGRect
        let color: String
        let ink: Double
    }
    struct Made {
        let lines: [Line]
        let pieces: [(box: CGRect, png: Data)]
        let background: Data
        let width: Int, height: Int

        /// The layout the server reads: every box as fractions of the picture.
        func layout() throws -> Data {
            let w = Double(width), h = Double(height)
            let box = { (r: CGRect) -> [String: Any] in ["x": r.minX / w, "y": r.minY / h, "w": r.width / w, "h": r.height / h] }
            let json: [String: Any] = [
                "lines": lines.map { l in box(l.box).merging(["text": l.text, "color": l.color, "ink": l.ink]) { a, _ in a } },
                "pieces": pieces.map { box($0.box) },
            ]
            return try JSONSerialization.data(withJSONObject: json)
        }
    }

    static func run(_ picture: Data) throws -> Made {
        let image = try Cutout.upright(picture, maxSide: maxSide)
        var px = Bitmap(image)
        let read = VNRecognizeTextRequest()
        read.recognitionLevel = .accurate
        read.usesLanguageCorrection = true
        read.automaticallyDetectsLanguage = true
        try VNImageRequestHandler(cgImage: image).perform([read])
        var letters = [Bool](repeating: false, count: px.width * px.height)
        var lines: [Line] = []
        for o in read.results ?? [] {
            guard let text = o.topCandidates(1).first?.string.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { continue }
            let b = o.boundingBox
            // inside the picture: a box the reader lets run over its edge would be no box at all to the server
            let box = CGRect(x: b.minX * Double(px.width), y: (1 - b.maxY) * Double(px.height), width: b.width * Double(px.width), height: b.height * Double(px.height)).integral
                .intersection(CGRect(x: 0, y: 0, width: px.width, height: px.height))
            guard !box.isEmpty, box.width >= 1, box.height >= 1 else { continue }
            if let line = px.letters(text, in: box, marking: &letters) { lines.append(line) }
        }
        if lines.count > maxLines {
            let biggest = Set(lines.indices.sorted { lines[$0].box.width * lines[$0].box.height > lines[$1].box.width * lines[$1].box.height }.prefix(maxLines))
            lines = lines.indices.filter(biggest.contains).map { lines[$0] }
        }
        px.paint(over: grown(letters, px.width, px.height, by: 2))
        // the pieces, from the picture with its words painted over: a word over a photo is not part of what is cut out
        let clean = px.image()
        let handler = VNImageRequestHandler(cgImage: clean)
        let stands = VNGenerateForegroundInstanceMaskRequest()
        try handler.perform([stands])
        var pieces: [(box: CGRect, png: Data)] = []
        var under = [Bool](repeating: false, count: px.width * px.height)
        if let found = stands.results?.first {
            let ci = CIContext()
            for one in found.allInstances.sorted() {
                let buffer = try found.generateMaskedImage(ofInstances: [one], from: handler, croppedToInstancesExtent: false)
                let masked = CIImage(cvPixelBuffer: buffer)
                guard let cut = ci.createCGImage(masked, from: masked.extent) else { continue }
                let alpha = Bitmap(cut)
                var box: (x0: Int, y0: Int, x1: Int, y1: Int) = (alpha.width, alpha.height, -1, -1)
                var area = 0
                var mine = [Bool](repeating: false, count: px.width * px.height)
                for y in 0..<min(alpha.height, px.height) {
                    for x in 0..<min(alpha.width, px.width) where alpha.alpha(x, y) > 8 {
                        area += 1
                        mine[y * px.width + x] = true
                        box = (min(box.x0, x), min(box.y0, y), max(box.x1, x), max(box.y1, y))
                    }
                }
                let share = Double(area) / Double(px.width * px.height)
                guard share >= pieceArea.least, share <= pieceArea.most, pieces.count < maxPieces else { continue }
                let r = CGRect(x: box.x0, y: box.y0, width: box.x1 - box.x0 + 1, height: box.y1 - box.y0 + 1)
                guard let crop = cut.cropping(to: r) else { continue }
                pieces.append((r, try Cutout.encoded(crop)))
                for i in mine.indices where mine[i] { under[i] = true }
            }
        }
        px.paint(over: grown(under, px.width, px.height, by: 3))
        return Made(lines: lines, pieces: pieces, background: try Cutout.encoded(px.image()), width: px.width, height: px.height)
    }

    /// `mask` with every marked pixel's neighbours `by` pixels round marked too (a letter's soft edge, a piece's).
    static func grown(_ mask: [Bool], _ w: Int, _ h: Int, by: Int) -> [Bool] {
        var across = mask
        for y in 0..<h {
            for x in 0..<w where mask[y * w + x] { for d in max(0, x - by)...min(w - 1, x + by) { across[y * w + d] = true } }
        }
        var out = across
        for y in 0..<h {
            for x in 0..<w where across[y * w + x] { for d in max(0, y - by)...min(h - 1, y + by) { out[d * w + x] = true } }
        }
        return out
    }
}

/// A picture's pixels as RGBA, 8 bits each (alpha premultiplied, as Core Graphics keeps them), from its top left.
struct Bitmap {
    let width: Int, height: Int
    var bytes: [UInt8]

    init(_ image: CGImage) {
        width = image.width
        height = image.height
        bytes = [UInt8](repeating: 0, count: width * height * 4)
        let ctx = CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    }

    func alpha(_ x: Int, _ y: Int) -> UInt8 { bytes[(y * width + x) * 4 + 3] }
    func rgb(_ x: Int, _ y: Int) -> (Double, Double, Double) {
        let i = (y * width + x) * 4
        return (Double(bytes[i]), Double(bytes[i + 1]), Double(bytes[i + 2]))
    }

    func image() -> CGImage {
        var copy = bytes
        let ctx = CGContext(data: &copy, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        return ctx.makeImage()!
    }

    /**
     * A line's letters: the ground is what lies round its box (the middle of each colour there), the ink what in the box
     * is furthest from it; a pixel nearer the ink than the ground is a letter, and is marked in `letters`. Nil when
     * nothing in the box stands apart from the ground (no letters to be seen).
     */
    func letters(_ text: String, in box: CGRect, marking letters: inout [Bool]) -> Split.Line? {
        let pad = max(2, Int(box.height * 0.15))
        let x0 = max(0, Int(box.minX) - pad / 3), x1 = min(width - 1, Int(box.maxX) + pad / 3)
        let y0 = max(0, Int(box.minY) - pad), y1 = min(height - 1, Int(box.maxY) + pad)
        guard x0 < x1, y0 < y1 else { return nil }
        var ring: [(Double, Double, Double)] = []
        for y in max(0, y0 - 4)...min(height - 1, y1 + 4) {
            for x in max(0, x0 - 4)...min(width - 1, x1 + 4) where x < x0 || x > x1 || y < y0 || y > y1 { ring.append(rgb(x, y)) }
        }
        guard !ring.isEmpty else { return nil }
        let ground = middle(ring)
        let gap = { (a: (Double, Double, Double), b: (Double, Double, Double)) in ((a.0 - b.0) * (a.0 - b.0) + (a.1 - b.1) * (a.1 - b.1) + (a.2 - b.2) * (a.2 - b.2)).squareRoot() }
        var inside: [((Double, Double, Double), Double)] = []
        for y in y0...y1 { for x in x0...x1 { let c = rgb(x, y); inside.append((c, gap(c, ground))) } }
        let furthest = inside.map(\.1).max() ?? 0
        guard furthest > 60 else { return nil }
        let ink = middle(inside.filter { $0.1 > max(60, furthest * 0.6) }.map(\.0))
        var count = 0
        for y in y0...y1 {
            for x in x0...x1 where gap(rgb(x, y), ink) < gap(rgb(x, y), ground) {
                letters[y * width + x] = true
                if box.contains(CGPoint(x: x, y: y)) { count += 1 }
            }
        }
        let hex = String(format: "#%02x%02x%02x", Int(ink.0.rounded()), Int(ink.1.rounded()), Int(ink.2.rounded()))
        return Split.Line(text: text, box: box, color: hex, ink: min(1, Double(count) / max(1, Double(box.width * box.height))))
    }

    /// The middle of each channel of these colours (a median: a few odd pixels do not move it).
    private func middle(_ colours: [(Double, Double, Double)]) -> (Double, Double, Double) {
        let m = { (v: [Double]) in v.sorted()[v.count / 2] }
        return (m(colours.map(\.0)), m(colours.map(\.1)), m(colours.map(\.2)))
    }

    /**
     * Every marked pixel painted from what is round it: across its row between the unmarked pixels each side, and down
     * its column the same way, the two put together. A flat or graded ground comes out as it was; a photo comes out
     * smooth where the letters were.
     * ponytail: a straight blend, not a painting model; behind a big piece on a photo it shows. A model on the Mac if that matters.
     */
    mutating func paint(over mask: [Bool]) {
        guard mask.contains(true) else { return }
        let rows = blended(mask, along: true), cols = blended(mask, along: false)
        for i in mask.indices where mask[i] {
            for c in 0..<4 { bytes[i * 4 + c] = UInt8(((Double(rows[i * 4 + c]) + Double(cols[i * 4 + c])) / 2).rounded()) }
        }
    }

    /// The pixels with each run of marked ones blended between its two ends, along rows (or columns).
    private func blended(_ mask: [Bool], along rows: Bool) -> [UInt8] {
        var out = bytes
        let (lines, length) = rows ? (height, width) : (width, height)
        let at = { (line: Int, k: Int) in rows ? line * width + k : k * width + line }
        for line in 0..<lines {
            var k = 0
            while k < length {
                guard mask[at(line, k)] else { k += 1; continue }
                let start = k
                while k < length && mask[at(line, k)] { k += 1 }
                let before = start > 0 ? at(line, start - 1) : nil, after = k < length ? at(line, k) : nil
                for j in start..<k {
                    let t = Double(j - start + 1) / Double(k - start + 1)
                    for c in 0..<4 {
                        let a: Double? = before.map { Double(bytes[$0 * 4 + c]) }
                        let b: Double? = after.map { Double(bytes[$0 * 4 + c]) }
                        var v = Double(bytes[at(line, j) * 4 + c])
                        if let a, let b { v = a * (1 - t) + b * t } else if let one = a ?? b { v = one }
                        out[at(line, j) * 4 + c] = UInt8(v.rounded())
                    }
                }
            }
        }
        return out
    }
}

/// One split step, from reading the picture to sending what it was split into or why not. Runs on the caller's thread.
struct SplitJob {
    let api: DeviceAPI
    let id: Int

    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/cutout/\(id)"
        let why: String
        do {
            let picture = try api.get(base, tries: 2)
            if picture.status == 401 { return (.gone, false) }
            guard picture.status == 200 else { throw Cutout.Refused(why: "The picture could not be read from the server (HTTP \(picture.status)).") }
            let made = try Split.run(picture.data)
            let parts = [FormPart(name: "layout", filename: "layout.json", type: "application/json", data: try made.layout()),
                         FormPart(name: "background", filename: "background.png", type: "image/png", data: made.background)]
                + made.pieces.enumerated().map { FormPart(name: "piece\($0.offset)", filename: "piece\($0.offset).png", type: "image/png", data: $0.element.png) }
            guard parts.reduce(0, { $0 + $1.data.count }) <= Cutout.maxResult else { throw Cutout.Refused(why: "The split is over \(Cutout.maxResult / 1_000_000) MB.") }
            let reply = try api.upload(base, parts, tries: 3)
            return reply.status == 200 ? (.done, RelayRunner.editorWaits(reply.data)) : (.gone, false)
        } catch let refused as Cutout.Refused {
            why = refused.why
        } catch {
            why = "The picture could not be split on this Mac: \(error.localizedDescription)."
        }
        let reply = try? api.call("POST", "\(base)/fail", ["error": String(why.prefix(500))], tries: 4)
        return (.failed(why), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }
}
