import AVFoundation
import CoreText
import SwiftUI
import UIKit

/// Caption Studio on the phone: the website's projects and clips (apps/captions/api/projects.ts);
/// the caption layout and the AI passes run on the server
/// (api/caption-layout.ts), so a clip captioned here opens on the web laid
/// out the same.

// MARK: JSON the phone passes through

/// Any JSON value: the parts of a clip the phone doesn't edit (text
/// overlays, position sections, waveform) go back as they came.
enum JSONValue: Codable, Hashable {
    case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let v = try? c.decode(Bool.self) { self = .bool(v) }
        else if let v = try? c.decode(Double.self) { self = .number(v) }
        else if let v = try? c.decode(String.self) { self = .string(v) }
        else if let v = try? c.decode([JSONValue].self) { self = .array(v) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    var double: Double? { if case .number(let v) = self { return v }; return nil }
    var string: String? { if case .string(let v) = self { return v }; return nil }
    var bool: Bool? { if case .bool(let v) = self { return v }; return nil }
}

// MARK: The website's shapes (apps/captions/src/lib/types.ts)

struct CapWord: Codable, Hashable {
    var id: Int
    var text: String
    var start: Double
    var end: Double
    var confidence: Double?
    var utterance: Int?
    var timing: String?
    /// Match cadence mark: 2 starts a thought, 1 may split a wide line.
    var cut: Int?
}

struct CapCue: Codable, Hashable, Identifiable {
    var id: Int
    var start: Double
    var end: Double
    var words: [CapWord]
    /// Words per on-screen line, from the layout.
    var lines: [Int]?

    var text: String { words.map(\.text).joined(separator: " ") }

    /// The words of each on-screen line: the layout's counts, or greedy
    /// wrapping to the box when they don't fit this caption.
    func lineWords(maxChars: Int) -> [[CapWord]] {
        var counts = lines ?? []
        if counts.reduce(0, +) != words.count || counts.contains(where: { $0 <= 0 }) {
            counts = []
            var n = 0, width = 0
            for w in words {
                if n > 0 && width + 1 + w.text.count > maxChars {
                    counts.append(n)
                    n = 0
                    width = 0
                }
                width += (n > 0 ? 1 : 0) + w.text.count
                n += 1
            }
            if n > 0 { counts.append(n) }
        }
        var out: [[CapWord]] = []
        var at = 0
        for c in counts {
            out.append(Array(words[at..<at + c]))
            at += c
        }
        return out
    }
}

/// A clip's caption style, kept whole: the phone changes a few fields and
/// sends the rest back untouched.
struct CapStyle: Codable, Hashable {
    var values: [String: JSONValue]

    init(values: [String: JSONValue]) { self.values = values }

    init(from decoder: Decoder) throws {
        values = try decoder.singleValueContainer().decode([String: JSONValue].self)
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(values)
    }

    func number(_ key: String, _ fallback: Double) -> Double { values[key]?.double ?? fallback }
    func text(_ key: String, _ fallback: String) -> String { values[key]?.string ?? fallback }
    func flag(_ key: String) -> Bool { values[key]?.bool ?? false }
    mutating func set(_ key: String, _ value: Double) { values[key] = .number(value) }
    mutating func set(_ key: String, _ value: String) { values[key] = .string(value) }
    mutating func set(_ key: String, _ value: Bool) { values[key] = .bool(value) }

    var fontFamily: String {
        get { text("fontFamily", "Montserrat") }
        set { set("fontFamily", newValue) }
    }
    var fontSizePct: Double {
        get { number("fontSizePct", 2.5) }
        set { set("fontSizePct", newValue) }
    }
    var boxX: Double {
        get { number("boxX", 50) }
        set { set("boxX", newValue) }
    }
    var boxY: Double {
        get { number("boxY", 63.9) }
        set { set("boxY", newValue) }
    }
    var boxW: Double {
        get { number("boxW", 68.5) }
        set { set("boxW", newValue) }
    }
    var boxH: Double {
        get { number("boxH", 4.17) }
        set { set("boxH", newValue) }
    }
    var animation: String {
        get { text("animation", "none") }
        set { set("animation", newValue) }
    }
    var textColor: Color { hexColor(text("textColor", "#FFFFFF")) }
    var highlightColor: Color { hexColor(text("highlightColor", "#FFFFFF")) }
    var outlineColor: Color { hexColor(text("outlineColor", "#000000")) }
    var outlineWidth: Double { number("outlineWidth", 0) }
    var shadowDepth: Double { number("shadowDepth", 0) }
    var boxEnabled: Bool { flag("boxEnabled") }
    var boxColor: Color { hexColor(text("boxColor", "#000000")).opacity(number("boxOpacity", 1)) }
    var karaoke: Bool { animation == "karaoke" }

    /// Lines a caption may have. The web has no such field: the box height
    /// against the font size decides it (boxCaps), so this sets the height,
    /// with a little slack so rounding never loses a line.
    var lines: Int {
        get { max(1, Int(((boxH - 0.24 * fontSizePct) / (1.18 * fontSizePct)).rounded(.down))) }
        set { boxH = min(100, (0.24 + 1.18 * Double(newValue) + 0.3) * fontSizePct) }
    }

    /// A new font size that keeps the line count.
    mutating func resize(_ pct: Double) {
        let n = lines
        fontSizePct = pct
        lines = n
    }

