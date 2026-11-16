// Shot descriptions of a file kept on this Mac (LibraryLookJob.swift): its picture read the way the server reads one
// (apps/captions/api/library/look.ts readPicture), and the sheets the server's look makes of it (look.ts stretchSheet,
// shots.ts sheetHashes), with the same ffmpeg commands. LibraryLookTests.swift checks both against the server's own
// numbers on one clip.
import AVFoundation
import CoreVideo
import Foundation

/// A file's picture as the three numbers a frame the server finds stretches from (contracts/library.ts PictureSignal).
enum LookPicture {
    /// Frames are read this small and grey (look.ts FW, FH), at the file's own rate up to `maxRate` (MAX_READ_FPS).
    static let width = 64
    static let height = 36
    static let maxRate = 30.0
    /// look.ts LAG_S and SPREAD_FLOOR
    static let lagSeconds = 0.5
    static let spreadFloor = 0.02

    /// look.ts readPicture's numbers, frame by frame: the change from the frame before, the same over the two frames'
    /// contrast (what a cut is read on), and the change from `lagSeconds` before.
    struct Signal {
        let fps: Double
        private(set) var step: [Double] = []
        private(set) var cut: [Double] = []
        private(set) var lag: [Double] = []
        private let back: Int
        private var ring: [[UInt8]] = []
        private var spreadBefore = 0.0

        init(fps: Double) {
            self.fps = fps
            back = max(1, Int((lagSeconds * fps).rounded()))
        }

        /// The next grey frame, `width` × `height`.
        mutating func add(_ f: [UInt8]) {
            let prev = ring.last
            let d = prev.map { Self.diff(f, $0) } ?? 0
            let sp = Self.spread(f)
            step.append(d)
            cut.append(prev == nil ? 0 : d / max(spreadFloor, (sp + spreadBefore) / 2))
            spreadBefore = sp
            lag.append(ring.count > back ? Self.diff(f, ring[ring.count - 1 - back]) : 0)
            ring.append(f)
            if ring.count > back + 1 { ring.removeFirst() }
        }

        static func diff(_ x: [UInt8], _ y: [UInt8]) -> Double {
            var s = 0
            for i in x.indices { s += abs(Int(x[i]) - Int(y[i])) }
            return Double(s) / Double(x.count) / 255
        }

        static func spread(_ x: [UInt8]) -> Double {
            var s = 0.0, q = 0.0
            for v in x { s += Double(v); q += Double(v) * Double(v) }
            let n = Double(x.count)
            return max(0, q / n - (s / n) * (s / n)).squareRoot() / 255
        }

        /// The body the server takes, each number to six places.
        var body: [String: Any] {
            func r6(_ xs: [Double]) -> [Double] { xs.map { ($0 * 1e6).rounded() / 1e6 } }
            return ["fps": fps, "step": r6(step), "cut": r6(cut), "lag": r6(lag)]
        }
    }

    /// A video file opened for its picture: the rate it is read at, the cell size, which way up it is, and how long it
    /// is (the video's own end, which is where the server's ffmpeg stops).
    struct Opened: @unchecked Sendable {
        let fps: Double
        let k: Int
        let landscape: Bool
        let duration: Double
        let end: Double
        let reader: FrameReader?
    }

