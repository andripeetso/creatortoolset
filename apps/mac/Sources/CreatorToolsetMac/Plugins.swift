// Plug-ins: the folder plug-ins the person's own AI writes (apps/captions/api/lib/folder-plugins.ts). The server runs one
// only when this app says it is on, so the app does the parts a web page or an AI may not: the person's click in the
// alert, the record of that click, the paused flag and the restart of the server. Nothing the page sends can switch a
// plug-in on: only Switch On in the alert below does.
import AppKit
import Foundation
import Security

/// UserDefaults key: plug-ins paused (CT_PLUGINS_PAUSED). It can only make less code run, so it needs no protection.
let pluginsPausedKey = "pluginsPaused"

/// Where this copy's plug-ins are written (the folder the person's AI fills).
let pluginsFolder = appSupport.appendingPathComponent("plugins")

/// The plug-in asks from the page: "plugin:on:<folder>", "plugin:off:<id>", "plugin:show:<folder>", "plugins:resume",
/// "plugins:state" (what the list shows about Update automatically) and "plugins:auto:on" / "plugins:auto:off".
enum PluginAsk: Equatable {
    case on(String)
    case off(String)
    case show(String)
    case resume
    case state
    case auto(Bool)
}

/// Whether an ask is one of the plug-in asks. Each one gets an answer, even one this file can't read (`ok: false`), so
/// none of them falls through to the default that turns the AI on.
func isPluginAsk(_ ask: String) -> Bool {
    ask.hasPrefix("plugin:") || ask.hasPrefix("plugins:")
}

/// The ask as its parts, or nil when it is malformed. A folder is one name in plugins/: no slash, no backslash, no dot
/// at the start. "show" may name the plugins folder itself (an empty name).
func pluginAsk(_ ask: String) -> PluginAsk? {
    switch ask {
    case "plugins:resume": return .resume
    case "plugins:state": return .state
    case "plugins:auto:on": return .auto(true)
    case "plugins:auto:off": return .auto(false)
    default: break
    }
    let parts = ask.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
    guard parts.count == 3, parts[0] == "plugin" else { return nil }
    let arg = parts[2]
    switch parts[1] {
    case "on": return validFolderName(arg) ? .on(arg) : nil
    case "off": return isPluginID(arg) ? .off(arg) : nil
    case "show": return arg.isEmpty || validFolderName(arg) ? .show(arg) : nil
    default: return nil
    }
}

private func validFolderName(_ name: String) -> Bool {
    !name.isEmpty && !name.contains("/") && !name.contains("\\") && !name.hasPrefix(".")
}

/// A plug-in's id as the server makes it (folder-plugins.ts parseOn): lowercase letters, digits and dashes, 1 to 40 long.
func isPluginID(_ id: String) -> Bool {
    id.range(of: "^[a-z0-9][a-z0-9-]{0,39}$", options: .regularExpression) != nil
}

/// A copy's fingerprint: 64 lowercase hex characters.
func isPluginFingerprint(_ fingerprint: String) -> Bool {
    fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
}

/// One plug-in the person switched on: the fingerprint of the copy that runs, and the folder in plugins/ it was taken
/// from. Only that folder's later changes are taken up by themselves: another folder that states the same id is a
/// folder nobody switched on.
struct PluginApproval: Codable, Equatable {
    var fingerprint: String
    var folder: String
}

/// What the Keychain item holds: the plug-ins that are on, and whether their later changes wait for a click.
struct PluginApprovals: Codable, Equatable {
    var on: [String: PluginApproval] = [:]
    /// Update automatically is off: a changed folder waits for Use the new version. Left out of the item = it is on.
    var waits = false

    init(on: [String: PluginApproval] = [:], waits: Bool = false) {
        self.on = on
        self.waits = waits
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        on = try c.decode([String: PluginApproval].self, forKey: .on)
        waits = try c.decodeIfPresent(Bool.self, forKey: .waits) ?? false
    }

    var fingerprints: [String: String] { on.mapValues(\.fingerprint) }
}

