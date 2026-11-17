// The Media Library's cut model on this Mac's graphics card: TransNetV2 (MIT) as a Core ML model, made by
// scripts/transnetv2-coreml.py and fetched once on first use. The picture read (LookPicture.swift) feeds it each frame
// 48×27 from the same decode and sends its odds of a cut per frame; the server finds the cuts from them as for its own
// read (apps/captions/api/library/cuts.ts cutsFromModel) and keeps which way a file's cuts were found. Measured on an M2
// Max: 0.56 min of model time per hour of footage on the graphics card. Where it can't run (an Intel Mac, the download
// failed, CT_CUT_MODEL=0) the read is today's, and the server measures the cuts (cutsOf).
import Accelerate
import CoreML
import CryptoKit
import Foundation

final class CutModel: @unchecked Sendable {
    /// The converted model, zipped: a release of its own (never "latest") of the repository whose releases update this
    /// app (its feed, FEED_URL at build time, …/releases/latest/download/appcast.xml). A build updated from elsewhere,
    /// or not at all, has none and reads as before.
    static let url = modelURL(feed: Bundle.main.object(forInfoDictionaryKey: "SUFeedURL") as? String)
    static func modelURL(feed: String?) -> URL? {
        guard let feed, let r = feed.range(of: "/releases/latest/download/appcast.xml"), feed.hasPrefix("https://github.com/") else { return nil }
        return URL(string: feed[..<r.lowerBound] + "/releases/download/transnetv2-coreml-1/TransNetV2.mlpackage.zip")
    }
    static let sha256 = "65a31dca3d3f1a74e52822a7b832a57bb9b41a0ccd37de2997abe2b1193f0bde"
    /// Its frames (cuts.ts TW, TH), RGB 0-255; WIN at once, answering for the middle NEW (PAD on each side).
    static let width = 48
    static let height = 27
    static let win = 100
    static let new = 50
    static let pad = 25
    static let frameBytes = width * height * 3
    /// A failed fetch or load is tried again this long after, on a later read.
    static let retry: TimeInterval = 3600

    let model: MLModel

    init(model: MLModel) {
        self.model = model
    }

    private static let lock = NSLock()
    nonisolated(unsafe) private static var loaded: CutModel?
    nonisolated(unsafe) private static var failedAt: Date?