    func cased(_ s: String) -> String { flag("uppercase") ? s.uppercased() : flag("lowercase") ? s.lowercased() : s }

    /// Characters per line the box holds (boxCaps in src/lib/captions.ts).
    func maxChars(width: Double, height: Double) -> Int {
        let fontPx = fontSizePct / 100 * height
        return max(4, Int((boxW / 100 * width) / (fontPx * 0.55)))
    }
}

/// "#RRGGBB" for the web's style fields (no alpha: opacity is its own field).
func hexString(_ color: Color) -> String {
    var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
    UIColor(color).getRed(&r, green: &g, blue: &b, alpha: &a)
    let c = { (v: CGFloat) in Int((min(max(v, 0), 1) * 255).rounded()) }
    return String(format: "#%02X%02X%02X", c(r), c(g), c(b))
}

func hexColor(_ hex: String) -> Color {
    let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
    guard digits.count == 6, let v = UInt32(digits, radix: 16) else { return .white }
    return Color(red: Double(v >> 16 & 0xFF) / 255, green: Double(v >> 8 & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
}

/// A built-in preset, or one saved on creatortoolset.com (`/api/presets`:
/// an admin's are everyone's, anyone else's are their own).
struct CapPreset: Codable, Hashable {
    let name: String
    let style: CapStyle
    var id: String?
    var kind: String?
    var scope: String?
    var owner: String?
}

/// One clip as `/api/projects/:id` has it, and as `/sync` takes it back
/// (the web's `buildPayload` fields).
struct CapClip: Codable, Hashable, Identifiable {
    let id: String
    var name: String
    var duration: Double?
    var style: CapStyle?
    var words: [CapWord]?
    var originalWords: [CapWord]?
    var cues: [CapCue]?
    var posSegments: JSONValue?
    var texts: JSONValue?
    var cadenceApplied: Bool?
    var cadenceFit: JSONValue?
    var cadenceDirty: Bool?
    var done: Bool?
    var peaks: JSONValue?
}

/// What the server says about a clip's files (never sent back).
struct CapClipMedia: Decodable {
    let id: String
    let hasOriginal: Bool?
    let srcWidth: Int?
    let srcHeight: Int?
    let srcFps: Double?
}

struct CapProject: Decodable {
    let name: String
    let revision: Int
    let fps: Double?
    let model: String?
    let autoCadence: Bool?
    let script: String?
    let clips: [CapClip]
}

struct CapProjectSummary: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let updatedAt: Double
    let duration: Double?
    let clipCount: Int
    let thumbClipId: String?

    var thumb: String? { thumbClipId.map { "/api/projects/\(id)/clips/\($0)/thumb" } }
}

// MARK: Calls

extension API {
    /// JSON in and out on the slow session (the AI pass takes a minute or two).
    func call<Body: Encodable, Answer: Decodable>(_ path: String, method: String = "POST", _ body: Body) async throws -> Answer {
        var r = request(path, method: method)
        r.httpBody = try JSONEncoder().encode(body)
        r.setValue("application/json", forHTTPHeaderField: "Content-Type")
        return try JSONDecoder().decode(Answer.self, from: try await data(r, session: Self.slow))
    }

    /// A clip's source file to its project in 16 MB parts, three at a time.
    /// Parts the server already has are skipped, so trying again resumes
    /// (the web's parallel upload, api/projects.ts).
    func uploadOriginal(project: String, clip: String, file: URL,
                        progress: @escaping @MainActor (Double) -> Void) async throws {
        let base = "/api/projects/\(project)/clips/\(clip)/original"
        struct State: Decodable {
            struct Part: Decodable { let partNumber: Int; let size: Int }
            let partSize: Int?
            let received: [Part]
            let complete: Bool
        }
        let state: State = try await get("\(base)/parts")
        if state.complete { return }
        let total = (try FileManager.default.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
        guard total > 0 else { throw Failure(status: 0, message: "The video file is empty.") }
        let size = Self.partSize
        let count = (total + size - 1) / size
        var queue = Self.partsToSend(total: total, serverPartSize: state.partSize,
                                     received: state.received.map { (number: $0.partNumber, size: $0.size) })[...]
        var sent = count - queue.count
        try await withThrowingTaskGroup(of: Void.self) { group in
            for _ in 0..<3 {
                if let n = queue.popFirst() {
                    group.addTask { try await sendPart(base, n, size: size, total: total, file: file) }
                }
            }
            while try await group.next() != nil {
                sent += 1
                await progress(Double(sent) / Double(count))
                if let n = queue.popFirst() {
                    group.addTask { try await sendPart(base, n, size: size, total: total, file: file) }
                }
            }
        }
        _ = try await data(request("\(base)/complete", method: "POST"), session: Self.slow)
    }

    static let partSize = 16 * 1024 * 1024

    /// The part numbers the server doesn't have whole yet. A part of another size, or parts cut to another size,
    /// are sent again.
    static func partsToSend(total: Int, serverPartSize: Int?, received: [(number: Int, size: Int)]) -> [Int] {
        let size = partSize
        let count = (total + size - 1) / size
        guard count > 0 else { return [] }
        let length = { (n: Int) in min(size, total - (n - 1) * size) }
        let have = serverPartSize == size ? Set(received.filter { $0.size == length($0.number) }.map(\.number)) : []
        return (1...count).filter { !have.contains($0) }
    }

    private func sendPart(_ base: String, _ n: Int, size: Int, total: Int, file: URL) async throws {
        let handle = try FileHandle(forReadingFrom: file)
        let body: Data
        do {
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64((n - 1) * size))
            body = try handle.read(upToCount: min(size, total - (n - 1) * size)) ?? Data()
        }
        var r = request("\(base)/parts/\(n)", method: "POST")
        r.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        r.setValue(String(size), forHTTPHeaderField: "Upload-Part-Size")
        r.setValue(String(total), forHTTPHeaderField: "Upload-Length")
        var attempt = 0
        while true {
            attempt += 1
            do {
                let (data, response) = try await Self.slow.upload(for: r, from: body)
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                if (200..<300).contains(status) { return }
                let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
                let failure = Failure(status: status, message: object?["error"] as? String ?? "Upload failed (HTTP \(status))")
                if status < 500 || attempt == 3 { throw failure }
            } catch let failure as Failure {
                throw failure
            } catch {
                if attempt == 3 { throw Failure(status: 0, message: "The upload stopped. Check the connection and try again.") }
            }
            try await Task.sleep(for: .seconds(2 * attempt))
        }
    }
}

// MARK: Local media

/// A picked video: its displayed size (rotation applied), rate and length.
struct CaptionSource {
    let url: URL
    let width: Int
    let height: Int
    let fps: Double
    let duration: Double

    static func probe(_ url: URL) async throws -> CaptionSource {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw APIError(status: 0, message: "This file has no video.")
        }
        let (size, transform, rate) = try await track.load(.naturalSize, .preferredTransform, .nominalFrameRate)
        let shown = size.applying(transform)
        return CaptionSource(url: url, width: Int(abs(shown.width).rounded()), height: Int(abs(shown.height).rounded()),
                             fps: rate > 0 ? Double(rate) : 30, duration: duration)
    }
}

enum CaptionAudio {
    /// 16 kHz mono 16-bit WAV, what `/api/transcribe` takes (the web sends the same).
    static func wav(_ url: URL) async throws -> Data {
        try await Task.detached(priority: .userInitiated) {
            let asset = AVURLAsset(url: url)
            guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
                throw APIError(status: 0, message: "This video has no sound to caption.")
            }
            let reader = try AVAssetReader(asset: asset)
            let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
                AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ])
            reader.add(output)
            guard reader.startReading() else {
                throw reader.error ?? APIError(status: 0, message: "Couldn't read the sound.")
            }
            var pcm = Data()
            while let buffer = output.copyNextSampleBuffer() {
                guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
                let length = CMBlockBufferGetDataLength(block)
                var chunk = Data(count: length)
                chunk.withUnsafeMutableBytes { raw in
                    _ = CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: raw.baseAddress!)
                }
                pcm.append(chunk)
            }
            guard reader.status == .completed else {
                throw reader.error ?? APIError(status: 0, message: "Couldn't read the sound.")
            }
            return header(bytes: pcm.count) + pcm
        }.value
    }

    static func header(bytes: Int) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        d.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + bytes)); d.append(contentsOf: Array("WAVEfmt ".utf8))
        u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(UInt32(bytes))
        return d
    }
}