/// The record of the person's clicks on Switch On (id → the copy they switched on) and of the Update automatically
/// switch. It decides what runs, so it lives in the Keychain, never in UserDefaults or a file: a plug-in's own code can
/// write both of those.
///
/// A build with a provisioning profile keeps it in the data-protection Keychain, which no other program can reach. A
/// build without one can't use that Keychain (errSecMissingEntitlement, -34018) and keeps the record in the file-based
/// one. That is the weaker place: another program can change an item there with SecItemUpdate and no prompt (checked
/// on a throwaway item). It stops an edit to a file, not a program that calls the Keychain on purpose.
struct PluginRecord {
    let service: String
    static let account = "approved"
    static let live = PluginRecord(service: AppIdentity.keychain("plugins"))

    static func encode(_ approved: PluginApprovals) -> Data? {
        try? JSONEncoder().encode(approved)
    }

    static func decode(_ data: Data) -> PluginApprovals? {
        try? JSONDecoder().decode(PluginApprovals.self, from: data)
    }

    /// Whether this build can use the data-protection Keychain, as the Keychain itself answers. When it can, the
    /// file-based Keychain is never read or written: a record another program planted there must not count.
    /// A build without the entitlement is told "not found" when it reads there and errSecMissingEntitlement only when
    /// it writes or deletes (measured), so the question is asked with a delete of an item that is never made.
    var protected: Bool {
        var q = query(dataProtection: true)
        q[kSecAttrAccount as String] = "probe"
        return SecItemDelete(q as CFDictionary) != errSecMissingEntitlement
    }

    /// The record, or nothing approved when it can't be read (fewer plug-ins run, never more).
    func load() -> PluginApprovals {
        read(dataProtection: protected).flatMap(Self.decode) ?? PluginApprovals()
    }

    @discardableResult
    func save(_ approved: PluginApprovals) -> Bool {
        guard let data = Self.encode(approved) else { return false }
        return write(data, dataProtection: protected) == errSecSuccess
    }

    /// Deletes the record from both Keychains (the tests use it on their own service).
    func remove() {
        for dataProtection in [true, false] {
            SecItemDelete(query(dataProtection: dataProtection) as CFDictionary)
        }
    }

    private func query(dataProtection: Bool) -> [String: Any] {
        var q: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                kSecAttrService as String: service,
                                kSecAttrAccount as String: Self.account]
        if dataProtection { q[kSecUseDataProtectionKeychain as String] = true }
        return q
    }

    private func read(dataProtection: Bool) -> Data? {
        var q = query(dataProtection: dataProtection)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess else { return nil }
        return item as? Data
    }

    private func write(_ data: Data, dataProtection: Bool) -> OSStatus {
        let q = query(dataProtection: dataProtection)
        let updated = SecItemUpdate(q as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        guard updated == errSecItemNotFound else { return updated }
        var item = q
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(item as CFDictionary, nil)
    }
}

/// CT_PLUGINS_ON for the server: "id:fingerprint" pairs sorted by id, a malformed pair dropped.
func pluginsOnValue(_ approved: [String: String]) -> String {
    approved.filter { isPluginID($0.key) && isPluginFingerprint($0.value) }
        .sorted { $0.key < $1.key }
        .map { "\($0.key):\($0.value)" }
        .joined(separator: ",")
}

/// CT_PLUGINS_FOLDERS for the server: { id: folder } as JSON with sorted keys, for the same plug-ins as CT_PLUGINS_ON.
/// The server's list uses it to tell the folder that is on from another folder stating the same id.
func pluginsFoldersValue(_ approved: PluginApprovals) -> String {
    let folders = approved.on.filter { isPluginID($0.key) && isPluginFingerprint($0.value.fingerprint) }.mapValues(\.folder)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return (try? encoder.encode(folders)).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
}

