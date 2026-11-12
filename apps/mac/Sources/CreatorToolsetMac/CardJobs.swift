// Drawing an edit's cards for the server. The server queues a `cards-draw` step for a Mac of the edit's own account;
// this Mac takes it (Relay.swift), reads the cards, draws each one in the kit's page (KitRunner.swift: no network, no
// files, no way off its page, 20 s a card) and sends a clip and three stills per card. With the device token:
//   POST /api/devices/relay/wait   the long poll this Mac already holds says which kinds it would take now,
//        `editor: ["cards-draw"]`, and a server with such a step queued answers that poll `{ "editor": true }`.
//        Only then, never on a clock:
//   POST /api/devices/relay/editor/claim { kinds: ["cards-draw"] } → { job: { id, kind, … } | null }
//   GET  /api/devices/relay/editor/job/:id/cards → { width, height, fps, script, cards: [{ id, seconds, content }] }
//   POST /api/devices/relay/editor/job/:id/cards/:cardId   multipart: `clip` (H.264 .mp4, no sound) and `still` three
//        times (PNG, 540 px wide: the first, the middle and the last frame, in that order)
//   then the step's own /done, or /fail { error } with a reason a person can read; /beat every 15 s while it works.
//   An answer to /done or /fail that carries `editor: true` says another step waits: it is claimed at once.
// Every card that drew is sent. One that did not fails the step (the server tries a failed step again, so a card's
// id can arrive more than once).
import Foundation

/// The editor step kind this Mac declares when it claims (contracts/devices.ts).
let cardsKind = "cards-draw"

/// A step the server handed this Mac (contracts/devices.ts DeviceJob).
struct EditorJob: Equatable {
    let id: Int
    let kind: String
}

extension EditorJob {
    /// From the claim's answer, `{ job: { id, kind, … } }`. Nil when it holds no job (`job: null`).
    init?(claim data: Data) {
        guard let answer = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let job = answer["job"] as? [String: Any],
              let id = job["id"] as? Int, id > 0, let kind = job["kind"] as? String else { return nil }
        self.init(id: id, kind: kind)
    }
}

enum CardJobError: Error, Equatable {
    /// The card list can't be used; the words are for the person.
    case sheet(String)
}

/// What the server asks for: one script that draws every card of a version, and each card's length and content.
struct CardSheet {
    struct Card {
        let id: String
        let seconds: Double
        let content: [String: Any]
    }

    let width: Int
    let height: Int
    let fps: Double
    let script: String
    let cards: [Card]

    /// What one step may ask of this Mac. The server's own limits are tighter (6 cards of at most 2.4 s).
    static let maxBytes = 2_000_000
    static let maxCards = 24
    static let maxSide = 4096
    static let maxSeconds = 30.0
    static let maxFps = 120.0

    init(json data: Data) throws {
        let bad = { (why: String) in CardJobError.sheet("This edit's cards can't be drawn on this Mac: \(why).") }
        guard data.count <= Self.maxBytes else { throw bad("the list is over \(Self.maxBytes / 1_000_000) MB") }
        guard let sheet = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw bad("the server's answer is not a card list") }
        guard let width = sheet["width"] as? Int, let height = sheet["height"] as? Int,
              (16...Self.maxSide).contains(width), (16...Self.maxSide).contains(height), width % 2 == 0, height % 2 == 0
        else { throw bad("the picture size must be even numbers from 16 to \(Self.maxSide)") }
        guard let fps = sheet["fps"] as? Double, fps >= 1, fps <= Self.maxFps else { throw bad("the frame rate must be from 1 to \(Int(Self.maxFps))") }
        guard let script = sheet["script"] as? String, !script.isEmpty else { throw bad("there is no script") }
        guard let list = sheet["cards"] as? [[String: Any]], !list.isEmpty, list.count <= Self.maxCards
        else { throw bad("it takes 1 to \(Self.maxCards) cards at a time") }
        self.width = width
        self.height = height
        self.fps = fps
        self.script = script
        cards = try list.map { card in
            guard let id = (card["id"] as? String) ?? (card["id"] as? Int).map(String.init), !id.isEmpty, id.count <= 100
            else { throw bad("a card has no id") }
            guard let seconds = card["seconds"] as? Double, seconds > 0, seconds <= Self.maxSeconds
            else { throw bad("a card's length must be up to \(Int(Self.maxSeconds)) seconds") }
            return Card(id: id, seconds: seconds, content: card["content"] as? [String: Any] ?? [:])
        }
    }
}