/// The website's caption fonts (apps/captions/public/fonts, the table in
/// src/render-entry.tsx), fetched once and registered for this app.
@MainActor
final class CaptionFonts: ObservableObject {
    static let shared = CaptionFonts()
    static let files: [String: String] = [
        "Anton": "Anton-Regular.ttf", "Archivo Black": "ArchivoBlack-Regular.ttf", "Bebas Neue": "BebasNeue-Regular.ttf",
        "Inter": "Inter-Bold.ttf", "Inter ExtraBold": "Inter-ExtraBold.ttf", "Montserrat": "Montserrat-Bold.ttf",
        "Montserrat SemiBold": "Montserrat-SemiBold.ttf", "Montserrat ExtraBold": "Montserrat-ExtraBold.ttf",
        "Oswald SemiBold": "Oswald-SemiBold.ttf", "Oswald": "Oswald-Bold.ttf", "Poppins": "Poppins-Bold.ttf",
    ]
    private static let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("caption-fonts", isDirectory: true)

    /// Family → PostScript name, once registered.
    @Published private(set) var names: [String: String] = [:]
    private var loading: Set<String> = []

    /// A family that isn't loaded (yet): the system's bold.
    func font(_ family: String, size: Double) -> UIFont {
        names[family].flatMap { UIFont(name: $0, size: size) } ?? .systemFont(ofSize: size, weight: .bold)
    }

    /// Every font, for the font picker (each is shown in itself).
    func loadAll() async {
        for family in Self.files.keys.sorted() { await load(family) }
    }

    func load(_ family: String) async {
        guard names[family] == nil, !loading.contains(family), let file = Self.files[family] else { return }
        loading.insert(family)
        defer { loading.remove(family) }
        let local = Self.folder.appendingPathComponent(file)
        if !FileManager.default.fileExists(atPath: local.path) {
            guard let api = API.current, let data = try? await api.data(api.request("/fonts/\(file)")) else { return }
            try? FileManager.default.createDirectory(at: Self.folder, withIntermediateDirectories: true)
            try? data.write(to: local, options: .atomic)
        }
        CTFontManagerRegisterFontsForURL(local as CFURL, .process, nil)
        guard let descriptors = CTFontManagerCreateFontDescriptorsFromURL(local as CFURL) as? [CTFontDescriptor],
              let name = descriptors.first.flatMap({ CTFontDescriptorCopyAttribute($0, kCTFontNameAttribute) as? String })
        else { return }
        names[family] = name
    }
}