/// What the app adds to the server's environment: CT_PLUGINS_ON with CT_PLUGINS_FOLDERS (both left out when none is on)
/// and CT_PLUGINS_PAUSED=1 when paused. With paused, the server lists the plug-ins that are on and loads none.
func pluginEnvironment(approved: PluginApprovals, paused: Bool) -> [String: String] {
    var env: [String: String] = [:]
    let on = pluginsOnValue(approved.fingerprints)
    if !on.isEmpty {
        env["CT_PLUGINS_ON"] = on
        env["CT_PLUGINS_FOLDERS"] = pluginsFoldersValue(approved)
    }
    if paused { env["CT_PLUGINS_PAUSED"] = "1" }
    return env
}

/// The fifth crash in five minutes: pause the plug-ins and start again, once, when at least one is on and they are not
/// paused yet. Otherwise the server stops trying, as before.
func pluginsPauseInsteadOfStopping(on: Int, paused: Bool) -> Bool {
    on > 0 && !paused
}

/// The Switch On alert's words: the name in the message, and what the plug-in can reach (nil when it adds nothing).
/// With Update automatically on (`auto`), the click also covers what the folder holds later, and the alert says so.
func switchOnAlertText(name: String, server: Bool, web: Bool, auto: Bool) -> (message: String, detail: String?) {
    var detail: String?
    if server {
        detail = "This plug-in was not made by Creator Toolset. It runs on this Mac inside the app, with the app's access to your files, your keys and the internet."
    } else if web {
        detail = "This plug-in was not made by Creator Toolset. It adds pages to the app, and they can see and change everything in it."
    }
    if auto, detail != nil { detail! += " Later changes to its folder run by themselves unless you switch off Update automatically." }
    return ("Switch on “\(name)”?", detail)
}

/// The alert for switching Update automatically back on. It is this app's own alert because the ask comes from the page,
/// where a plug-in's pages run too.
let autoOnAlertText = (message: "Update plug-ins automatically?",
                       detail: "A plug-in that is on will run later changes to its folder by itself.")

// MARK: changes taken up by themselves

/// Seconds between two looks at the folders of the plug-ins that are on. A folder is looked into once it is the same
/// at two looks in a row, so a change comes in 5 to 10 s after the last file was written.
let pluginLookSeconds: TimeInterval = 5

/// A folder's files as a cheap stamp (each path with its size and change time; hidden files and node_modules left out,
/// as the server's fingerprint leaves them out). nil when the folder is gone. It only says "something moved": whether
/// the plug-in really changed is the server's fingerprint to say.
// ponytail: a stat of every file each look (a plug-in is 2,000 files at most); FSEvents if that ever costs
func pluginFolderStamp(_ folder: URL) -> String? {
    let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey, .contentModificationDateKey]
    guard let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: keys) else { return nil }
    var isFolder: ObjCBool = false
    guard FileManager.default.fileExists(atPath: folder.path, isDirectory: &isFolder), isFolder.boolValue else { return nil }
    let root = folder.standardizedFileURL.path
    var lines: [String] = []
    for case let file as URL in walk {
        let name = file.lastPathComponent
        if name.hasPrefix(".") || name == "node_modules" {
            walk.skipDescendants()
            continue
        }
        guard let v = try? file.resourceValues(forKeys: Set(keys)), v.isRegularFile == true else { continue }
        let at = String(file.standardizedFileURL.path.dropFirst(root.count))
        lines.append("\(at) \(v.fileSize ?? 0) \(v.contentModificationDate?.timeIntervalSince1970 ?? 0)")
        if lines.count > 2000 { break }   // the server refuses a folder this big
    }
    return lines.sorted().joined(separator: "\n")
}

/// Whether a folder is looked into now: it is there, it stood still since the last look, and this state of it has not
/// been looked into yet (taken, found the same, or refused).
func pluginFolderSettled(stamp: String?, last: String?, handled: String?) -> Bool {
    stamp != nil && stamp == last && stamp != handled
}

/// A prepared copy comes in by itself only as another version of a plug-in that is on.
func pluginTakesUp(_ prepared: PluginPrepared, id: String, on: PluginApproval) -> Bool {
    prepared.id == id && isPluginFingerprint(prepared.fingerprint) && prepared.fingerprint != on.fingerprint
}