/// One file of a multipart form.
struct FormPart {
    let name: String
    let filename: String
    let type: String
    let data: Data
}

/// The body of a multipart/form-data request with these files, for `Content-Type: multipart/form-data; boundary=…`.
func multipartBody(_ parts: [FormPart], boundary: String) -> Data {
    var body = Data()
    for part in parts {
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(part.name)\"; filename=\"\(part.filename)\"\r\nContent-Type: \(part.type)\r\n\r\n".utf8))
        body.append(part.data)
        body.append(Data("\r\n".utf8))
    }
    body.append(Data("--\(boundary)--\r\n".utf8))
    return body
}

/// Why a card has no clip, as the end of "Card 2 of 6 …".
func cardFailure(_ error: Error, limit: TimeInterval) -> String {
    switch error {
    case KitRunnerError.timedOut: return "took longer than \(Int(limit)) seconds to draw."
    case KitRunnerError.badCard(let why): return "has a script that failed (\(why.prefix(200)))."
    case KitRunnerError.blank: return "drew nothing."
    case KitRunnerError.ended: return "made its page stop (it crashed, or took too much memory)."
    case KitRunnerError.loadFailed(let why), CardClipError.writer(let why): return "could not be made into a clip (\(why.prefix(200)))."
    default: return "could not be made into a clip (\(error.localizedDescription.prefix(200)))."
    }
}

/// Draws one card: its clip at `clip`, and its three stills as PNG. Throws with nothing left at `clip`.
@MainActor
func drawCard(_ card: KitCard, clip: URL, limit: TimeInterval) async throws -> [Data] {
    let writer = try CardClipWriter(to: clip, width: card.width, height: card.height, fps: card.fps)
    let wanted = CardStill.frames(of: card.frameCount)
    var stills: [Int: (data: Data, blank: Bool)] = [:]
    do {
        try await KitRunner.draw(card, limit: limit) { index, image in
            try await writer.append(image, index: index)
            if wanted.contains(index) { stills[index] = try CardStill.png(image, cardWidth: card.width, cardHeight: card.height) }
        }
        let three = wanted.compactMap { stills[$0] }
        guard three.count == wanted.count else { throw KitRunnerError.snapshotFailed }
        // a card whose first, middle and last frame are all the empty stage has nothing to show
        if three.allSatisfy(\.blank) { throw KitRunnerError.blank }
        try await writer.finish(frames: card.frameCount)
        return three.map(\.data)
    } catch {
        writer.cancel()
        throw error
    }
}

private final class Answer<T>: @unchecked Sendable {
    var value: T?
}

/// Runs async work from a plain thread and waits for its answer. Never on the main thread: the drawing needs it.
private func waitFor<T>(_ work: @escaping @MainActor () async -> T) -> T {
    let done = DispatchSemaphore(value: 0)
    let answer = Answer<T>()
    Task { @MainActor in
        answer.value = await work()
        done.signal()
    }
    done.wait()
    return answer.value!
}

/// Whether a step is still this Mac's, shared with the thread that keeps its lease.
private final class Lease: @unchecked Sendable {
    private let lock = NSLock()
    private var lost = false
    private var over = false
    var isLost: Bool { lock.lock(); defer { lock.unlock() }; return lost }
    var isOver: Bool { lock.lock(); defer { lock.unlock() }; return over }
    func lose() { lock.lock(); lost = true; lock.unlock() }
    func end() { lock.lock(); over = true; lock.unlock() }
}

/// One cards-draw step, from reading the cards to done or fail. Runs on the caller's thread, which is never the main one.
struct CardJob {
    enum End: Equatable {
        case done
        /// told to the server as the step's failure
        case failed(String)
        /// this Mac can't shut a card's script in, so it draws none: told to the server the same way
        case cannot(String)
        /// no longer this Mac's step (taken back, this Mac removed, the runner switched off): nothing more is sent
        case gone
    }

    let api: DeviceAPI
    let id: Int
    /// a folder of this step's own for the clip being made; it is removed when the step ends
    let folder: URL
    var limit: TimeInterval = KitRunner.cardLimit
    var beatEvery: TimeInterval = 15
    var stopped: () -> Bool = { false }