@MainActor
final class CaptionClock: ObservableObject {
    @Published var time: Double = 0
}

/// Videos picked on this phone, kept until the server has the original and the captions, so a project carries on
/// after the app was closed or the connection dropped. Filed per server and account: a copy is only ever sent to the
/// server it was picked for.
enum CaptionSources {
    /// Application Support (kept until the app is deleted); tests point it elsewhere.
    static var root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("caption-sources", isDirectory: true)

    private static func server(_ key: String) -> URL {
        root.appendingPathComponent(key.replacingOccurrences(of: "/", with: "_"), isDirectory: true)
    }

    /// Moves the picker's copy in under the project; the original on failure.
    static func keep(_ picked: URL, for project: String, server key: String) -> URL {
        let target = server(key).appendingPathComponent(project, isDirectory: true)
        let file = target.appendingPathComponent(picked.lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: target, withIntermediateDirectories: true)
            try FileManager.default.moveItem(at: picked, to: file)
            return file
        } catch {
            return picked
        }
    }

    static func file(for project: String, server key: String) -> URL? {
        let target = server(key).appendingPathComponent(project, isDirectory: true)
        return (try? FileManager.default.contentsOfDirectory(at: target, includingPropertiesForKeys: nil))?.first
    }

    static func forget(_ project: String, server key: String) {
        try? FileManager.default.removeItem(at: server(key).appendingPathComponent(project, isDirectory: true))
    }

    /// The projects of this server that still have a kept copy.
    static func kept(server key: String) -> [String] {
        let folders = (try? FileManager.default.contentsOfDirectory(at: server(key), includingPropertiesForKeys: nil)) ?? []
        return folders.filter { file(for: $0.lastPathComponent, server: key) != nil }.map(\.lastPathComponent).sorted()
    }
}

// MARK: Projects

@MainActor
final class CaptionProjects: ObservableObject {
    @Published private(set) var projects: [CapProjectSummary] = []
    @Published private(set) var error: String?
    @Published private(set) var needsSignIn = false
    @Published private(set) var loading = false

    init() {
        if let api = API.current { projects = DiskCache.read("captions-\(api.cacheKey)") ?? [] }
    }

    func load() async {
        guard let api = API.current else {
            needsSignIn = true
            return
        }
        CaptionEditor.resumeKept()
        loading = projects.isEmpty
        defer { loading = false }
        do {
            let list: [CapProjectSummary] = try await api.get("/api/projects")
            projects = list
            DiskCache.write("captions-\(api.cacheKey)", list)
            error = nil
            needsSignIn = false
        } catch {
            needsSignIn = error.needsToolsetSignIn
            self.error = needsSignIn ? nil : error.localizedDescription
        }
    }
}

/// One project open in the editor. Editors stay alive while the app runs,
/// so an upload or a caption pass carries on when you go back to the list.
@MainActor
final class CaptionEditor: ObservableObject, Identifiable {
    /// By server and project.
    private static var open: [String: CaptionEditor] = [:]
    /// Saved presets are per account, so the cache is too.
    static var presetsKey: String { "caption-presets-\(API.current?.cacheKey ?? "")" }

    let id: String
    /// The server and account the project is on (`API.cacheKey`).
    let server: String
    /// Its client while that server is the one in use; nil after a switch (the work carries on when it is back).
    private var connection: API? { API.current.flatMap { $0.cacheKey == server ? $0 : nil } }
    @Published var name = ""
    @Published private(set) var clips: [CapClip] = []
    @Published private(set) var clip: CapClip?
    @Published private(set) var presets: [CapPreset] = DiskCache.read(CaptionEditor.presetsKey) ?? []
    /// What's running; nil when idle. Each operation sets it and clears it itself.
    enum Step: Equatable {
        case opening, starting, fetching, transcribing, matching

        var label: String {
            switch self {
            case .opening: return "Opening…"
            case .starting: return "Starting…"
            case .fetching: return "Fetching the video…"
            case .transcribing: return "Transcribing…"
            case .matching: return "Matching the cadence…"
            }
        }
    }
    @Published private(set) var step: Step?
    @Published var error: String?
    @Published var notice: String?
    /// 0…1 while the source goes up; nil otherwise.
    @Published private(set) var uploading: Double?
    @Published private(set) var hasOriginal = false
    @Published private(set) var exporting: String?
    /// The playhead, apart so only the captions redraw 30 times a second.
    let clock = CaptionClock()
    @Published private(set) var player: AVPlayer?
    /// The frame the captions are laid out for: the source's displayed size.
    @Published private(set) var frame = CGSize(width: 1080, height: 1920)

    private var project: CapProject?
    private var media: [CapClipMedia] = []
    private var local: CaptionSource?
    private var fps: Double = 30
    private var revision = 0
    private var saveChain: Task<Void, Never>?
    private var saveSoon: Task<Void, Never>?
    private var layoutGen = 0
    private var observer: Any?