/// A plug-in taken up five times in five minutes changes faster than an AI writes: most likely it writes into its own
/// folder, and every take-up would restart the server for good. Its next change waits for a click.
func pluginChangesTooOften(_ takeUps: [Date], now: Date) -> Bool {
    takeUps.filter { now.timeIntervalSince($0) < 300 }.count >= 5
}

let pluginChangesTooOftenNote = "It changed five times in five minutes, so this change waits for you."

/// Taking a change up restarts the server, which ends whatever it is doing. So it waits while the menu bar's Active
/// list has a row (a Workshop reply being written, a plug-in's own work, an AI request on this Mac), while the
/// recorder is open, and while the server runs another program (ffmpeg for an export, a cleaning or an enhance, a
/// plug-in being built). Not seen: an upload in flight, and work inside the server that starts no program.
func serverBusyHere(active: Int, recording: Bool, runsPrograms: Bool) -> Bool {
    active > 0 || recording || runsPrograms
}

/// What the watcher remembers between looks (Shell.pluginLook). Nothing here decides what runs: that is the record.
@MainActor
final class PluginWatch {
    /// id → the folder's stamp at the look before this one
    var last: [String: String] = [:]
    /// id → the stamp of the state that was looked into
    var handled: [String: String] = [:]
    /// id → a new version that is copied and builds, waiting for the server to have nothing running
    var waiting: [String: PluginApproval] = [:]
    /// id → why the folder's newest state was not taken (its row says it)
    var notes: [String: String] = [:]
    /// id → when its changes were taken up by themselves
    var takeUps: [String: [Date]] = [:]
    var looking = false
    /// The page the window was on when the server was restarted, to go back to when it answers.
    var returnTo: URL?

    func forget(_ id: String) {
        last[id] = nil
        handled[id] = nil
        notes[id] = nil
        waiting[id] = nil
        takeUps[id] = nil
    }
}

/// What the server answers to a prepare (the Mac app's Switch On, first step): the copy's id, name and fingerprint, and
/// what it has (a server half runs on this Mac, a web half adds pages).
struct PluginPrepared: Decodable {
    let id: String
    let name: String
    let fingerprint: String
    let server: Bool
    let web: Bool
}

private let recordProblem: [String: Any] = ["ok": false, "problem": "The Keychain did not keep the plug-in's record."]

/// The server's own sentence for a failed prepare ({ error }), or a plain one when there is none.
private func prepareProblem(_ body: Data) -> String {
    (try? JSONDecoder().decode([String: String].self, from: body))?["error"] ?? "Could not prepare the plug-in."
}

/// A POST to the open server with the window's cookies, whatever the status: the status and the body.
private func postPlugin(_ site: Site, _ path: String) async throws -> (Int, Data) {
    var request = URLRequest(url: URL(string: path, relativeTo: site.base) ?? site.base, timeoutInterval: 180)
    request.httpMethod = "POST"
    request.httpShouldHandleCookies = false
    request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: site.cookies)
    let (data, response) = try await URLSession.shared.data(for: request)
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
}

extension Shell {
    /// Answers a plug-in ask from the page (TitleBar.swift → onThisMacAsk). Only This Mac's own server answers; a malformed
    /// ask, or any other server, gets { ok: false }. A failure carries a `problem` sentence.
    func pluginAnswer(_ ask: PluginAsk?, done: @escaping ([String: Any]) -> Void) {
        guard let ask, runsHere, server != nil else { return done(["ok": false]) }
        switch ask {
        case .on(let folder):
            switchOn(folder, done: done)
        case .off(let id):
            var approved = PluginRecord.live.load()
            approved.on[id] = nil
            guard PluginRecord.live.save(approved) else { return done(recordProblem) }
            pluginWatch.forget(id)
            approvalsChanged()
            done(["ok": true])
        case .resume:
            setPluginsPaused(false)
            done(["ok": true])
        case .state:
            let record = PluginRecord.live.load()
            done(["ok": true, "auto": !record.waits, "folders": record.on.mapValues(\.folder),
                  "waiting": pluginWatch.waiting.keys.sorted(), "notes": pluginWatch.notes])
        case .auto(false):
            // less runs by itself: no question asked
            var approved = PluginRecord.live.load()
            approved.waits = true
            guard PluginRecord.live.save(approved) else { return done(recordProblem) }
            pluginWatch.waiting = [:]
            done(["ok": true])
        case .auto(true):
            setAutoOn(done: done)
        case .show(let folder):
            done(["ok": showPluginFolder(folder)])
        }
    }