    /// `url` opened; `reading`: with its frames ready to read (`read`).
    static func open(_ url: URL, reading: Bool) async throws -> Opened {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw MediaError.noVideoTrack }
        let (rate, natural, turn, range) = try await track.load(.nominalFrameRate, .naturalSize, .preferredTransform, .timeRange)
        let duration = try await asset.load(.duration).seconds
        let upright = natural.applying(turn)
        let (w, h) = (abs(upright.width), abs(upright.height))
        // each cell is the mean of k×k pixels of a frame drawn k times its size: ffmpeg's area scaling, near enough
        let k = max(1, min(8, Int(w) / width, Int(h) / height))
        let end = range.end.seconds.isFinite ? range.end.seconds : duration
        let reader = reading
            ? try await FrameReader(asset: asset, range: 0...max(0.001, end), longSide: 0,
                                    exact: CGSize(width: width * k, height: height * k), pixelFormat: kCVPixelFormatType_32BGRA)
            : nil
        return Opened(fps: Double(rate) > 0 ? min(Double(rate), maxRate) : 25, k: k, landscape: w >= h,
                      duration: duration.isFinite ? duration : end, end: end, reader: reader)
    }

    /// Every frame of `o` at its rate, picked the way ffmpeg's fps filter picks them (each tick gets the newest frame
    /// whose time rounds to it or before; the last stays until the video's end), as a Signal. `beat` runs between
    /// frames and stops the read by throwing.
    static func read(_ o: Opened, beat: () throws -> Void) throws -> Signal {
        guard let reader = o.reader else { throw MediaError.unreadable }
        defer { reader.cancel() }
        var signal = Signal(fps: o.fps)
        var tick: Int?
        var held: [UInt8]?
        while let frame = try reader.next() {
            try beat()
            let at = Int((frame.time * o.fps).rounded())
            if let h = held, var t = tick {
                while t < at { signal.add(h); t += 1 }
                tick = t
            }
            if tick == nil { tick = at }
            held = grey(frame.buffer, k: o.k)
        }
        if let held, var t = tick {
            let last = max(Int((o.end * o.fps).rounded()), signal.step.isEmpty ? t + 1 : t)
            while t < last { signal.add(held); t += 1 }
        }
        return signal
    }

    /// A BGRA frame `width`·k × `height`·k as grey: each cell the mean of its k×k pixels, each colour rounded, then
    /// BT.601 luma rounded (look.ts grey, after ffmpeg scales to 64×36 RGB).
    static func grey(_ buffer: CVPixelBuffer, k: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: width * height)
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self),
              CVPixelBufferGetWidth(buffer) >= width * k, CVPixelBufferGetHeight(buffer) >= height * k else { return out }
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        let n = Double(k * k)
        for cy in 0..<height {
            for cx in 0..<width {
                var r = 0, g = 0, b = 0
                for y in cy * k..<(cy + 1) * k {
                    let row = base + y * stride + cx * k * 4
                    for x in 0..<k {
                        b += Int(row[x * 4])
                        g += Int(row[x * 4 + 1])
                        r += Int(row[x * 4 + 2])
                    }
                }
                let luma = 0.299 * (Double(r) / n).rounded() + 0.587 * (Double(g) / n).rounded() + 0.114 * (Double(b) / n).rounded()
                out[cy * width + cx] = UInt8(min(255, luma.rounded()))
            }
        }
        return out
    }
}

/// The sheets the server's look sends its AI (look.ts stretchSheet: STRETCH_FRAMES frames a stretch side by side,
/// SHEET_STRETCHES stretches a sheet) and each stretch's picture hash (shots.ts sheetHashes), made with ffmpeg as there.
enum LookSheets {
    static let frames = 3
    static let inset = 0.25
    static let frameW = 256
    static let frameH = 144
    static let perSheet = 16
    /// shots.ts SHEET_FORMAT: the server refuses sheets of another
    static let format = "\(frames)x\(perSheet)"

    static func cols(_ landscape: Bool) -> Int { landscape ? 2 : 3 }

    /// The frames a stretch's tile shows (look.ts stretchTimes): its start and end a little inside it, and its middle.
    static func times(_ a: Double, _ b: Double, duration: Double) -> [Double] {
        let inset = min(Self.inset, (b - a) / 4)
        func at(_ t: Double) -> Double { max(0, min(duration > 0.1 ? duration - 0.1 : t, t)) }
        return [at(a + inset), at((a + b) / 2), at(b - inset)]
    }