    private init(id: String, server: String) {
        self.id = id
        self.server = server
    }

    /// A project of the server in use. Opened again after something stopped (a read that failed, an upload cut
    /// off), it carries on.
    static func project(_ id: String) -> CaptionEditor {
        let server = API.current?.cacheKey ?? ""
        if let editor = open["\(server)|\(id)"] {
            editor.carryOn()
            return editor
        }
        let editor = CaptionEditor(id: id, server: server)
        open["\(server)|\(id)"] = editor
        Task { await editor.load() }
        return editor
    }

    /// A new project from a picked video: it plays at once while it uploads
    /// and gets captioned.
    static func new(_ picked: URL) -> CaptionEditor {
        let server = API.current?.cacheKey ?? ""
        let editor = CaptionEditor(id: UUID().uuidString.lowercased(), server: server)
        open["\(server)|\(editor.id)"] = editor
        editor.name = picked.deletingPathExtension().lastPathComponent
        let file = CaptionSources.keep(picked, for: editor.id, server: server)
        editor.play(AVPlayer(url: file))
        Task { await editor.start(file) }
        return editor
    }

    /// Every project picked on this phone whose video or captions haven't all reached the server in use carries on:
    /// at launch, on a server change and when Caption Studio opens.
    static func resumeKept() {
        guard let api = API.current, ToolsetAccess.shared.allows("captions") else { return }
        for id in CaptionSources.kept(server: api.cacheKey) { _ = project(id) }
    }

    private func carryOn() {
        guard !busy, uploading == nil, connection != nil else { return }
        if project == nil, clip == nil {
            Task { await load() }
        } else if canRetryUpload {
            Task { await upload() }
        }
    }

    var busy: Bool { step != nil || exporting != nil }
    var canRetryUpload: Bool { local != nil && !hasOriginal && uploading == nil && clip != nil }
    var cues: [CapCue] { clip?.cues ?? [] }
    var style: CapStyle? { clip?.style ?? presets.first?.style }
    var transcript: String { cues.map(\.text).joined(separator: "\n") }
    var matched: Bool { clip?.cadenceApplied ?? false }

    func cue(at t: Double) -> CapCue? { cues.first { t >= $0.start && t < $0.end } }

    // MARK: Loading

    private func load() async {
        guard connection != nil else { return fail("Sign in first.") }
        async let presetsLoaded: Void = loadPresets()
        switch await fetchProject() {
        case .found:
            if let file = CaptionSources.file(for: id, server: server) {
                await resume(file)
            } else if !hasOriginal, cues.isEmpty {
                fail("This video didn't finish uploading from the phone it was picked on. Pick it again.")
            }
        case .missing:
            // picked while the server couldn't be reached: the project is made now, from the kept copy
            if let file = CaptionSources.file(for: id, server: server) {
                error = nil
                if name.isEmpty { name = file.deletingPathExtension().lastPathComponent }
                play(AVPlayer(url: file))
                await start(file)
            } else {
                fail("This project is gone.")
            }
        case .failed:
            break
        }
        await presetsLoaded
    }

    private enum Fetched { case found, missing, failed }

    /// Reads the project from the server (a failure is shown; a project the server doesn't have is `.missing`).
    /// Holds the step only for the read, so resume() can take its own.
    private func fetchProject() async -> Fetched {
        guard let api = connection else { return .failed }
        step = .opening
        defer { step = nil }
        do {
            let data = try await api.data(api.request("/api/projects/\(id)"))
            let project = try JSONDecoder().decode(CapProject.self, from: data)
            struct Media: Decodable { let clips: [CapClipMedia] }
            media = (try? JSONDecoder().decode(Media.self, from: data))?.clips ?? []
            self.project = project
            name = project.name
            revision = project.revision
            clips = project.clips
            if let first = project.clips.first { await show(first) }
            return .found
        } catch APIError.server(404, _) {
            return .missing
        } catch {
            fail(error.localizedDescription)
            return .failed
        }
    }

    /// The built-ins plus the saved ones, as the web's preset row lists them:
    /// a global preset with a built-in's name replaces it.
    func loadPresets() async {
        struct Answer: Decodable { let presets: [CapPreset] }
        guard let api = connection else { return }
        async let builtIn: Answer? = try? api.get("/api/captions/presets")
        async let savedList: [CapPreset]? = try? api.get("/api/presets")
        guard let base = await builtIn?.presets else { return }
        let saved = (await savedList ?? []).filter { $0.kind == "caption" }
        let replaced = Set(saved.filter { $0.scope == "global" }.map { $0.name.lowercased() })
        let defaults = base.first?.style.values ?? [:]
        let all = base.filter { !replaced.contains($0.name.lowercased()) } + saved.map { preset in
            var values = defaults.merging(preset.style.values) { $1 }
            values["fitBox"] = .bool(true)
            return CapPreset(name: preset.name, style: CapStyle(values: values), id: preset.id,
                             kind: preset.kind, scope: preset.scope, owner: preset.owner)
        }
        presets = all
        DiskCache.write(Self.presetsKey, all)
    }

    /// Saves the current style under a name (the same name again replaces it).
    func savePreset(_ name: String) async {
        guard let api = connection, let style = clip?.style else { return }
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        struct Body: Encodable { let name: String; let kind = "caption"; let style: CapStyle }
        do {
            let _: CapPreset = try await api.call("/api/presets", Body(name: trimmed, style: style))
            await loadPresets()
            notice = "Saved “\(trimmed)”; it's on the website too."
        } catch {
            fail(error.localizedDescription)
        }
    }