    private var base: String { "/api/devices/relay/editor/job/\(id)" }
    /// what a card's id keeps as it is in the address; every other character is percent-encoded
    static let idCharacters = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~")

    /// How the step ended, and whether the server's answer to done or fail said another step waits (`"editor": true`
    /// beside `ok`): the same hint as on the long poll, on an answer this Mac gets anyway.
    func run() -> (end: End, more: Bool) {
        let lease = Lease()
        Thread { keep(lease) }.start()
        defer {
            lease.end()
            try? FileManager.default.removeItem(at: folder)
        }
        let end = work(lease)
        var reply: DeviceReply?
        switch end {
        case .done: reply = try? api.call("POST", "\(base)/done", tries: 4)
        case .failed(let why), .cannot(let why): reply = try? api.call("POST", "\(base)/fail", ["error": String(why.prefix(500))], tries: 4)
        case .gone: break
        }
        return (end, reply.map { $0.status == 200 && RelayRunner.editorWaits($0.data) } ?? false)
    }

    /// The lease: a beat every 15 s. A blip is not a lost step; only the server saying it is no longer this Mac's is.
    private func keep(_ lease: Lease) {
        var since = 0.0
        while !lease.isOver {
            Thread.sleep(forTimeInterval: 0.2)
            since += 0.2
            guard since >= beatEvery, !lease.isOver else { continue }
            since = 0
            guard let reply = try? api.call("POST", "\(base)/beat", tries: 1, timeout: 10) else { continue }
            let held = ((try? JSONSerialization.jsonObject(with: reply.data)) as? [String: Any])?["ok"] as? Bool
            if reply.status == 401 || (reply.status == 200 && held == false) { lease.lose() }
        }
    }

    private func work(_ lease: Lease) -> End {
        let sheet: CardSheet
        do {
            let reply = try api.get("\(base)/cards", tries: 2)
            if reply.status == 401 { return .gone }
            guard reply.status == 200 else { return .failed("This edit's cards could not be read from the server (HTTP \(reply.status)).") }
            sheet = try CardSheet(json: reply.data)
        } catch CardJobError.sheet(let why) {
            return .failed(why)
        } catch {
            return .failed("This edit's cards could not be read from the server: \(error.localizedDescription).")
        }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var failed: [String] = []
        for (n, card) in sheet.cards.enumerated() {
            if lease.isLost || stopped() { return .gone }
            let name = "Card \(n + 1) of \(sheet.cards.count)"
            let clip = folder.appendingPathComponent("\(n + 1).mp4")
            let kit = KitCard(kit: sheet.script, width: sheet.width, height: sheet.height, seconds: card.seconds, fps: sheet.fps, content: card.content)
            let limit = limit
            let drawn: Result<[Data], Error> = waitFor {
                do { return .success(try await drawCard(kit, clip: clip, limit: limit)) } catch { return .failure(error) }
            }
            defer { try? FileManager.default.removeItem(at: clip) }
            // this Mac can't shut a script in: none of the cards is drawn
            if case .failure(let error) = drawn, case KitRunnerError.unsafe(let why) = error { return .cannot("Cards can't be drawn on this Mac: \(why).") }
            guard case .success(let stills) = drawn, let film = try? Data(contentsOf: clip) else {
                if case .failure(let error) = drawn { failed.append("\(name) \(cardFailure(error, limit: limit))") } else { failed.append("\(name) could not be made into a clip.") }
                continue
            }
            if lease.isLost || stopped() { return .gone }
            let parts = [FormPart(name: "clip", filename: "card.mp4", type: "video/mp4", data: film)]
                + zip(["first", "middle", "last"], stills).map { FormPart(name: "still", filename: "\($0).png", type: "image/png", data: $1) }
            let safe = card.id.addingPercentEncoding(withAllowedCharacters: CardJob.idCharacters) ?? ""
            do {
                let reply = try api.upload("\(base)/cards/\(safe)", parts, tries: 3)
                if reply.status == 401 { return .gone }
                if reply.status != 200 { failed.append("\(name) could not be sent to the server (HTTP \(reply.status)).") }
            } catch {
                // the server can't be reached: the cards after this one would not arrive either
                return .failed("\(name) could not be sent to the server: \(error.localizedDescription).")
            }
        }
        return failed.isEmpty ? .done : .failed(failed.joined(separator: " "))
    }
}
