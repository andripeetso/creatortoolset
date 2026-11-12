// This Mac as a device (contracts/providers.ts): it pairs with the signed-in account once, keeps its
// device token in the Keychain, long-polls the site for jobs whose provider runs here, runs each
// with the CLI for its driver (ClaudeRun.swift) and posts the answer back. The same bodies as the Mac relay, on
// /api/devices/relay/* with `Authorization: Bearer <device token>`.
import Foundation
import Security

/// One HTTP answer: the status and its body.
struct DeviceReply {
    let status: Int
    let data: Data
}

enum DeviceError: LocalizedError {
    case network(String)
    case revoked

    var errorDescription: String? {
        switch self {
        case .network(let why): return "the site can't be reached (\(why))"
        case .revoked: return "this Mac was removed from the account"
        }
    }
}

/// The site's device routes with the device token. A 401 means the token was revoked: `onRevoked` runs once.
final class DeviceAPI {
    let base: URL
    let token: String
    var onRevoked: (() -> Void)?
    private let lock = NSLock()
    private var revokedOnce = false

    init(base: URL, token: String) {
        self.base = base
        self.token = token
    }

    /// A POST with the token. `tries` retries network blips and 5xx answers with a backoff (the Mac relay Site.call).
    func call(_ method: String = "POST", _ path: String, _ body: [String: Any]? = nil, tries: Int = 1, timeout: TimeInterval = 60) throws -> DeviceReply {
        try send(method, path, type: "application/json", body: try JSONSerialization.data(withJSONObject: body ?? [:]), tries: tries, timeout: timeout)
    }

    /// A GET with the token and no body (the cards of an editor step).
    func get(_ path: String, tries: Int = 1, timeout: TimeInterval = 60) throws -> DeviceReply {
        try send("GET", path, type: nil, body: nil, tries: tries, timeout: timeout)
    }

    /// A multipart POST with the token (a card's clip and stills).
    func upload(_ path: String, _ parts: [FormPart], tries: Int = 1, timeout: TimeInterval = 120) throws -> DeviceReply {
        let boundary = "ct-\(UUID().uuidString)"
        return try send("POST", path, type: "multipart/form-data; boundary=\(boundary)", body: multipartBody(parts, boundary: boundary), tries: tries, timeout: timeout)
    }

    private func send(_ method: String, _ path: String, type: String?, body: Data?, tries: Int, timeout: TimeInterval) throws -> DeviceReply {
        var last = "no answer"
        for attempt in 0..<max(tries, 1) {
            var request = URLRequest(url: URL(string: path, relativeTo: base) ?? base)
            request.httpMethod = method
            request.timeoutInterval = timeout
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            if let type { request.setValue(type, forHTTPHeaderField: "Content-Type") }
            request.setValue("CreatorToolsetMac/\(appVersion)", forHTTPHeaderField: "User-Agent")
            request.httpBody = body
            let answer = synchronousData(request)
            if let error = answer.error {
                last = error.localizedDescription
            } else if let code = answer.status {
                if code == 401 {
                    revoke()
                    return DeviceReply(status: code, data: answer.data)
                }
                if code < 500 || attempt == tries - 1 { return DeviceReply(status: code, data: answer.data) }
                last = "HTTP \(code)"
            }
            if attempt < tries - 1 { Thread.sleep(forTimeInterval: min(60, pow(2, Double(attempt)) * 3)) }
        }
        throw DeviceError.network(last)
    }

    private func revoke() {
        lock.lock()
        let first = !revokedOnce
        revokedOnce = true
        lock.unlock()
        if first { onRevoked?() }
    }

    private final class Box<T> {
        var value: T?
    }

    private func synchronousData(_ request: URLRequest) -> (data: Data, status: Int?, error: Error?) {
        let done = DispatchSemaphore(value: 0)
        let box = Box<(Data?, HTTPURLResponse?, Error?)>()
        URLSession.shared.dataTask(with: request) { data, response, error in
            box.value = (data, response as? HTTPURLResponse, error)
            done.signal()
        }.resume()
        done.wait()
        let (data, response, error) = box.value ?? (nil, nil, nil)
        return (data ?? Data(), response?.statusCode, error)
    }
}

/// The app's version (CFBundleShortVersionString), sent with the pairing and the User-Agent.
let appVersion = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "dev"

/// POST /api/devices's answer: the device and its token (shown once by the site; kept here).
struct PairReply: Decodable {
    struct Device: Decodable { let id: String }
    let device: Device
    let token: String
}

/// The device token in the Keychain (service com.creatortoolset.mac.device, account = the site's host)
/// and the device id in UserDefaults, per host. Nothing else is stored.
enum DeviceVault {
    static let service = AppIdentity.keychain("device")