    func deletePreset(_ preset: CapPreset) async {
        guard let api = connection, let id = preset.id else { return }
        do {
            try await api.send("/api/presets/\(id)", method: "DELETE")
            await loadPresets()
        } catch {
            fail(error.localizedDescription)
        }
    }

    /// Opens a clip of a web project: its proxy streams from the server.
    func show(_ next: CapClip) async {
        guard let api = connection else { return }
        if clip != nil, clip?.id != next.id { await save() }
        clip = next
        let info = media.first { $0.id == next.id }
        hasOriginal = info?.hasOriginal ?? false
        fps = project?.fps ?? info?.srcFps ?? 30
        let player = api.player("/api/projects/\(id)/clips/\(next.id)/video")
        play(player)
        // The server's size is the coded one; the proxy says which way up it plays.
        var size = CGSize(width: info?.srcWidth ?? 0, height: info?.srcHeight ?? 0)
        if let item = player.currentItem,
           let track = try? await item.asset.loadTracks(withMediaType: .video).first,
           let loaded = try? await track.load(.naturalSize, .preferredTransform) {
            let shown = loaded.0.applying(loaded.1)
            let upright = CGSize(width: abs(shown.width), height: abs(shown.height))
            if size.width == 0 { size = upright }
            else if (size.width > size.height) != (upright.width > upright.height) {
                size = CGSize(width: size.height, height: size.width)
            }
        }
        if size.width > 0 { frame = size }
        if let family = next.style?.fontFamily { await CaptionFonts.shared.load(family) }
    }