    /// This Mac's Switch All Off and Switch Back On (ThisMac.swift): the flag, then the server starts again with it.
    func setPluginsPaused(_ paused: Bool) {
        UserDefaults.standard.set(paused, forKey: pluginsPausedKey)
        restartServerHere()
    }

    /// The server here starts again (a restart, not a crash: the crash list stays). The window shows the starting page
    /// and loads the page it was on again when the server answers (serverReady), so the page sees the new set of plug-ins.
    func restartServerHere() {
        guard runsHere, let server else { return }
        if let url = webView.url, isSite(url, base) { pluginWatch.returnTo = url }
        webView.loadHTMLString(messagePage("Starting the server on this Mac…"), baseURL: nil)
        server.restart()
    }

    /// Switch On, in two steps: the server takes a copy and builds it (nothing runs), then this app's own alert asks the
    /// person. Cancel is the default, so Return never approves.
    private func switchOn(_ folder: String, done: @escaping ([String: Any]) -> Void) {
        Task {
            let site = await client()
            let path = "/api/plugins/folder/" + (folder.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? folder) + "/prepare"
            let prepared: PluginPrepared
            do {
                let (status, body) = try await postPlugin(site, path)
                guard status == 200, let ok = try? JSONDecoder().decode(PluginPrepared.self, from: body) else {
                    return done(["ok": false, "problem": prepareProblem(body)])
                }
                prepared = ok
            } catch {
                return done(["ok": false, "problem": "The server did not answer: \(error.localizedDescription)"])
            }
            guard let window = webView.window else { return done(["ok": false]) }
            let text = switchOnAlertText(name: prepared.name, server: prepared.server, web: prepared.web, auto: !PluginRecord.live.load().waits)
            let alert = NSAlert()
            alert.messageText = text.message
            if let detail = text.detail { alert.informativeText = detail }
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: "Switch On")
            alert.beginSheetModal(for: window) { [weak self] response in
                guard response == .alertSecondButtonReturn, let self else { return done(["ok": false]) }
                var approved = PluginRecord.live.load()
                approved.on[prepared.id] = PluginApproval(fingerprint: prepared.fingerprint, folder: folder)
                guard PluginRecord.live.save(approved) else { return done(recordProblem) }
                self.pluginWatch.forget(prepared.id)
                self.approvalsChanged()
                done(["ok": true])
            }
        }
    }

    /// Update automatically, back on: this app's own alert first (Cancel is the default), because the ask comes from
    /// the page. Nothing restarts: the next look takes up what has changed.
    private func setAutoOn(done: @escaping ([String: Any]) -> Void) {
        guard let window = webView.window else { return done(["ok": false]) }
        let alert = NSAlert()
        alert.messageText = autoOnAlertText.message
        alert.informativeText = autoOnAlertText.detail
        alert.addButton(withTitle: "Cancel")
        alert.addButton(withTitle: "Switch On")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertSecondButtonReturn, let self else { return done(["ok": false]) }
            var approved = PluginRecord.live.load()
            approved.waits = false
            guard PluginRecord.live.save(approved) else { return done(recordProblem) }
            self.pluginWatch.handled = [:]
            self.pluginWatch.notes = [:]
            self.pluginWatch.takeUps = [:]
            done(["ok": true])
        }
    }

    /// The record changed: This Mac's count is updated and the server starts again with the new set.
    private func approvalsChanged() {
        pluginCount = PluginRecord.live.load().on.count
        restartServerHere()
    }

    /// One look at the folders of the plug-ins that are on (every pluginLookSeconds). A folder that changed and stood
    /// still is copied and test-built by the server (prepare: nothing of it runs). A copy that builds waits until the
    /// server has nothing running, then the record takes its fingerprint and the server starts again with it. One that
    /// does not build is left out: the copy that is on keeps running and the row says why.
    func pluginLook() async {
        guard runsHere, let server, server.state == .running, !pluginWatch.looking else { return }
        let watch = pluginWatch
        let record = PluginRecord.live.load()
        guard !record.waits, !record.on.isEmpty, !UserDefaults.standard.bool(forKey: pluginsPausedKey) else {
            watch.waiting = [:]
            return
        }
        watch.looking = true
        defer { watch.looking = false }
        for (id, on) in record.on {
            let folder = pluginsFolder.appendingPathComponent(on.folder)
            let stamp = pluginFolderStamp(folder)
            defer { watch.last[id] = stamp }
            guard pluginFolderSettled(stamp: stamp, last: watch.last[id], handled: watch.handled[id]) else { continue }
            watch.handled[id] = stamp
            watch.waiting[id] = nil
            let site = await client()
            let path = "/api/plugins/folder/" + (on.folder.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? on.folder) + "/prepare"
            guard let (status, body) = try? await postPlugin(site, path) else {
                watch.handled[id] = nil   // no answer: the next look asks again
                continue
            }
            guard status == 200, let prepared = try? JSONDecoder().decode(PluginPrepared.self, from: body) else {
                watch.notes[id] = prepareProblem(body)
                continue
            }
            watch.notes[id] = nil
            guard pluginTakesUp(prepared, id: id, on: on) else { continue }
            if pluginFolderStamp(folder) != stamp {
                watch.handled[id] = nil   // it moved while it was copied: not a state that stood still
            } else if pluginChangesTooOften(watch.takeUps[id] ?? [], now: Date()) {
                watch.notes[id] = pluginChangesTooOftenNote
            } else {
                watch.waiting[id] = PluginApproval(fingerprint: prepared.fingerprint, folder: on.folder)
            }
        }
        guard !watch.waiting.isEmpty, await !busyHere() else { return }
        // read again: the person may have switched something while this look ran
        var now = PluginRecord.live.load()
        var taken: [String] = []
        for (id, new) in watch.waiting where !now.waits && now.on[id]?.folder == new.folder && now.on[id]?.fingerprint != new.fingerprint {
            now.on[id] = new
            taken.append(id)
        }
        watch.waiting = [:]
        guard !taken.isEmpty, PluginRecord.live.save(now) else { return }
        for id in taken { watch.takeUps[id, default: []].append(Date()) }
        ServerLog.note("plug-ins changed in their folders (\(taken.sorted().joined(separator: ", "))): starting again with the new versions")
        approvalsChanged()
    }

    /// Whether the server here is in the middle of something a restart would end (serverBusyHere), asked now. No answer
    /// from the server counts as busy: nothing is restarted blind.
    private func busyHere() async -> Bool {
        guard let server else { return true }
        let site = await client()
        guard let sessions: [SessionRow] = try? await site.get("/api/workshop/sessions/summary"),
              let rows: [PluginRow] = try? await site.get("/api/activity") else { return true }
        let active = activityRows(sessions: sessions, aiRunning: aiOn ? ai.running : 0, plugin: rows).active.count
        return serverBusyHere(active: active, recording: recorder.busy, runsPrograms: server.runsPrograms)
    }

    /// Show in Finder: the plug-in's folder, or the plugins folder itself for "". The plugins folder is made when missing.
    private func showPluginFolder(_ folder: String) -> Bool {
        let fm = FileManager.default
        do {
            try fm.createDirectory(at: pluginsFolder, withIntermediateDirectories: true)
        } catch {
            return false
        }
        let inside = pluginsFolder.appendingPathComponent(folder)
        let target = folder.isEmpty || !fm.fileExists(atPath: inside.path) ? pluginsFolder : inside
        NSWorkspace.shared.activateFileViewerSelecting([target])
        return true
    }
}
