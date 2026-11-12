import Foundation
import SwiftUI

/// The in-app assistant's conversation as the server sends it (`GET /api/assistant`, the web's
/// `contracts/assistant.ts`). It is the same conversation on every device of the account:
/// one open chat, earlier ones behind it. Every field the server may leave out is optional, and
/// a word it adds later reads as "unknown" instead of breaking the chat.
struct AssistantView: Decodable, Equatable {
    var id: String
    /// "none" = no AI is connected yet, so the assistant can't answer.
    var provider: String
    var aiName: String
    var messages: [AssistantMessage]
    var past: [AssistantPast]
    /// A page the assistant opened for the person; the first screen that reads it goes there and says so.
    var navigate: String?
    /// The server takes a message whose videos are still going up, and messages while a reply is being
    /// written: it holds each reply until its turn. An older server sends nothing.
    var sendNow: Bool
    /// The reply starts at once and the videos go on up after it ends (a message sent with `later`). An older
    /// server sends nothing: it holds the reply until they are in, and a reply that ended (stopped) needs them no more.
    var videosLater: Bool

    enum CodingKeys: String, CodingKey { case id, provider, aiName, messages, past, navigate, sendNow, videosLater }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        provider = (try? c.decode(String.self, forKey: .provider)) ?? "none"
        aiName = (try? c.decode(String.self, forKey: .aiName)) ?? ""
        messages = (try? c.decode([AssistantMessage].self, forKey: .messages)) ?? []
        past = (try? c.decode([AssistantPast].self, forKey: .past)) ?? []
        navigate = try? c.decodeIfPresent(String.self, forKey: .navigate)
        sendNow = (try? c.decode(Bool.self, forKey: .sendNow)) ?? false
        videosLater = (try? c.decode(Bool.self, forKey: .videosLater)) ?? false
    }

    var connected: Bool { provider != "none" }
    /// The reply being written; when none is, the first one that waits (for its videos, or its turn).
    /// It is the one a Stop without a name stops.
    var thinking: AssistantMessage? {
        let open = messages.filter { $0.role == "assistant" && $0.status == "thinking" }
        return open.first { $0.wait == nil } ?? open.first
    }

    /// When the message a reply answers was written: the one before it.
    func asked(_ reply: AssistantMessage) -> Double? {
        guard let index = messages.firstIndex(where: { $0.id == reply.id }) else { return nil }
        return messages[..<index].last { $0.role == "user" }?.at
    }
}

struct AssistantMessage: Decodable, Equatable, Identifiable {
    var id: String
    /// "user", "assistant", or "note" (something the app recorded).
    var role: String
    var text: String
    /// Milliseconds since 1970.
    var at: Double
    /// An assistant reply: "thinking" until it is "done" or "error".
    var status: String?
    var steps: [String]?
    var work: [AssistantWork]?
    var approvals: [AssistantApproval]?
    /// Questions the reply put before deleting, publishing or sending something: Yes or No each.
    var confirms: [AssistantConfirm]?
    var media: [AssistantMedia]?
    /// Answers offered as buttons; a press sends that one as the person's message.
    var choices: [String]?
    var images: [Named]?
    var pasted: [String]?
    var files: [Named]?
    var quote: String?
    /// A reply that has not started: what it waits for ("Waiting for 2 videos to upload"). A newer server sends it.
    var wait: Wait?
    /// Folders dropped in the Mac app with the message: their paths on the computer.
    var folders: [String]?
    /// A scheduled task's run: its prompt, posted as the person's message.
    var task: Named?

    struct Named: Decodable, Equatable, Identifiable {
        var id: String
        var name: String
        /// A video of his message not all in yet (a newer server).
        var uploading: Bool?
    }

    struct Wait: Decodable, Equatable {
        var text: String?
    }
}

/// One thing a reply started or opened, as a card. `href` is a page of the website
/// ("/workshop/sessions/<id>") or, for kind "link", a full address.
struct AssistantWork: Decodable, Equatable, Identifiable {
    var id: String
    var kind: String
    var title: String
    var href: String
    /// "running", "done" or "failed".
    var status: String
    var detail: String?
}

/// A video shown in the chat: `src` plays it with the sign-in, `href` is the page that opens it.
struct AssistantMedia: Decodable, Equatable, Identifiable {
    var id: String
    var title: String
    var src: String
    var poster: String?
    var href: String
    var duration: Double?
}

/// One thing the assistant asked to do on the person's Mac: Allow or Deny, within ten minutes.
struct AssistantApproval: Decodable, Equatable, Identifiable {
    var id: String
    var summary: String
    var detail: String
    var at: Double
    /// "waiting", "allowed", "denied" or "expired".
    var status: String
}

