// A Media Library transcript made on this Mac with a speech model it has (contracts/devices.ts TRANSCRIBE_KIND,
// api/lib/computer-transcribe.ts). The step reaches this Mac the way a cut-out does (Relay.swift); its claim also says
// which models this Mac has and is downloading, and its answer which ones its owner wants on it (Dictation/SpeechModels.swift).
// Then, with the device token:
//   GET  /api/devices/relay/transcribe/:id        the audio: WAV, 16 kHz mono 16-bit
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

/// One transcript step, from fetching the audio to sending the words or why not. Runs on the caller's thread.
struct TranscribeJob {
    let api: DeviceAPI
    let step: EditorJob
    let speech: SpeechLink

    func run() -> (end: CardJob.End, more: Bool) {
        let base = "/api/devices/relay/transcribe/\(step.id)"
        let why: String
        do {
            let audio = try api.get(base, tries: 2, timeout: 600)
            if audio.status == 401 { return (.gone, false) }
            guard audio.status == 200 else { throw TranscribeRefused(why: "The recording could not be read from the server (HTTP \(audio.status)).") }
            let samples = try WAVReader.samples(audio.data)
            let heard = try speech.transcribe(step.model ?? "", step.languages, samples, step.soon)
            let reply = try api.call("POST", base, Self.body(heard.words, language: heard.language), tries: 3, timeout: 300)
            if reply.status == 200 { return (.done, RelayRunner.editorWaits(reply.data)) }
            // no longer this Mac's (it took too long, or the Mac was removed): nothing more to say
            if reply.status == 404 || reply.status == 401 { return (.gone, false) }
            throw TranscribeRefused(why: "The server refused the words (HTTP \(reply.status)).")
        } catch let refused as TranscribeRefused {
            why = refused.why
        } catch {
            why = "This Mac could not transcribe it: \(error.localizedDescription)."
        }
        let reply = try? api.call("POST", "\(base)/fail", ["error": String(why.prefix(500))], tries: 4)
        return (.failed(why), reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
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
                    let count = (min(size, raw.count - body)) / 2
                    return (0..<count).map { Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: body + $0 * 2, as: Int16.self))) / 32768 }
                }
                at = body + size + (size & 1)
            }
            throw wrong
        }
    }
}