    /// Where it is kept, compiled: this app's own folder (as dictation's models).
    static var folder: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(
            "Library/Application Support/Creator Toolset\(AppIdentity.tag())/models/transnetv2-coreml-1", isDirectory: true)
    }

    /// The model for a picture read, fetched and compiled the first time; nil where it can't run here (then the read is
    /// today's). Blocks the calling thread (a look's own) while it fetches.
    static func shared() -> CutModel? {
        #if !arch(arm64)
        return nil // measured on Apple silicon's graphics card only
        #else
        if ProcessInfo.processInfo.environment["CT_CUT_MODEL"] == "0" { return nil }
        lock.lock()
        defer { lock.unlock() }
        if let loaded { return loaded }
        if let failedAt, Date().timeIntervalSince(failedAt) < retry { return nil }
        do {
            loaded = CutModel(model: try load(folder))
        } catch {
            failedAt = Date()
            AppLog.write("cut model: not used, the server measures the cuts: \(error.localizedDescription)")
        }
        return loaded
        #endif
    }

    /// The compiled model in `folder`, fetched, checked and compiled there first when it isn't yet.
    static func load(_ folder: URL) throws -> MLModel {
        let compiled = folder.appendingPathComponent("TransNetV2.mlmodelc")
        let config = MLModelConfiguration()
        config.computeUnits = .cpuAndGPU // the Neural Engine runs its 3D convolutions 7 times slower
        if let model = try? MLModel(contentsOf: compiled, configuration: config) { return model }
        let fm = FileManager.default
        let work = folder.appendingPathComponent("fetch")
        try? fm.removeItem(at: work)
        try fm.createDirectory(at: work, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: work) }
        guard let url else { throw LibraryLookRefused(why: "this copy of the app is not updated from a GitHub release feed") }
        let (data, response) = try waitAsync { try await URLSession.shared.data(from: url) }
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw LibraryLookRefused(why: "the model could not be fetched (\((response as? HTTPURLResponse)?.statusCode ?? 0))")
        }
        guard SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == sha256 else {
            throw LibraryLookRefused(why: "the fetched model's checksum does not match")
        }
        let zip = work.appendingPathComponent("model.zip")
        try data.write(to: zip)
        let unzip = Process()
        unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        unzip.arguments = ["-x", "-k", zip.path, work.path]
        try unzip.run()
        unzip.waitUntilExit()
        guard unzip.terminationStatus == 0 else { throw LibraryLookRefused(why: "the model could not be unzipped") }
        let made = try waitAsync { try await MLModel.compileModel(at: work.appendingPathComponent("TransNetV2.mlpackage")) }
        try? fm.removeItem(at: compiled)
        try fm.moveItem(at: made, to: compiled)
        return try MLModel(contentsOf: compiled, configuration: config)
    }

    /// A BGRA frame (the picture read's, any size) as the model's: `width` × `height` RGB.
    static func frame(_ buffer: CVPixelBuffer) -> [UInt8] {
        var bgra = [UInt8](repeating: 0, count: width * height * 4)
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        if let base = CVPixelBufferGetBaseAddress(buffer) {
            var src = vImage_Buffer(data: base, height: vImagePixelCount(CVPixelBufferGetHeight(buffer)),
                                    width: vImagePixelCount(CVPixelBufferGetWidth(buffer)), rowBytes: CVPixelBufferGetBytesPerRow(buffer))
            bgra.withUnsafeMutableBytes { out in
                var dst = vImage_Buffer(data: out.baseAddress, height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width * 4)
                _ = vImageScale_ARGB8888(&src, &dst, nil, vImage_Flags(kvImageHighQualityResampling))
            }
        }
        var rgb = [UInt8](repeating: 0, count: frameBytes)
        for i in 0..<width * height {
            rgb[i * 3] = bgra[i * 4 + 2]
            rgb[i * 3 + 1] = bgra[i * 4 + 1]
            rgb[i * 3 + 2] = bgra[i * 4]
        }
        return rgb
    }

    /// One window's frames and their colour histograms (the model's second input, scripts/transnetv2-coreml.py hist):
    /// each frame's pixels counted in 512 colours (R, G, B >> 5), divided by the counts' length.
    func odds(_ frames: [[UInt8]]) throws -> (one: [Double], many: [Double]) {
        let n = Self.win
        let x = try MLMultiArray(shape: [1, n, Self.height, Self.width, 3] as [NSNumber], dataType: .float32)
        let h = try MLMultiArray(shape: [1, n, 512] as [NSNumber], dataType: .float32)
        x.withUnsafeMutableBufferPointer(ofType: Float.self) { xs, _ in
            h.withUnsafeMutableBufferPointer(ofType: Float.self) { hs, _ in
                for (j, f) in frames.enumerated() {
                    var count = [Float](repeating: 0, count: 512)
                    for p in 0..<Self.width * Self.height {
                        let (r, g, b) = (f[p * 3], f[p * 3 + 1], f[p * 3 + 2])
                        count[Int(r >> 5) << 6 | Int(g >> 5) << 3 | Int(b >> 5)] += 1
                    }
                    let length = count.reduce(0) { $0 + $1 * $1 }.squareRoot()
                    for c in 0..<512 { hs[j * 512 + c] = count[c] / length }
                    for b in 0..<Self.frameBytes { xs[j * Self.frameBytes + b] = Float(f[b]) }
                }
            }
        }
        let out = try model.prediction(from: MLDictionaryFeatureProvider(dictionary: ["frames": x, "hist": h]))
        func read(_ name: String) throws -> [Double] {
            guard let a = out.featureValue(for: name)?.multiArrayValue else { throw LibraryLookRefused(why: "the cut model gave no \(name)") }
            return (0..<n).map { a[[0, $0, 0] as [NSNumber]].doubleValue }
        }
        return (try read("one"), try read("many"))
    }

    /// Frames as they are read through the model, a window each `new` frames (cuts.ts modelWindows): `end` pads the
    /// last window with the last frame and gives every frame's two odds. The model runs on a queue of its own, so the
    /// graphics card works while the next frames decode; a failed window is thrown by `end`, or by the next `push`.
    struct Windows {
        /// one window's frames → their odds (CutModel.odds; a stand-in in the tests)
        let odds: ([[UInt8]]) throws -> (one: [Double], many: [Double])
        /// the frames from `base` on, as many as the next window needs
        private var frames: [[UInt8]] = []
        private var base = 0
        private var n = 0
        /// the next window: its first frame is next × new − pad
        private var next = 0
        private var first: [UInt8]?
        /// the answers so far, written on `queue` only
        private final class Answers: @unchecked Sendable {
            var one: [Double] = []
            var many: [Double] = []
            var failed: Error?
        }
        private let answers = Answers()
        private let queue = DispatchQueue(label: "cut-model", qos: .utility)

        init(odds: @escaping ([[UInt8]]) throws -> (one: [Double], many: [Double])) {
            self.odds = odds
        }

        mutating func push(_ f: [UInt8]) throws {
            if first == nil { first = f }
            frames.append(f)
            n += 1
            while n >= next * CutModel.new + CutModel.win - CutModel.pad {
                if let e = queue.sync(execute: { answers.failed }) { throw e }
                run()
                let keep = next * CutModel.new - CutModel.pad // the first frame the next window looks at
                if keep > base { frames.removeFirst(keep - base); base = keep }
            }
        }

        mutating func end() throws -> (one: [Double], many: [Double]) {
            while next * CutModel.new < n { run() }
            return try queue.sync {
                if let e = answers.failed { throw e }
                return (Array(answers.one.prefix(n)), Array(answers.many.prefix(n)))
            }
        }

        private mutating func run() {
            let start = next * CutModel.new - CutModel.pad
            let window = (0..<CutModel.win).map { j -> [UInt8] in
                let i = start + j
                return i < 0 ? first! : frames[min(i, n - 1) - base]
            }
            next += 1
            let (odds, answers) = (odds, answers)
            queue.async {
                guard answers.failed == nil else { return }
                do {
                    let (a, b) = try odds(window)
                    answers.one += a[CutModel.pad..<CutModel.pad + CutModel.new]
                    answers.many += b[CutModel.pad..<CutModel.pad + CutModel.new]
                } catch {
                    answers.failed = error
                }
            }
        }
    }
}