/// A question the assistant put before a tool deleted, published or sent something. Yes does it
/// and the card then says how it went; No drops it. A newer server sends these, so every field
/// may be missing.
struct AssistantConfirm: Decodable, Equatable, Identifiable {
    var id: String
    var question: String
    var at: Double
    /// "waiting", "done", "failed" or "no".
    var status: String
    /// Why it failed.
    var result: String?

    enum CodingKeys: String, CodingKey { case id, question, at, status, result }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        question = (try? c.decode(String.self, forKey: .question)) ?? ""
        at = (try? c.decode(Double.self, forKey: .at)) ?? 0
        status = (try? c.decode(String.self, forKey: .status)) ?? ""
        result = try? c.decodeIfPresent(String.self, forKey: .result)
    }
}

struct AssistantPast: Decodable, Equatable, Identifiable {
    var id: String
    var title: String
    var at: Double
    var count: Int
    /// A reply is still being written in it, or waits there (a newer server lets a new chat start meanwhile).
    var working: Bool?
}

/// How the conversation reaches its server: the signed-in one. A test stands its own in.
struct AssistantServer {
    /// Where this account's waiting messages are kept; nil keeps nothing.
    var queue: URL?
    /// One call (path, method, JSON body): the answer's body, or a `ToolsetAPI.Failure`.
    var call: (String, String, Any?) async throws -> Data
    var uploader = AssistantOutbox.Uploader(begin: AssistantUpload.begin, send: AssistantUpload.send, handOver: AssistantUpload.handOver)

    static var signedIn: AssistantServer? {
        guard let api = ToolsetAPI.current else { return nil }
        return AssistantServer(queue: AssistantOutbox.file(for: api.cacheKey)) { path, method, json in
            var request = api.request(path, method: method, json: json)
            let turn = path == "/api/assistant/turn"
            if turn { request.timeoutInterval = 120 }   // six pictures on a slow connection
            return try await api.data(request, session: turn ? ToolsetAPI.slow : ToolsetAPI.session)
        }
    }
}

/// The one assistant conversation of the signed-in account, shared by the chat screen and the
/// Chats list. It shows its last copy at once, reads it again when the server says it changed
/// (`/api/sync/events`, topic "assistant"), and while a reply is being written. It also sends
/// what the person wrote: a message that can't go yet (its videos still going up, a reply being
/// written, no connection) waits in `outbox` and goes by itself.
@MainActor
final class AssistantModel: ObservableObject {
    static let shared = AssistantModel()

    @Published private(set) var view: AssistantView?
    @Published var error: String?
    /// The last read got no answer: the phone has no connection, or the computer is off.
    @Published private(set) var offline = false
    /// Messages written on the phone that have not gone yet.
    let outbox = AssistantOutbox()
    /// What is in the message box: it stays while the screen is closed, and a video keeps uploading.
    let draft = AssistantDraft()
    /// The server it talks to; nil while nobody is signed in.
    var server: () -> AssistantServer? = { .signedIn }
    private var watching: Task<Void, Never>?
    private var reading: Task<Void, Never>?
    /// Replies being stopped because a video of their message failed.
    private var stopping: Set<String> = []

    init() {
        draft.changed = { [weak self] in self?.carryOn() }
        draft.handedOver = { [weak self] video, picked in
            self?.outbox.handed(video, picked)
            self?.carryOn()
        }
        #if DEBUG
        AssistantFixtures.queued.forEach(outbox.add)
        #endif
    }

    /// The server's answer, however it was got: every route of the assistant answers with the whole view.
    func take(_ data: Data) {
        guard let fresh = try? JSONDecoder().decode(AssistantView.self, from: data) else { return }
        if fresh != view { view = fresh }
        outbox.serverWaits = fresh.sendNow
        error = nil
        offline = false
        carryOn()
    }

    func load() async {
        #if DEBUG
        if let fixture = AssistantFixtures.current {
            take(Data(fixture.utf8))
            return
        }
        #endif
        guard let server = server() else { return }
        outbox.open(server.queue)
        do {
            take(try await server.call("/api/assistant", "GET", nil))
        } catch {
            offline = (error as? ToolsetAPI.Failure)?.status == 0
            if view == nil { self.error = error.localizedDescription }
        }
    }

    /// Follows the conversation for as long as the app is open: once now, then on every change the server tells of.
    func watch() {
        guard watching == nil else { return }
        watching = Task { [weak self] in
            await self?.load()
            for await event in ServerEvents.stream("/api/sync/events") {
                // "hello" comes after every reconnect: read again in case a change was missed meanwhile
                if event.name == "hello" || (event.name == "change" && event.field("topic") == "assistant") {
                    await self?.load()
                }
            }
        }
    }

