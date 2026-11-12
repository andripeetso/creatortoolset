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

    enum CodingKeys: String, CodingKey { case id, provider, aiName, messages, past, navigate }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = (try? c.decode(String.self, forKey: .id)) ?? ""
        provider = (try? c.decode(String.self, forKey: .provider)) ?? "none"
        aiName = (try? c.decode(String.self, forKey: .aiName)) ?? ""
        messages = (try? c.decode([AssistantMessage].self, forKey: .messages)) ?? []
        past = (try? c.decode([AssistantPast].self, forKey: .past)) ?? []
        navigate = try? c.decodeIfPresent(String.self, forKey: .navigate)
    }

    var connected: Bool { provider != "none" }
    /// The reply being written, if one is.
    var thinking: AssistantMessage? { messages.last { $0.role == "assistant" && $0.status == "thinking" } }
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
    /// Folders dropped in the Mac app with the message: their paths on the computer.
    var folders: [String]?
    /// A scheduled task's run: its prompt, posted as the person's message.
    var task: Named?

    struct Named: Decodable, Equatable, Identifiable {
        var id: String
        var name: String
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
}

/// The one assistant conversation of the signed-in account, shared by the chat screen and the
/// Chats list. It shows its last copy at once, reads it again when the server says it changed
/// (`/api/sync/events`, topic "assistant"), and while a reply is being written. It also sends
/// what the person wrote: a message that can't go yet waits in `outbox` and goes by itself.
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
    private var watching: Task<Void, Never>?
    private var reading: Task<Void, Never>?

    init() {
        #if DEBUG
        AssistantFixtures.queued.forEach(outbox.add)
        #endif
    }

    /// The server's answer, however it was got: every route of the assistant answers with the whole view.
    func take(_ data: Data) {
        guard let fresh = try? JSONDecoder().decode(AssistantView.self, from: data) else { return }
        if fresh != view { view = fresh }
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
        guard let api = ToolsetAPI.current else { return }
        outbox.open(AssistantOutbox.file(for: api.cacheKey))
        do {
            take(try await api.data(api.request("/api/assistant")))
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

    func stop() async { await write("/api/assistant/stop") }

    /// A new chat; the open one moves to the earlier chats. On the computer too.
    func newChat() async { await write("/api/assistant", method: "DELETE") }

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
        guard !Self.pretend, let api = ToolsetAPI.current else { return }
        do {
            take(try await api.send(path, method: method, json: json))
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
    /// in case the server's change line is down.
    private var expecting: Bool { view?.thinking != nil || outbox.waiting }

    /// After every answer and every new message: send the oldest waiting message when the
    /// assistant is free, and keep reading while something is expected.
    private func carryOn() {
        if !Self.pretend, let view, view.connected, view.thinking == nil, outbox.waiting {
            Task {
                let outcome = await outbox.drain { [weak self] in await self?.post($0) ?? .later }
                // a refused one is out of the way: the next goes at once (never after "later": that would spin)
                if case .refused = outcome { carryOn() }
                keepReading()
            }
        }
        keepReading()
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
        guard let api = ToolsetAPI.current else { return .later }
        // tried before and the answer was lost on the way: if it is in the conversation, it went
        if let mark = message.triedAfter {
            if Self.landed(message, after: mark, in: view?.messages ?? []) { return .sent }
        } else {
            outbox.tried(message.id, after: view?.messages.last?.id ?? "")
        }
        var request = api.request("/api/assistant/turn", method: "POST", json: Self.body(message))
        request.timeoutInterval = 120   // six pictures on a slow connection
        do {
            let answer = try await api.data(request, session: ToolsetAPI.slow)
            // out of the queue in the same moment it shows in the conversation: never drawn twice
            outbox.remove(message.id)
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
        if !message.files.isEmpty { body["files"] = message.files.map(\.id) }
        return body
    }

    /// Whether the message already stands in the conversation after the message that was its last when it was first tried.
    nonisolated static func landed(_ message: QueuedMessage, after mark: String, in messages: [AssistantMessage]) -> Bool {
        let from: Int
        if mark.isEmpty {
            from = 0
        } else if let index = messages.firstIndex(where: { $0.id == mark }) {
            from = index + 1
        } else {
            return false   // another chat by now: send it
        }
        return messages[from...].contains {
            $0.role == "user" && $0.text == message.text && ($0.images?.count ?? 0) == message.images.count
        }
    }
}
