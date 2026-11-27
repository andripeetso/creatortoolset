// A Media Library transcript made on this Mac with a speech model it has (contracts/devices.ts TRANSCRIBE_KIND,
// api/lib/computer-transcribe.ts). The step reaches this Mac the way a cut-out does (Relay.swift); its claim also says
// which models this Mac has and is downloading, and its answer which ones its owner wants on it (Dictation/SpeechModels.swift).
// Then, with the device token:
//   GET  /api/devices/relay/transcribe/:id        the audio: WAV, 16 kHz mono 16-bit
//   or, for a Media Library file (the job's options: version, path + bytes where it is on this Mac, proxy: the server's
//   proxy's bytes), the sound is cut here from this Mac's own copy, so the server decodes none (api/library/transcribe.ts
//   ownSound): the file itself, else its proxy in the worker's proxy cache, else the server's proxy downloaded there:
//   GET  /api/devices/relay/transcribe/:id/proxy  the proxy (never the original)
//   POST /api/devices/relay/transcribe/:id        { words: [{ text, start, end }], language } (seconds; ISO 639-1 or null)
//   or   /api/devices/relay/transcribe/:id/fail   { error } with a reason a person can read
// While it runs, the long poll goes on, which keeps this Mac online; that is the step's heartbeat.
import Foundation

/// The step kind this Mac lists for a transcript (contracts/devices.ts TRANSCRIBE_KIND).
let transcribeKind = "transcribe"

/// This Mac's speech models as the relay sees them (Dictation/SpeechModels.swift `link`); tests give their own.
struct SpeechLink {
    /// The claim's model fields: `models` (it has), `getting` (downloading), `asked` (got on this Mac itself).
    var claim: () -> [String: Any]
    /// The server answered a claim that carried `sent` with the models its owner wants here. True when this Mac changed
    /// something at once (then it claims again, so the server sees it).
    var answered: (_ sent: [String: Any], _ wanted: [String]) -> Bool
    /// The words in 16 kHz mono samples, heard by `model` (a model this Mac has) among `languages` (none: any). `soon`:
    /// someone waits on it (the mic), so only a model already loaded hears it.
    var transcribe: (_ model: String, _ languages: [String], _ samples: [Float], _ soon: Bool) throws -> (words: [HeardWord], language: String?)
}

/// Why a transcript can't be made, in words for the person.
struct TranscribeRefused: Error, Equatable {
    let why: String
}

/// The job is no longer this Mac's: nothing more to say.
private struct TranscribeGone: Error {}

/// One transcript step, from fetching the audio to sending the words or why not. Runs on the caller's thread.
struct TranscribeJob {
    let api: DeviceAPI
    let step: EditorJob
    let speech: SpeechLink
    /// the worker's proxy cache for this server (Worker.swift's data folder, api/work/cache.ts): read, and filled
    var proxies: URL? = nil
    var ffmpeg: URL? = HelperCheckJob.ffmpeg
    /// the folders the person gave this app (MediaFiles.swift): a file outside them is never read
    var granted: [String] = []

    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/transcribe/\(step.id)"
        let why: String
        do {
            let samples: [Float]
            if let ffmpeg, FileManager.default.isExecutableFile(atPath: ffmpeg.path), let src = try ownCopy(base) {
                samples = try Self.cut(ffmpeg: ffmpeg, src)
            } else {
                let audio = try api.get(base, tries: 2, timeout: 600)
                if audio.status == 401 { return (.gone, false) }
                guard audio.status == 200 else { throw TranscribeRefused(why: "The recording could not be read from the server (HTTP \(audio.status)).") }
                samples = try WAVReader.samples(audio.data)
            }
            let heard = try speech.transcribe(step.model ?? "", step.languages, samples, step.soon)
            let reply = try api.call("POST", base, Self.body(heard.words, language: heard.language), tries: 3, timeout: 300)
            if reply.status == 200 { return (.done, RelayRunner.editorWaits(reply.data)) }
            // no longer this Mac's (it took too long, or the Mac was removed): nothing more to say
            if reply.status == 404 || reply.status == 401 { return (.gone, false) }
            throw TranscribeRefused(why: "The server refused the words (HTTP \(reply.status)).")
        } catch is TranscribeGone {
            return (.gone, false)
        } catch let refused as TranscribeRefused {
            why = refused.why
        } catch {
            why = "This Mac could not transcribe it: \(error.localizedDescription)."
        }
        let reply = try? api.call("POST", "\(base)/fail", ["error": String(why.prefix(500))], tries: 4)
        return (.failed(why), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }

    /// The Media Library file to cut the sound from, in the order the worker reads files (api/work/files.ts): the file
    /// itself where the server says it is on this Mac (same size, in a folder the person gave this app), its proxy in the
    /// cache, else the server's proxy downloaded into the cache. Nil when the job names no file or the server has no proxy
    /// of one that is not here: the server's audio then. Never the original from the server.
    // ponytail: a moved original is found by Locate, not by a fingerprint search here; download without Cancel or Range resume
    func ownCopy(_ base: String) throws -> URL? {
        let o = step.options
        guard let version = o["version"], version.range(of: "^[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil else { return nil }
        if let path = o["path"], let bytes = Int64(o["bytes"] ?? ""), case .file(let real, _) = MediaFiles.gate(path, granted: granted), Self.size(real) == bytes {
            return URL(fileURLWithPath: real)
        }
        guard let proxies, let want = Int64(o["proxy"] ?? "") else { return nil }
        let cached = proxies.appendingPathComponent("\(version).mp4")
        if let have = Self.size(cached.path), want == 0 || have == want { return cached }
        try FileManager.default.createDirectory(at: proxies, withIntermediateDirectories: true)
        let part = proxies.appendingPathComponent("\(version).mp4.part")
        let status = try api.download("\(base)/proxy", to: part, timeout: 1800)
        if status == 401 || status == 404 { throw TranscribeGone() }
        guard status == 200, want == 0 || Self.size(part.path) == want else {
            try? FileManager.default.removeItem(at: part)
            throw TranscribeRefused(why: "The proxy could not be downloaded from the server (HTTP \(status)).")
        }
        try? FileManager.default.removeItem(at: cached)
        try FileManager.default.moveItem(at: part, to: cached)
        return cached
    }

    /// The sound of `src` as 16 kHz mono samples, cut with the server's own arguments (api/library/transcribe.ts
    /// soundArgs: ffmpeg's own pick of the sound tracks, as from the proxy or the original), so the words are the same.
    static func cut(ffmpeg: URL, _ src: URL) throws -> [Float] {
        do {
            return WAVReader.pcm16(try LookSheets.run(ffmpeg, ["-i", src.path, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"]))
        } catch let failed as LibraryLookRefused {
            throw TranscribeRefused(why: failed.why.replacingOccurrences(of: "ffmpeg could not make the sheet", with: "This Mac could not read the sound of \(src.lastPathComponent)"))
        }
    }

    static func size(_ path: String) -> Int64? {
        ((try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? NSNumber)?.int64Value
    }

    /// What the server takes (contracts/devices.ts parseTranscribeResult): Whisper's sound marks ([MUSIC]) and empty
    /// words left out, times finite, never negative and never ending before they start.
    static func body(_ words: [HeardWord], language: String?) -> [String: Any] {
        let kept: [[String: Any]] = words.compactMap { w in
            let text = WhisperKitTranscriber.sanitize(w.text)
            guard !text.isEmpty, w.start.isFinite, w.end.isFinite else { return nil }
            let start = max(0, w.start)
            return ["text": String(text.prefix(100)), "start": start, "end": max(start, w.end)]
        }
        let code = language.flatMap { $0.range(of: "^[a-z]{2,3}$", options: .regularExpression) != nil ? $0 : nil }
        return ["words": kept, "language": code ?? NSNull()]
    }
}

/// The server's audio as samples: a WAV of 16 kHz mono 16-bit PCM, its chunks found wherever they are.
enum WAVReader {
    static func samples(_ data: Data) throws -> [Float] {
        let wrong = TranscribeRefused(why: "The recording from the server is not a 16 kHz mono 16-bit WAV.")
        return try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> [Float] in
            func u32(_ at: Int) -> Int { Int(UInt32(littleEndian: raw.loadUnaligned(fromByteOffset: at, as: UInt32.self))) }
            func u16(_ at: Int) -> Int { Int(UInt16(littleEndian: raw.loadUnaligned(fromByteOffset: at, as: UInt16.self))) }
            func tag(_ at: Int) -> String { String(decoding: raw[at..<at + 4], as: UTF8.self) }
            guard raw.count >= 12, tag(0) == "RIFF", tag(8) == "WAVE" else { throw wrong }
            var at = 12
            var format = false
            while at + 8 <= raw.count {
                let size = u32(at + 4)
                let body = at + 8
                if tag(at) == "fmt " {
                    guard body + 16 <= raw.count, u16(body) == 1, u16(body + 2) == 1, u32(body + 4) == 16000, u16(body + 14) == 16 else { throw wrong }
                    format = true
                } else if tag(at) == "data" {
                    guard format else { throw wrong }
                    // a length past the end (a recording written as it streamed) reads what is there
                    return pcm16(data.subdata(in: data.startIndex + body..<data.startIndex + body + min(size, raw.count - body)))
                }
                at = body + size + (size & 1)
            }
            throw wrong
        }
    }

    /// 16-bit little-endian samples as floats in -1…1.
    static func pcm16(_ data: Data) -> [Float] {
        data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            (0..<raw.count / 2).map { Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: $0 * 2, as: Int16.self))) / 32768 }
        }
    }
}