    func stopWatching() {
        watching?.cancel()
        watching = nil
    }

    /// Signed out, or another computer picked: its conversation is not this one.
    func reset() {
        stopWatching()
        reading?.cancel()
        reading = nil
        outbox.open(nil)
        view = nil
        error = nil
        offline = false
    }

    // MARK: Writing

    /// The person's message: it goes now when it can, and waits its turn when a reply is being
    /// written or there is no connection.
    func send(_ message: QueuedMessage) {
        outbox.add(message)
        carryOn()
    }

    /// A message marked "Not sent" is tried again.
    func retry(_ id: String) {
        outbox.retry(id)
        carryOn()
    }

    /// A waiting message back into the box, to change it: a video half way up carries on from there
    /// when it goes again. The messages behind it go on.
    func takeBack(_ id: String) {
        guard let message = outbox.items.first(where: { $0.id == id }) else { return }
        outbox.remove(id)
        draft.putBack(message)
        if let reply = message.reply { Task { await stop(reply: reply, of: nil) } }
        carryOn()
    }

    func stop() async { await write("/api/assistant/stop") }

    /// The cross on a reply that waits (for its videos, or its turn): that one ends, his message stays in
    /// the chat, its videos go up no more, and the messages behind it go on.
    func stop(reply id: String) async { await stop(reply: id, of: nil) }

    /// A new chat; the open one moves to the earlier chats. On the computer too.
    func newChat() async { await write("/api/assistant", method: "DELETE") }

    /// A message written in the open chat that the server doesn't have yet (waiting for its turn, or not sent): it
    /// would go to whichever chat is open when it goes, so the open chat stays until it has gone. One the server
    /// already has (its videos still going up) stays in its own chat on the server, whatever is opened meanwhile.
    var unsent: Bool { outbox.items.contains { $0.reply == nil } }

    func open(past id: String) async { await write("/api/assistant/past/\(id)/open") }

    func delete(past id: String) async { await write("/api/assistant/past/\(id)", method: "DELETE") }

    /// Allow or deny something the reply asked to do on the Mac.
    func answer(approval id: String, allow: Bool) async {
        await write("/api/assistant/approvals/\(id)", json: ["allow": allow])
    }

    /// Yes or No to a question the reply put before deleting, publishing or sending something.
    func answer(confirm id: String, yes: Bool) async {
        await write("/api/assistant/confirms/\(id)", json: ["yes": yes])
    }

    /// The page the assistant opened was opened here: no other screen opens it again.
    func navigated() async { await write("/api/assistant/navigated") }

    /// One write; its answer is the whole view. A refusal leaves the view as the server has it
    /// and says why (a 404 is something already gone or finished: nothing to say).
    private func write(_ path: String, method: String = "POST", json: Any? = nil) async {
        guard !Self.pretend, let server = server() else { return }
        do {
            take(try await server.call(path, method, json))
        } catch {
            await load()
            let status = (error as? ToolsetAPI.Failure)?.status ?? 0
            if status != 404, status != 0 { self.error = error.localizedDescription }
        }
    }

    // MARK: The queue

    /// A debug build shown an embedded conversation writes nothing to the server.
    private static var pretend: Bool {
        #if DEBUG
        return AssistantFixtures.current != nil
        #else
        return false
        #endif
    }

    /// A reply is being written, or a message waits to go: read again every few seconds,
    /// in case the server's change line is down. A video that stopped for want of a connection
    /// starts again on these.
    private var expecting: Bool { view?.thinking != nil || outbox.waiting }

    /// After every answer and every new message: videos go up whatever the assistant is doing, the
    /// oldest waiting message goes when it is ready and the assistant is free, and the chat is read
    /// again while something is expected. A video up may let a message go: that comes back here.
    private func carryOn() {
        if !Self.pretend, let server = server() {
            // first what is over, so the video after a dropped one starts now and not at the next read
            if let view { release(view) }
            outbox.upload(server.uploader) { [weak self] in self?.carryOn() }
        }
        // a server that waits for videos takes a message while a reply is being written too
        if !Self.pretend, let view, view.connected, outbox.serverWaits || view.thinking == nil, outbox.waiting {
            Task {
                let outcome = await outbox.drain { [weak self] in await self?.post($0) ?? .later }
                // it went, or is out of the way: the next goes at once (never after "later": that would spin)
                if let outcome, outcome != .later { carryOn() }
                keepReading()
            }
        }
        keepReading()
    }