    private static func query(_ host: String, _ service: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: host]
    }

    /// `service`: the device tokens by default; Server.swift keeps the local server's APP_SECRET under its own.
    static func token(for host: String, service: String = DeviceVault.service) -> String? {
        var q = query(host, service)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    @discardableResult
    static func save(_ token: String, for host: String, service: String = DeviceVault.service) -> Bool {
        remove(for: host, service: service)
        var item = query(host, service)
        item[kSecValueData as String] = Data(token.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    static func remove(for host: String, service: String = DeviceVault.service) {
        SecItemDelete(query(host, service) as CFDictionary)
    }

    static func deviceID(for host: String) -> String? {
        UserDefaults.standard.string(forKey: "deviceID.\(host)")
    }

    static func setDeviceID(_ id: String?, for host: String) {
        UserDefaults.standard.set(id, forKey: "deviceID.\(host)")
    }
}

/// What the menu shows about the runner.
struct AIStatus: Equatable {
    var running = 0
    var lastError: String?
    var lastDone: String?
    /// an edit's cards are being drawn here (CardJobs.swift); not an AI request, and never an AI error
    var drawing = false
}

/// The device's relay (the Mac relay serve / run / report): up to 4 jobs at once, a report at start and hourly.
/// It runs on its own threads and reports its state through `onStatus` (from those threads).
final class RelayRunner {
    /// the Mac relay SLOTS: each job is a Claude Code process, the Mac also renders.
    static let slotCount = 4
    private let api: DeviceAPI
    private let home: URL
    /// relayFolder(for:localData:): Workshop session folders and the blob cache
    private let work: URL
    private let slots = DispatchSemaphore(value: RelayRunner.slotCount)
    private let lock = NSLock()
    private var stopped = false
    private var status = AIStatus()
    /// After a hint that led to no step (another Mac took it, or the site was wrong) this Mac lists no editor kind on
    /// its long poll for a poll's own length, so a wrong site gets one claim in 25 s at most; an hour after a claim the
    /// site refused (any 4xx).
    static let quietAfterNothing: TimeInterval = 25
    static let quietAfterRefusal: TimeInterval = 3600
    /// under `lock`: the uptime before which no editor kind is listed, whether a step is running (one at a time, a card
    /// step or a cut-out), and whether this Mac found it can't shut a card's script in (it then lists only the cut-out, for good)
    private var quietUntil: TimeInterval = 0
    private var drawing = false
    private var cannotDraw = false
    private let onStatus: (AIStatus) -> Void
    private let onRevoked: () -> Void
    /// What this server may make this Mac do past the app's defaults (Consent.swift).
    private let consent: Consent

    init(base: URL, token: String, work: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser,
         prompt: @escaping ConsentPrompt = { _, _, _, _ in false },
         onStatus: @escaping (AIStatus) -> Void, onRevoked: @escaping () -> Void) {
        api = DeviceAPI(base: base, token: token)
        consent = Consent(host: [base.host, base.port.map(String.init)].compactMap { $0 }.joined(separator: ":"), prompt: prompt)
        self.home = home
        self.work = work
        self.onStatus = onStatus
        self.onRevoked = onRevoked
        api.onRevoked = { [weak self] in
            self?.stop()
            self?.onRevoked()
        }
    }

    var isStopped: Bool { lock.lock(); defer { lock.unlock() }; return stopped }

    /// Starts the report and the long poll. Turning it off is `stop`: the poll ends after its current 25 s hold.
    func start() {
        signal(SIGPIPE, SIG_IGN)
        Thread { [self] in reportLoop() }.start()
        Thread { [self] in limitsForever(api: api, home: home, stopped: { isStopped }) }.start()
        Thread { [self] in serve() }.start()
    }

    func stop() {
        lock.lock()
        stopped = true
        lock.unlock()
    }

    /// A report now (the app came to the front): a coding tool installed a minute ago shows in Settings at once.
    func reportNow() {
        DispatchQueue.global(qos: .utility).async { [self] in
            if !isStopped { _ = try? api.call("POST", "/api/devices/relay/report", macReport(home: home), tries: 1) }
        }
    }

    private func publish(_ change: (inout AIStatus) -> Void) {
        lock.lock()
        change(&status)
        let snapshot = status
        lock.unlock()
        onStatus(snapshot)
    }

    /// the Mac relay serve(): one long poll at a time, and none while every slot runs (the site's request waits or goes elsewhere).
    /// The poll is also how an editor step reaches this Mac, with no request of its own: the poll lists the kinds this
    /// Mac would take now (`editor`), and a site with such a step queued answers `{"editor": true}`; only then is the
    /// step claimed. A site that never says so is never asked.
    func serve() {
        var pollFailed = false   // a poll's error clears once a poll goes through again (the menu bar's problem dot)
        while !isStopped {
            slots.wait()
            let listed = editorKinds()
            let reply: DeviceReply
            do {
                reply = try api.call("POST", "/api/devices/relay/wait", waitBody(listing: listed), tries: 1, timeout: 60)
            } catch {
                slots.signal()
                publish { $0.lastError = "\(error.localizedDescription)" }
                pollFailed = true
                sleepUnlessStopped(15)
                continue
            }
            if pollFailed {
                pollFailed = false
                publish { $0.lastError = nil }
            }
            if reply.status == 401 {   // revoked: the callback has run
                slots.signal()
                return
            }
            if reply.status == 200, let req = RelayRequest(json: reply.data) {
                DispatchQueue.global(qos: .utility).async { [self] in job(req) }   // job() releases the slot
                continue
            }
            if reply.status == 200, Self.editorWaits(reply.data) {
                if listed?.isEmpty == false, let step = claimStep() {
                    DispatchQueue.global(qos: .utility).async { [self] in runSteps(step) }   // runSteps() releases the slot
                    continue
                }
                slots.signal()
                // a hint this poll did not ask for (it listed no kind): the site is wrong, and is never asked in a loop
                if listed?.isEmpty != false { sleepUnlessStopped(Int(Self.quietAfterNothing)) }
                continue
            }
            slots.signal()
            if reply.status == 404 {
                sleepUnlessStopped(300)   // a site without the relay yet
            } else if reply.status >= 400 {
                sleepUnlessStopped(30)
            }
            // 204: nothing waited; ask again
        }
    }

    /// The editor step kinds this Mac would take a step of right now, for the long poll's `editor` field. Nil leaves
    /// the field out: the site then keeps what it knows of this Mac and sends no hint. That is so while cards are being
    /// drawn or a picture cut out (one step at a time) and for a while after a hint that led to no step. A Mac that
    /// can't shut a card's script in lists only the cut-out, so the site stops counting on it for cards.
    func editorKinds(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> [String]? {
        lock.lock()
        defer { lock.unlock() }
        return drawing || now < quietUntil ? nil : takes
    }

    /// The kinds this Mac takes, under `lock`: a cut-out on any Mac, cards on one that can shut a card's script in.
    private var takes: [String] { cannotDraw ? [cutoutKind] : [cardsKind, cutoutKind] }

    /// The long poll's body: big files come as hashes, and the editor kinds this Mac would take now, if any are to be said.
    func waitBody(listing kinds: [String]?) -> [String: Any] {
        var body: [String: Any] = ["blobs": true]
        if let kinds { body["editor"] = kinds }
        return body
    }

    /// Whether a long poll's answer is the site's hint that an editor step of a listed kind waits: `{"editor": true}`.
    static func editorWaits(_ answer: Data) -> Bool {
        ((try? JSONSerialization.jsonObject(with: answer)) as? [String: Any])?["editor"] as? Bool == true
    }

    /// Takes the editor step a hint spoke of (serve() calls it with a free slot in hand, and only after a hint). When
    /// there is none after all, this Mac lists no kind for a while (`quietAfterNothing`), and nothing shows in the menu
    /// or the log.
    func claimStep(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> EditorJob? {
        lock.lock()
        let kinds = takes
        lock.unlock()
        let reply = try? api.call("POST", "/api/devices/relay/editor/claim", ["kinds": kinds], tries: 1, timeout: 10)
        if let reply, reply.status == 200, let step = EditorJob(claim: reply.data) {
            if kinds.contains(step.kind) {
                lock.lock()
                drawing = true
                lock.unlock()
                return step
            }
            // not a kind this Mac listed: back in the site's queue
            _ = try? api.call("POST", "/api/devices/relay/editor/job/\(step.id)/fail", ["error": "This Mac has no \(step.kind) step"], tries: 2)
        }
        let refused = reply.map { (400..<500).contains($0.status) } ?? false
        lock.lock()
        quietUntil = now + (refused ? Self.quietAfterRefusal : Self.quietAfterNothing)
        lock.unlock()
        return nil
    }

    /// One step, a card step (CardJobs.swift) or a cut-out (Cutout.swift), from reading it to done or fail, and then every
    /// further step the site says waits on its answer to that done or fail (an edit queues one step a version). It holds
    /// a slot as an AI request does, so it never runs beside four of them. A step that fails is the edit's or the
    /// caller's news, told to the site; the menu's last AI error is left alone, and only cards show as Drawing cards.
    func runSteps(_ first: EditorJob) {
        defer { slots.signal() }
        var cannot = false
        var shown = false
        var next: EditorJob? = first
        while let step = next {
            let end: CardJob.End, more: Bool
            if step.kind == cutoutKind {
                (end, more) = CutoutJob(api: api, id: step.id).run()
            } else {
                if !shown { shown = true; publish { $0.drawing = true } }
                (end, more) = CardJob(api: api, id: step.id, folder: work.appendingPathComponent("cards/\(step.id)"),
                                      stopped: { [weak self] in self?.isStopped ?? true }).run()
            }
            if case .failed(let why) = end { AppLog.write("\(step.kind == cutoutKind ? "cut-out" : "cards"): step \(step.id) failed: \(why)") }
            if case .cannot = end { cannot = true }
            // without that word from the site the next step is seen on a later poll (the one in flight listed no kind)
            next = more && !cannot && !isStopped ? claimStep() : nil
        }
        lock.lock()
        drawing = false   // the next poll lists the kind again
        // this Mac can't shut a card's script in: from now on its polls say it draws none, so another Mac gets the step
        if cannot { cannotDraw = true }
        lock.unlock()
        if shown { publish { $0.drawing = false } }
    }

    /// the Mac relay run(): one request, answered through the four routes.
    private func job(_ request: RelayRequest) {
        defer { slots.signal() }
        publish { $0.running += 1 }
        limitsOnFirstRun(driver: request.driver)   // connected: Settings → Usage shows how much of the plan is left
        var req = request
        let base = "/api/devices/relay/\(req.id)"
        do {
            req.files = try resolveBlobs(req.files, cache: work.appendingPathComponent("blobs")) { [self] sha in
                let reply = try api.call("POST", "/api/devices/relay/blob/\(sha)", tries: 2)
                guard reply.status == 200, let obj = (try? JSONSerialization.jsonObject(with: reply.data)) as? [String: Any] else { return nil }
                return obj["text"] as? String
            }
            let opts = try requestOptions(req, root: home)
            // a program, its arguments or a settings folder the server names: this Mac's own yes, asked once
            try consent.check(launchNeeds(req, opts))
            if req.asks {   // the assistant works in a folder of its own on this Mac, one per server
                let folder = assistantFolder(host: [api.base.host, api.base.port.map(String.init)].compactMap { $0 }.joined(separator: "-"), home: home)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                req.workdir = URL(fileURLWithPath: realPath(folder.path))
            }
            let cli = binary(opts.driver, home: home) ?? opts.driver
            let answer = try runAnswer(req, opts, cli: cli, work: work, send: { [self] text in
                // a blip is not a stop: the next post carries the whole text anyway
                guard let reply = try? api.call("POST", "\(base)/text", ["text": text]) else { return true }
                return reply.status != 404
            }, step: { [self] label in
                _ = try? api.call("POST", "\(base)/step", ["label": String(label.prefix(300))])
            }, ask: { [self] question in
                // answered on this Mac unless this Mac let the server's chat answer them (asked once per server)
                if !consent.chatAnswers() {
                    _ = try? api.call("POST", "\(base)/step", ["label": "Waiting for your answer on the Mac"])
                    return consent.askHere(question.description, question.detail)
                }
                // a permission question, shown in the chat until the user answers; 404 = the site no longer waits
                guard let reply = try? api.call("POST", "\(base)/ask", [
                    "ask_id": question.id, "tool": question.tool, "description": String(question.description.prefix(300)),
                    "reason": String(question.reason.prefix(300)), "detail": question.detail,
                ], timeout: 30) else { return nil }
                if reply.status == 404 { return "gone" }
                guard reply.status == 200, let obj = (try? JSONSerialization.jsonObject(with: reply.data)) as? [String: Any] else { return nil }
                return obj["status"] as? String
            })
            _ = try? api.call("POST", "\(base)/done", [
                "text": answer.text, "usage": answer.usage, "session_id": answer.session, "session_state": answer.state,
            ], tries: 4)
            publish { $0.running -= 1; $0.lastDone = doneLine(opts, answer); $0.lastError = nil }
        } catch {
            let message = (error as? ClaudeFailure)?.message ?? (error as? RelayError)?.message ?? error.localizedDescription
            var body: [String: Any] = [
                "error": String(message.prefix(2000)),
                "limit": limitFlag(req.driver, message),
                "gone": (error as? ClaudeFailure)?.gone ?? false,
            ]
            if let usage = (error as? ClaudeFailure)?.usage { body["usage"] = usage }
            _ = try? api.call("POST", "\(base)/fail", body, tries: 4)
            publish { $0.running -= 1; $0.lastError = message }
        }
    }

    private func doneLine(_ opts: RelayOptions, _ answer: ClaudeAnswer) -> String {
        let cost = number(answer.usage["cost_usd"])
        return "\(driverLabel(opts.driver)) for the site: \(Int(number(answer.usage["output"]))) tokens out, $\(String(format: "%.4f", cost)) API-equivalent"
    }

    /// the Mac relay report_forever / report: at start and then hourly. A site without the route answers 404 and the next hour tries again.
    private func reportLoop() {
        while !isStopped {
            _ = try? api.call("POST", "/api/devices/relay/report", macReport(home: home), tries: 2)
            sleepUnlessStopped(3600)
        }
    }

    private func sleepUnlessStopped(_ seconds: Int) {
        for _ in 0..<seconds where !isStopped {
            Thread.sleep(forTimeInterval: 1)
        }
    }
}

// MARK: Sign in (the provider page's Sign in button)

/// The sign-in command of each CLI the page can open in Terminal, and the variable its runs read the login folder from
/// (the same as claudeEnv / driverEnv). Grok keeps its own folder and takes none.
let signInCommands: [String: (args: [String], homeEnv: String?)] = [
    "claude": (["auth", "login"], "CLAUDE_CONFIG_DIR"),
    "codex": (["login"], "CODEX_HOME"),
    "grok": (["login"], nil),
]

/// The shell script Terminal runs for one sign-in: the home variable, then the CLI's login by its full path. The caller
/// has checked `home` (checkedHome) and `binary` (binary()). nil for a driver with no sign-in, or a home it would not take.
func signInScript(driver: String, home: String, binary: String) -> String? {
    guard let command = signInCommands[driver], binary.hasPrefix("/") else { return nil }
    var lines = ["#!/bin/zsh"]
    if !home.isEmpty {
        guard let homeEnv = command.homeEnv else { return nil }
        lines.append("export \(homeEnv)=\(shellQuote(home))")
    }
    lines.append((["exec", shellQuote(binary)] + command.args).joined(separator: " "))
    return lines.joined(separator: "\n") + "\n"
}

/// Meta's sign-in page and its code from `muse login`'s output, or nil until both are there. With no terminal, Muse Code
/// 1.4.15 prints "Open this page to sign in:", the page (the code in its address), "confirm this code matches:" and the code,
/// then waits. It ran neither `open` nor $BROWSER when tried that way (with macOS's own opener blocked, so whether it would
/// open a tab by itself was not seen). Only a page on auth.meta.com is taken.
func museLoginPage(_ output: String) -> (page: URL, code: String)? {
    let lines = output.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    guard let page = lines.lazy.compactMap({ URL(string: $0) }).first(where: { $0.scheme == "https" && $0.host == "auth.meta.com" }),
          let at = lines.firstIndex(where: { $0.lowercased().hasSuffix("this code matches:") || $0.lowercased().hasSuffix("enter this code:") }),
          at + 1 < lines.count, !lines[at + 1].isEmpty else { return nil }
    return (page, lines[at + 1])
}

/// Muse Code's sign-in with no Terminal: `muse login` runs here with no terminal, `found` gets Meta's page and the code (on
/// the reader's thread), and the login saves the sign-in itself once it is approved on that page. One at a time: a new start
/// stops the last; it is stopped after 30 minutes too (Meta's code expires before that).
final class MuseLogin {
    private var process: Process?

    func start(binary: String, found: @escaping (URL, String) -> Void) {
        if process?.isRunning == true { process?.terminate() }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binary)
        p.arguments = ["login"]
        p.environment = withBinaryOnPath(driverEnv(base: ProcessInfo.processInfo.environment), binary: binary)
        let out = Pipe()
        p.standardOutput = out
        p.standardError = out
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return AppLog.write("sign in: muse login did not start (\(error.localizedDescription))") }
        process = p
        Thread {
            var text = ""
            var told = false
            while case let chunk = out.fileHandleForReading.availableData, !chunk.isEmpty {
                text += String(decoding: chunk, as: UTF8.self)
                if !told, let got = museLoginPage(text) {
                    told = true
                    found(got.page, got.code)
                }
            }
            if !told { AppLog.write("sign in: muse login ended without a page: \(String(text.suffix(300)))") }
        }.start()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 30 * 60) { if p.isRunning { p.terminate() } }
    }
}

/// One word for a POSIX shell, in single quotes (an embedded quote is closed, escaped and reopened).
func shellQuote(_ text: String) -> String {
    "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
}