    private func play(_ next: AVPlayer) {
        if let observer { player?.removeTimeObserver(observer) }
        player?.pause()
        player = next
        #if DEBUG
        if let t = debugArg("SeekTo").flatMap(Double.init) {
            Task {
                while next.currentItem?.status != .readyToPlay { try? await Task.sleep(for: .milliseconds(200)) }
                await next.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            }
        }
        #endif
        observer = next.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] t in
            MainActor.assumeIsolated { self?.clock.time = t.seconds }
        }
    }

    /// A project picked on this phone whose upload or captions didn't
    /// finish (the app was closed): carry on from the kept copy.
    private func resume(_ file: URL) async {
        guard let clip, let source = try? await CaptionSource.probe(file) else { return }
        if hasOriginal, !cues.isEmpty {
            CaptionSources.forget(id, server: server)   // all on the server now
            return
        }
        local = source
        frame = CGSize(width: source.width, height: source.height)
        fps = source.fps
        play(AVPlayer(url: file))   // plays before the upload is done
        if !hasOriginal { Task { await upload() } }
        if (clip.cues ?? []).isEmpty {
            do { try await caption(file) } catch { fail(error.localizedDescription) }
        }
    }

    // MARK: A new project

    private func start(_ file: URL) async {
        guard let api = connection else { return fail("Sign in first.") }
        let clipId = UUID().uuidString.lowercased()
        do {
            step = .starting
            let source = try await CaptionSource.probe(file)
            local = source
            frame = CGSize(width: source.width, height: source.height)
            fps = source.fps
            if presets.isEmpty { await loadPresets() }
            guard let style = presets.first?.style else { throw APIError(status: 0, message: "Couldn't load the caption styles.") }
            await CaptionFonts.shared.load(style.fontFamily)
            try await api.send("/api/projects/\(id)/draft", method: "PUT",
                               json: ["name": name, "clips": [["id": clipId, "name": name]]])
            let fresh = CapClip(id: clipId, name: name, duration: source.duration, style: style,
                                posSegments: .array([]), texts: .array([]), cadenceApplied: false,
                                cadenceDirty: false, done: false)
            clips = [fresh]
            clip = fresh
            Task { await upload() }
            try await caption(source.url)
            step = nil
            #if DEBUG
            // simulator checks without taps: -AutoExport YES
            if debugArg("AutoExport") != nil {
                while !hasOriginal, uploading != nil { try? await Task.sleep(for: .seconds(1)) }
                await export(toFinals: false)
            }
            #endif
        } catch APIError.server(404, _) where clip == nil {
            // deleted on the website (or another account's): nothing to send it to
            step = nil
            CaptionSources.forget(id, server: server)
            fail("This project was deleted.")
        } catch {
            step = nil
            fail(error.localizedDescription)
        }
    }

    /// Sends the picked file up (export needs it on the server). Safe to call again after a failure.
    func upload() async {
        guard let api = connection, let local, let clipId = clip?.id, uploading == nil, !hasOriginal else { return }
        uploading = 0
        let background = UIApplication.shared.beginBackgroundTask(withName: "Caption Studio upload")
        defer {
            uploading = nil
            UIApplication.shared.endBackgroundTask(background)
        }
        do {
            try await api.uploadOriginal(project: id, clip: clipId, file: local.url) { [weak self] in self?.uploading = $0 }
            hasOriginal = true
        } catch {
            fail("Upload stopped: \(error.localizedDescription)")
        }
    }

    // MARK: Captions

    /// Transcribes the sound, then the web's automatic passes (script check
    /// not here: no script on the phone), and saves.
    private func caption(_ file: URL) async throws {
        guard let api = connection, var current = clip, let style = current.style ?? presets.first?.style else { return }
        step = .transcribing
        defer { step = nil }
        var request = api.request("/api/transcribe", method: "POST")
        request.httpBody = try await CaptionAudio.wav(file)
        request.setValue("audio/wav", forHTTPHeaderField: "Content-Type")
        request.setValue(name.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "clip", forHTTPHeaderField: "X-File-Name")
        struct Heard: Decodable {
            struct Word: Decodable {
                let text: String
                let start: Double
                let end: Double
                let confidence: Double?
                let utterance: Int?
                let timing: String?
            }
            let words: [Word]
        }
        let heard = try JSONDecoder().decode(Heard.self, from: try await api.data(request, session: API.slow))
        let words = heard.words.enumerated().map { i, w in
            CapWord(id: i + 1, text: w.text, start: w.start, end: w.end, confidence: w.confidence,
                    utterance: w.utterance, timing: w.timing)
        }
        guard !words.isEmpty else { throw APIError(status: 0, message: "No speech heard in this video.") }
        step = .matching
        let auto = try await autoCaptions(words, style: style)
        current = clip ?? current
        current.style = style
        current.originalWords = words
        apply(auto, to: &current)
        clip = current
        await save()
    }

    private struct Auto: Decodable {
        let words: [CapWord]
        let cues: [CapCue]
        let cadenceApplied: Bool
        let cadenceFit: JSONValue?
        let aiError: String?
    }

    private func autoCaptions(_ words: [CapWord], style: CapStyle) async throws -> Auto {
        guard let api = connection else { throw APIError.signedOut }
        struct Body: Encodable { let words: [CapWord]; let style: CapStyle; let width: Double; let height: Double }
        return try await api.call("/api/captions/auto", Body(words: words, style: style,
                                                             width: frame.width, height: frame.height))
    }

    private func apply(_ auto: Auto, to clip: inout CapClip) {
        clip.words = auto.words
        clip.cues = auto.cues
        clip.cadenceApplied = auto.cadenceApplied
        clip.cadenceFit = auto.cadenceFit
        clip.cadenceDirty = false
        if let message = auto.aiError { notice = "Captioned without the AI pass: \(message)" }
    }

    /// Transcribes a web clip that has no captions yet (its proxy comes down first).
    func transcribe() async {
        guard let api = connection, let clip, !busy else { return }
        do {
            var file = local?.url
            if file == nil {
                step = .fetching
                let (temporary, response) = try await API.slow.download(for: api.request("/api/projects/\(id)/clips/\(clip.id)/video"))
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                    throw APIError(status: 0, message: "Couldn't fetch the video from the server.")
                }
                let named = temporary.deletingLastPathComponent().appendingPathComponent(UUID().uuidString + ".mp4")
                try FileManager.default.moveItem(at: temporary, to: named)
                file = named
            }
            try await caption(file!)
            if local == nil { try? FileManager.default.removeItem(at: file!) }
        } catch {
            fail(error.localizedDescription)
        }
        step = nil
    }

    /// Match cadence again for the words as they are now.
    func rematch() async {
        guard var current = clip, let style = current.style, !cues.isEmpty, !busy else { return }
        step = .matching
        defer { step = nil }
        do {
            let auto = try await autoCaptions(cues.flatMap(\.words), style: style)
            current = clip ?? current
            apply(auto, to: &current)
            clip = current
            await save()
        } catch {
            fail(error.localizedDescription)
        }
    }

    // MARK: Style and text

    func choose(_ preset: CapPreset) {
        clip?.style = preset.style
        Task { await CaptionFonts.shared.load(preset.style.fontFamily) }
        relayout()
    }

    /// Any style change. Size, width and lines change where lines break:
    /// those re-lay out (sliders once they're let go, see `relayout()`).
    func restyle(relayout: Bool = false, _ change: (inout CapStyle) -> Void) {
        guard var style = clip?.style else { return }
        change(&style)
        clip?.style = style
        if relayout { self.relayout() } else { saveLater() }
    }

    func relayout() { Task { await layout(lines: nil) } }

    /// The transcript as typed: one caption per line.
    func edit(_ text: String) async {
        let lines = text.split(separator: "\n").map { $0.split(whereSeparator: \.isWhitespace).map(String.init) }
            .filter { !$0.isEmpty }
        guard lines.map({ $0.joined(separator: " ") }) != cues.map(\.text) else { return }
        await layout(lines: lines)
        // an edited grouping is his own; Match cadence offers to redo it
        if matched { clip?.cadenceDirty = true }
    }

    private func layout(lines: [[String]]?) async {
        guard let api = connection, let style = clip?.style, !cues.isEmpty else { return }
        layoutGen += 1
        let gen = layoutGen
        struct Body: Encodable {
            let words: [CapWord]
            let style: CapStyle
            let width: Double
            let height: Double
            let lines: [[String]]?
        }
        struct Answer: Decodable { let cues: [CapCue] }
        do {
            let answer: Answer = try await api.call("/api/captions/layout", Body(
                words: cues.flatMap(\.words), style: style, width: frame.width, height: frame.height, lines: lines))
            guard gen == layoutGen else { return }
            clip?.cues = answer.cues
            clip?.words = answer.cues.flatMap(\.words)
            saveLater()
        } catch {
            fail(error.localizedDescription)
        }
    }

    // MARK: Saving (`PUT /api/projects/:id/sync`, like the web's autosave)

    func saveLater() {
        saveSoon?.cancel()
        saveSoon = Task {
            try? await Task.sleep(for: .seconds(1.5))
            if !Task.isCancelled { await save() }
        }
    }

    /// One save at a time, each on the revision the last one made.
    func save() async {
        saveSoon?.cancel()
        let previous = saveChain
        let task = Task { await previous?.value; await commit() }
        saveChain = task
        await task.value
    }

    private func commit() async {
        guard let api = connection, let clip else { return }
        struct Snapshot: Encodable {
            let name: String
            let fps: Double
            let model: String
            let autoCadence: Bool
            let script: String
            let clipOrder: [String]
            let clip: CapClip
        }
        struct Body: Encodable { let baseRevision: Int; let mutationId: String; let snapshot: Snapshot }
        struct Answer: Decodable { let revision: Int }
        let snapshot = Snapshot(name: name, fps: fps, model: project?.model ?? "cloud/deepgram",
                                autoCadence: project?.autoCadence ?? true, script: project?.script ?? "",
                                clipOrder: clips.map(\.id), clip: clip)
        do {
            let answer: Answer = try await api.call("/api/projects/\(id)/sync", method: "PUT",
                                                    Body(baseRevision: revision, mutationId: UUID().uuidString, snapshot: snapshot))
            revision = answer.revision
            if let i = clips.firstIndex(where: { $0.id == clip.id }) { clips[i] = clip }
        } catch let failure as APIError where failure.status == 409 {
            // Another device saved first. Take its revision so the next save can go through,
            // and keep this phone's version: the message says the last change wasn't saved.
            if let fresh: CapProject = try? await api.get("/api/projects/\(id)") { revision = fresh.revision }
            fail("This project changed on another device, so your last change wasn't saved. Save again to keep this version, or check the website first.")
        } catch {
            fail("Not saved: \(error.localizedDescription)")
        }
    }

    // MARK: Export

    private struct Job: Decodable {
        let id: String
        let status: RenderStatus
        let progress: Double
        let error: String?
        let filename: String
    }

    /// A render job's state. Anything the server adds later reads as `unknown`, which ends the wait.
    enum RenderStatus: String, Decodable {
        case queued, running, done, unknown

        init(from decoder: Decoder) throws {
            let raw = try decoder.singleValueContainer().decode(String.self)
            self = RenderStatus(rawValue: raw) ?? .unknown
        }
    }

    /// A render that hasn't finished by then is reported, not waited on forever.
    private static let renderTimeout: TimeInterval = 15 * 60

    /// The captioned MP4 rendered on the server (the web's pixel-perfect
    /// render), then into Photos, or to Finals (admins).
    func export(toFinals: Bool) async {
        guard let api = connection, let clip, let style = clip.style, !cues.isEmpty, !busy else { return }
        guard hasOriginal else {
            return fail(uploading != nil ? "Still uploading the video. Export once it's up." : "The video isn't on the server yet.")
        }
        exporting = "Starting…"
        defer { exporting = nil }
        await save()
        let seconds = (clip.duration ?? 0) > 0 ? clip.duration! : (player?.currentItem?.duration.seconds ?? 0)
        struct Spec: Encodable {
            let width: Int
            let height: Int
            let cues: [CapCue]
            let style: CapStyle
            let posSegments: JSONValue
            let texts: JSONValue
        }
        struct Body: Encodable {
            let kind = "burn"
            let engine = "wysiwyg"
            let format = "h264"
            let renderSpec: Spec
            let name: String
            let duration: Double
            let projectId: String
            let clipId: String
            let width: Int
            let height: Int
            let fps: Double
            let finals: Bool?
        }
        let w = Int(frame.width), h = Int(frame.height)
        do {
            var job: Job = try await api.call("/api/exports", Body(
                renderSpec: Spec(width: w, height: h, cues: cues, style: style,
                                 posSegments: clip.posSegments ?? .array([]), texts: clip.texts ?? .array([])),
                name: name, duration: seconds, projectId: id, clipId: clip.id, width: w, height: h, fps: fps,
                finals: toFinals ? true : nil))
            let deadline = Date().addingTimeInterval(Self.renderTimeout)
            while job.status == .queued || job.status == .running {
                guard Date() < deadline else {
                    throw APIError(status: 0, message: "The render is taking too long. Check the project on the website before trying again.")
                }
                exporting = job.status == .queued ? "Waiting to render…" : "Rendering \(Int(job.progress * 100))%"
                try await Task.sleep(for: .seconds(2))
                job = try await api.get("/api/exports/\(job.id)")
            }
            guard job.status == .done else {
                throw APIError(status: 0, message: job.error ?? "The render failed.")
            }
            if toFinals {
                notice = "Rendered. It's on its way to Finals."
            } else {
                exporting = "Saving to Photos…"
                try await api.saveToPhotos("/api/exports/\(job.id)/file", filename: job.filename)
                notice = "Saved to Photos."
            }
        } catch {
            fail(error.localizedDescription)
        }
    }

    /// Shows an error. Doesn't touch `step`: the operation that set it clears it.
    private func fail(_ message: String) {
        error = message
    }
}