    /// Messages the server took before their videos were up. One whose reply ended (he stopped it) needs
    /// them no more. One whose video failed has its reply stopped, so the messages behind it go on, and is
    /// the phone's again: Not sent, with Try again.
    private func release(_ view: AssistantView) {
        for message in outbox.items {
            guard let reply = message.reply else { continue }
            if message.failed != nil {
                Task { await stop(reply: reply, of: message.id) }
            } else if !view.videosLater, let held = view.messages.first(where: { $0.id == reply }), held.status != "thinking" {
                outbox.drop(message.id)
            }
        }
    }

    /// Stops one held reply on the server; once it has ended, its message (when still here) is the phone's again.
    private func stop(reply: String, of message: String?) async {
        guard let server = server(), stopping.insert(reply).inserted else { return }
        defer { stopping.remove(reply) }
        do {
            let answer = try await server.call("/api/assistant/stop", "POST", ["reply": reply])
            if let message { outbox.detach(message) }
            take(answer)
        } catch let failure as ToolsetAPI.Failure where failure.status == 404 {
            if let message { outbox.detach(message) }   // it had ended already
        } catch {}
    }

    private func keepReading() {
        guard reading == nil, expecting else { return }
        reading = Task { [weak self] in
            while let self, !Task.isCancelled, self.expecting {
                try? await Task.sleep(for: .seconds(self.view?.thinking != nil ? 3 : 10))
                if Task.isCancelled { return }
                await self.load()
            }
            self?.reading = nil
        }
    }

    /// One message to the server. No answer, busy or a server restarting: it waits and goes later.
    /// Any other refusal (a picture it won't take, a video gone after 7 days) would never pass: not sent.
    private func post(_ message: QueuedMessage) async -> AssistantOutbox.Outcome {
        guard let server = server() else { return .later }
        // its videos are not all up: only a server that waits for them takes it, and holds its reply
        let early = !AssistantOutbox.ready(message, serverWaits: false)
        // tried before and the answer was lost on the way: if it is in the conversation, it went
        if let mark = message.triedAfter {
            let messages = view?.messages ?? []
            if let at = Self.landing(message, after: mark, in: messages) {
                if early, at + 1 < messages.count, messages[at + 1].role == "assistant" { outbox.carry(message.id, reply: messages[at + 1].id) }
                return .sent
            }
        } else {
            outbox.tried(message.id, after: view?.messages.last?.id ?? "")
        }
        do {
            let answer = try await server.call("/api/assistant/turn", "POST", Self.body(message))
            // out of the queue in the same moment it shows in the conversation: never drawn twice. One that
            // went before its videos were up stays, out of sight, for them.
            let reply = (try? JSONDecoder().decode(AssistantView.self, from: answer))?.messages.last
            if early, let reply, reply.role == "assistant" {
                outbox.carry(message.id, reply: reply.id)
            } else {
                outbox.remove(message.id)
            }
            take(answer)
            return .sent
        } catch {
            let failure = error as? ToolsetAPI.Failure
            if failure?.status != 0 { await load() }   // busy, or no AI connected: the view says which
            guard let failure, failure.status != 0, failure.status != 409, failure.status < 500 else { return .later }
            return .refused(failure.message)
        }
    }

    /// What `POST /api/assistant/turn` takes.
    nonisolated static func body(_ message: QueuedMessage, timezone: String = TimeZone.current.identifier) -> [String: Any] {
        var context: [String: Any] = ["path": "/m", "title": "iPhone app", "timezone": timezone]
        if let quote = message.quote { context["selection"] = quote }
        var body: [String: Any] = ["text": message.text, "context": context]
        if !message.images.isEmpty {
            body["images"] = message.images.map { ["name": $0.name, "type": "image/jpeg", "data": $0.jpeg.base64EncodedString()] }
        }
        // a video still going up is named by the id the server gave it
        let files = message.files.map(\.id) + (message.videos ?? []).compactMap(\.file)
        if !files.isEmpty { body["files"] = files }
        // its videos keep going up after the reply ends: a server that knows this starts the reply at once
        if message.videos?.isEmpty == false { body["later"] = true }
        return body
    }

    /// Whether the message already stands in the conversation after the message that was its last when it was first tried.
    nonisolated static func landed(_ message: QueuedMessage, after mark: String, in messages: [AssistantMessage]) -> Bool {
        landing(message, after: mark, in: messages) != nil
    }

    /// Where it stands in the conversation, when it does.
    nonisolated static func landing(_ message: QueuedMessage, after mark: String, in messages: [AssistantMessage]) -> Int? {
        let from: Int
        if mark.isEmpty {
            from = 0
        } else if let index = messages.firstIndex(where: { $0.id == mark }) {
            from = index + 1
        } else {
            return nil   // another chat by now: send it
        }
        return messages[from...].firstIndex {
            $0.role == "user" && $0.text == message.text && ($0.images?.count ?? 0) == message.images.count
        }
    }
}
