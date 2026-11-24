// This Mac as a device (contracts/providers.ts): it pairs with the signed-in account once, keeps its
// device token in the Keychain, long-polls the site for jobs whose provider runs here, runs each
// with the CLI for its driver (ClaudeRun.swift) and posts the answer back. The same bodies as the Mac relay, on
// /api/devices/relay/* with `Authorization: Bearer <device token>`.
import CreatorToolsetShared
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

    /// A GET with the token whose body goes to `file` (a video too big to hold in memory). The status, or a network error.
    func download(_ path: String, to file: URL, timeout: TimeInterval = 600) throws -> Int {
        var request = URLRequest(url: URL(string: path, relativeTo: base) ?? base)
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("CreatorToolsetMac/\(appVersion)", forHTTPHeaderField: "User-Agent")
        let done = DispatchSemaphore(value: 0)
        let box = Box<(Int?, Error?)>()
        URLSession.shared.downloadTask(with: request) { temp, response, error in
            let status = (response as? HTTPURLResponse)?.statusCode
            if let temp, status == 200 {
                try? FileManager.default.removeItem(at: file)
                do { try FileManager.default.moveItem(at: temp, to: file) } catch { box.value = (nil, error); done.signal(); return }
            }
            box.value = (status, error)
            done.signal()
        }.resume()
        done.wait()
        if let error = box.value?.1 { throw DeviceError.network(error.localizedDescription) }
        let status = box.value?.0 ?? 0
        if status == 401 { revoke() }
        return status
    }

    /// A POST with the token whose body is `file`, streamed from disk (a covered video).
    func uploadFile(_ path: String, file: URL, type: String, timeout: TimeInterval = 1800) throws -> DeviceReply {
        var request = URLRequest(url: URL(string: path, relativeTo: base) ?? base)
        request.httpMethod = "POST"
        request.timeoutInterval = timeout
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(type, forHTTPHeaderField: "Content-Type")
        request.setValue("CreatorToolsetMac/\(appVersion)", forHTTPHeaderField: "User-Agent")
        let done = DispatchSemaphore(value: 0)
        let box = Box<(Data?, Int?, Error?)>()
        URLSession.shared.uploadTask(with: request, fromFile: file) { data, response, error in
            box.value = (data, (response as? HTTPURLResponse)?.statusCode, error)
            done.signal()
        }.resume()
        done.wait()
        if let error = box.value?.2 { throw DeviceError.network(error.localizedDescription) }
        let status = box.value?.1 ?? 0
        if status == 401 { revoke() }
        return DeviceReply(status: status, data: box.value?.0 ?? Data())
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

    /// `service`: the device tokens by default; Server.swift keeps the local server's APP_SECRET under its own.
    static func token(for host: String, service: String = DeviceVault.service) -> String? {
        KeychainItem.read(service: service, account: host).map { String(decoding: $0, as: UTF8.self) }
    }

    @discardableResult
    static func save(_ token: String, for host: String, service: String = DeviceVault.service) -> Bool {
        KeychainItem.write(Data(token.utf8), service: service, account: host, accessible: kSecAttrAccessibleAfterFirstUnlock) == errSecSuccess
    }

    static func remove(for host: String, service: String = DeviceVault.service) {
        KeychainItem.delete(service: service, account: host)
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
    /// A computer step waits for this Mac (`{"work": true}`): the app starts its worker (Worker.swift) unless one runs.
    /// Whether one was started now.
    private let onWork: () -> Bool
    /// What this server may make this Mac do past the app's defaults (Consent.swift).
    private let consent: Consent
    /// This Mac's speech models (TranscribeJob.swift); nil: it takes no transcript.
    private let speech: SpeechLink?
    /// under `lock`: the server is to hear of this Mac's models with a claim of its own (at start, after a change here)
    private var announce = false
    /// one claim at a time: one the server hinted at, and one that says what changed here
    private let claiming = NSLock()

    init(base: URL, token: String, work: URL, home: URL = FileManager.default.homeDirectoryForCurrentUser,
         prompt: @escaping ConsentPrompt = { _, _, _, _ in false }, speech: SpeechLink? = nil,
         onStatus: @escaping (AIStatus) -> Void, onRevoked: @escaping () -> Void, onWork: @escaping () -> Bool = { false }) {
        api = DeviceAPI(base: base, token: token)
        self.speech = speech
        announce = speech != nil
        consent = Consent(host: [base.host, base.port.map(String.init)].compactMap { $0 }.joined(separator: ":"), prompt: prompt)
        self.home = home
        self.work = work
        self.onStatus = onStatus
        self.onRevoked = onRevoked
        self.onWork = onWork
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
            if takeAnnounce(), let step = claimStep(hinted: false) {
                DispatchQueue.global(qos: .utility).async { [self] in runSteps(step) }   // runSteps() releases the slot
                continue
            }
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
            // a request this Mac can't read is already claimed on the site: fail it now, or the site waits 60 s for silence
            if reply.status == 200, (try? JSONSerialization.jsonObject(with: reply.data)) == nil {
                AppLog.write("relay \(api.base.host ?? ""): could not read a request (\(reply.data.count) bytes)")
                if let id = RelayRequest.id(unreadable: reply.data) {
                    _ = try? api.call("POST", "/api/devices/relay/\(id)/fail", ["error": "This Mac could not read the request"], tries: 2)
                }
            }
            // a computer step waits: the worker claims it itself. Already running (or held for an update), the hint
            // is not news, and a server that repeats it at once is asked again a little later, never in a loop
            if reply.status == 200, Self.workWaits(reply.data), !onWork(), !Self.editorWaits(reply.data) {
                slots.signal()
                sleepUnlessStopped(5)
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

    /// The kinds this Mac takes, under `lock`: a cut-out and a split on any Mac, cards on one that can shut a card's
    /// script in, a transcript with a speech model when it has the link to them.
    /// Shot descriptions of this Mac's own files need the app's ffmpeg (a build with its server).
    private var takes: [String] {
        (cannotDraw ? [] : [cardsKind]) + [cutoutKind, splitKind, faceBlurAutoKind, folderListKind, folderBrowseKind, helperCheckKind, libraryCopyKind, lookAwayKind] + (speech == nil ? [] : [transcribeKind])
            + (HelperCheckJob.ffmpeg == nil ? [] : [libraryLookKind])
    }

    private func takeAnnounce() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        let was = announce
        announce = false
        return was
    }

    /// This Mac's models changed (a download started or ended, one went): a claim says so now, so the Voice page shows
    /// it and the server stops or starts asking. While a step runs, the claim waits for the next poll.
    func modelsChanged() {
        guard speech != nil else { return }
        lock.lock()
        announce = true
        lock.unlock()
        DispatchQueue.global(qos: .utility).async { [self] in
            guard !isStopped, slots.wait(timeout: .now()) == .success else { return }
            guard takeAnnounce(), let step = claimStep(hinted: false) else { slots.signal(); return }
            runSteps(step)
        }
    }

    /// The long poll's body: big files come as hashes, and the editor kinds this Mac would take now, if any are to be said.
    func waitBody(listing kinds: [String]?) -> [String: Any] {
        // `work`: the work package version this app's worker runs (contracts/work.ts WORK_V), so the server tells this Mac
        // when one of its steps waits, before the worker ever claimed (Worker.swift)
        var body: [String: Any] = ["blobs": true, "work": Worker.packageVersion]
        if let kinds { body["editor"] = kinds }
        return body
    }

    /// Whether a long poll's answer is the site's hint that an editor step of a listed kind waits: `{"editor": true}`.
    static func editorWaits(_ answer: Data) -> Bool {
        ((try? JSONSerialization.jsonObject(with: answer)) as? [String: Any])?["editor"] as? Bool == true
    }

    /// Whether a long poll's answer says a computer step waits for this Mac: `{"work": true}`.
    static func workWaits(_ answer: Data) -> Bool {
        ((try? JSONSerialization.jsonObject(with: answer)) as? [String: Any])?["work"] as? Bool == true
    }

    /// Takes the editor step a hint spoke of (serve() calls it with a free slot in hand, and only after a hint). When
    /// there is none after all, this Mac lists no kind for a while (`quietAfterNothing`), and nothing shows in the menu
    /// or the log.
    /// `hinted` false: a claim of this Mac's own, to say what speech models it has; with no step it changes nothing, and
    /// while a step runs it is left for later.
    func claimStep(now: TimeInterval = ProcessInfo.processInfo.systemUptime, hinted: Bool = true) -> EditorJob? {
        claiming.lock()
        defer { claiming.unlock() }
        lock.lock()
        let kinds = takes
        let busy = drawing
        if !hinted && busy { announce = true }
        lock.unlock()
        if !hinted && busy { return nil }
        var reply: DeviceReply?
        // the server's wishes for its models: done, then said again (as the helper does), at most three times
        for _ in 0..<3 {
            var body: [String: Any] = ["kinds": kinds]
            let models = kinds.contains(transcribeKind) ? speech?.claim() ?? [:] : [:]
            body.merge(models) { $1 }
            // the shot description sheets this Mac keeps for the server, which answers with the ones to drop
            let looks = LibraryLookJob.kept(in: looksFolder)
            if kinds.contains(libraryLookKind) || !looks.isEmpty { body["looks"] = looks }
            reply = try? api.call("POST", "/api/devices/relay/editor/claim", body, tries: 1, timeout: 10)
            if let reply, reply.status == 200 { LibraryLookJob.drop(reply.data, in: looksFolder) }
            guard let reply, reply.status == 200, let speech, !models.isEmpty,
                  let wanted = ((try? JSONSerialization.jsonObject(with: reply.data)) as? [String: Any])?["models"] as? [String]
            else { break }
            // an older server says nothing of models: nothing here is removed
            if !speech.answered(models, wanted) || EditorJob(claim: reply.data) != nil { break }
        }
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
        guard hinted else { return nil }
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
            } else if step.kind == splitKind {
                (end, more) = SplitJob(api: api, id: step.id).run()
            } else if step.kind == transcribeKind, let speech {
                (end, more) = TranscribeJob(api: api, step: step, speech: speech, proxies: work.appendingPathComponent("work/proxies"), granted: MediaFiles.granted(server: MediaFiles.serverKey(api.base), workspace: nil)).run()
            } else if step.kind == faceBlurAutoKind {
                (end, more) = FaceBlurAutoJob(api: api, step: step, granted: MediaFiles.granted(server: MediaFiles.serverKey(api.base), workspace: nil)).run()
            } else if step.kind == lookAwayKind {
                (end, more) = LookAwayJob(api: api, step: step, proxies: work.appendingPathComponent("work/proxies"), granted: MediaFiles.granted(server: MediaFiles.serverKey(api.base), workspace: nil), stopped: { [weak self] in self?.isStopped ?? true }).run()
            } else if step.kind == folderListKind {
                (end, more) = FolderListJob(api: api, step: step).run()
            } else if step.kind == folderBrowseKind {
                (end, more) = FolderBrowseJob(api: api, step: step).run()
            } else if step.kind == helperCheckKind {
                (end, more) = HelperCheckJob(api: api, step: step, report: { [api, home] in _ = try? api.call("POST", "/api/devices/relay/report", macReport(home: home), tries: 2) }).run()
            } else if step.kind == libraryLookKind {
                startLook(step)
                (end, more) = (.done, false)
            } else if step.kind == libraryCopyKind {
                startCopy(step)
                (end, more) = (.done, false)
            } else {
                if !shown { shown = true; publish { $0.drawing = true } }
                (end, more) = CardJob(api: api, id: step.id, folder: work.appendingPathComponent("cards/\(step.id)"),
                                      stopped: { [weak self] in self?.isStopped ?? true }).run()
            }
            if case .failed(let why) = end { AppLog.write("\(step.kind == cutoutKind ? "cut-out" : step.kind == splitKind ? "split" : step.kind == transcribeKind ? "transcript" : step.kind == faceBlurAutoKind ? "face blur" : step.kind == folderListKind ? "folder list" : step.kind == folderBrowseKind ? "folder browse" : step.kind == helperCheckKind ? "computer check" : step.kind == lookAwayKind ? "look-away" : "cards"): step \(step.id) failed: \(why)") }
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

    /// Where this Mac keeps its shot description sheets for this server: one file a version (LibraryLookJob.swift).
    var looksFolder: URL { work.appendingPathComponent("looks") }

    /// Shot descriptions of a file on this Mac (LibraryLookJob.swift) run on a thread of their own: reading a whole video
    /// takes minutes, and the other steps (a folder listing the assistant waits on, a transcript) go on meanwhile. The
    /// server hands this Mac one at a time and wakes its long poll for the next (mac-look.ts).
    private func startLook(_ step: EditorJob) {
        let thread = Thread { [self] in
            let job = LibraryLookJob(api: api, step: step, folder: looksFolder, stopped: { [weak self] in self?.isStopped ?? true }, granted: MediaFiles.granted(server: MediaFiles.serverKey(api.base), workspace: nil))
            if case .failed(let why) = job.run().end { AppLog.write("shot descriptions: step \(step.id) failed: \(why)") }
        }
        thread.qualityOfService = .utility
        thread.start()
    }

    /// A file into a copy of the library (LibraryCopyJob.swift) on a thread of its own, as a look: a big file takes a while.
    /// The server hands this Mac one at a time and wakes its long poll for the next (api/library/copies.ts).
    private func startCopy(_ step: EditorJob) {
        let thread = Thread { [self] in
            if case .failed(let why) = LibraryCopyJob(api: api, step: step, stopped: { [weak self] in self?.isStopped ?? true }, granted: MediaFiles.granted(server: MediaFiles.serverKey(api.base), workspace: nil)).run() {
                AppLog.write("library copy: step \(step.id) failed: \(why)")
            }
        }
        thread.qualityOfService = .utility
        thread.start()
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