    /// A sheet of up to `perSheet` stretches (`[a, b]` each) of `src`, as a JPEG at `out`: a row of tiles an ffmpeg run,
    /// then the rows stacked. `beat` runs between rows.
    static func sheet(ffmpeg: URL, src: URL, stretches: [[Double]], duration: Double, landscape: Bool, out: URL, beat: () throws -> Void) throws {
        let (w, h) = landscape ? (frameW, frameH) : (frameH, frameW)
        let cols = self.cols(landscape)
        let cell = "scale=\(w):\(h):force_original_aspect_ratio=decrease,pad=\(w + 8):\(h + 8):(ow-iw)/2:(oh-ih)/2:white,setsar=1"
        let across = cols * frames
        var rows: [URL] = []
        defer { rows.forEach { try? FileManager.default.removeItem(at: $0) } }
        for r in stride(from: 0, to: stretches.count, by: cols) {
            try beat()
            let these = stretches[r..<min(stretches.count, r + cols)].flatMap { times($0[0], $0[1], duration: duration) }
            let blanks = across - these.count
            var graph = these.indices.map { "[\($0):v:0]\(cell)[f\($0)]" }.joined(separator: ";")
            if blanks > 0 { graph += ";color=white:s=\(w + 8)x\(h + 8):d=1,split=\(blanks)" + (0..<blanks).map { "[b\($0)]" }.joined() }
            graph += ";" + these.indices.map { "[f\($0)]" }.joined() + (0..<blanks).map { "[b\($0)]" }.joined() + "hstack=inputs=\(across)"
            let row = URL(fileURLWithPath: "\(out.path).\(r / cols).png")
            rows.append(row)
            _ = try run(ffmpeg, these.flatMap { ["-threads", "1", "-ss", String(format: "%.3f", $0), "-i", src.path] }
                + ["-filter_complex", graph, "-frames:v", "1", "-y", row.path])
        }
        let stack = rows.count > 1 ? ["-filter_complex", "vstack=inputs=\(rows.count)"] : []
        _ = try run(ffmpeg, rows.flatMap { ["-i", $0.path] } + stack + ["-frames:v", "1", "-q:v", "4", "-y", out.path])
    }

    /// The picture hash of each stretch's middle frame, read off its sheet (shots.ts sheetHashes); "" each when unread.
    static func hashes(ffmpeg: URL, sheet: URL, count: Int, landscape: Bool) -> [String] {
        let (w, h) = landscape ? (frameW, frameH) : (frameH, frameW)
        let cols = self.cols(landscape)
        let crops = (0..<count).map { k -> String in
            let x = (k % cols) * frames * (w + 8) + (w + 8) + 4
            let y = (k / cols) * (h + 8) + 4
            return "[t\(k)]crop=\(w):\(h):\(x):\(y),scale=9:8:flags=area,format=gray" + (count > 1 ? "[h\(k)]" : "")
        }
        var graph = "[0:v]split=\(count)" + (0..<count).map { "[t\($0)]" }.joined() + ";" + crops.joined(separator: ";")
        if count > 1 { graph += ";" + (0..<count).map { "[h\($0)]" }.joined() + "hstack=inputs=\(count)" }
        guard let raw = try? run(ffmpeg, ["-i", sheet.path, "-filter_complex", graph, "-frames:v", "1", "-f", "rawvideo", "pipe:1"]),
              raw.count == count * 72 else { return Array(repeating: "", count: count) }
        // one row of 9 × count grey pixels after another, eight rows: tile k's row y starts at (y × count + k) × 9
        return (0..<count).map { k in pictureHash((0..<72).map { raw[($0 / 9 * count + k) * 9 + $0 % 9] }) }
    }

    /// The difference hash of a 9×8 grey frame, as 16 hex digits (look.ts pictureHash).
    static func pictureHash(_ g: [UInt8]) -> String {
        var h: UInt64 = 0
        for y in 0..<8 { for x in 0..<8 { h = h << 1 | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0) } }
        return String(format: "%016llx", h)
    }

    /// One ffmpeg run with the server's global flags; its output. Throws with ffmpeg's last words when it fails.
    @discardableResult
    static func run(_ ffmpeg: URL, _ args: [String]) throws -> Data {
        let p = Process()
        p.executableURL = ffmpeg
        p.arguments = ["-hide_banner", "-loglevel", "error", "-nostdin"] + args
        let out = Pipe(), err = Pipe()
        p.standardOutput = out
        p.standardError = err
        p.standardInput = FileHandle.nullDevice
        try p.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        let words = err.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        try? out.fileHandleForReading.close()
        try? err.fileHandleForReading.close()
        guard p.terminationStatus == 0 else {
            throw LibraryLookRefused(why: "ffmpeg could not make the sheet: \(String(decoding: words.suffix(300), as: UTF8.self))")
        }
        return data
    }
}
