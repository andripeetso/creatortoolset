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

/// The plug-in asks from the page: "plugin:on:<folder>", "plugin:off:<id>", "plugin:show:<folder>", "plugins:resume".
enum PluginAsk: Equatable {
    case on(String)
    case off(String)
    case show(String)
    case resume
}

/// Whether an ask is one of the plug-in asks. Each one gets an answer, even one this file can't read (`ok: false`), so
/// none of them falls through to the default that turns the AI on.
func isPluginAsk(_ ask: String) -> Bool {
    ask.hasPrefix("plugin:") || ask.hasPrefix("plugins:")
}

/// The ask as its parts, or nil when it is malformed. A folder is one name in plugins/: no slash, no backslash, no dot
/// at the start. "show" may name the plugins folder itself (an empty name).
func pluginAsk(_ ask: String) -> PluginAsk? {
    if ask == "plugins:resume" { return .resume }
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

/// The record of the person's clicks on Switch On: id → fingerprint of the copy they switched on. It decides what runs, so
/// it lives in the Keychain, never in UserDefaults or a file.
///
/// A build with a provisioning profile keeps it in the data-protection Keychain, which no other program can reach. A
/// build without one can't use that Keychain (errSecMissingEntitlement, -34018) and keeps the record in the file-based
/// one. That is the weaker place: another program can change an item there with SecItemUpdate and no prompt (checked
/// on a throwaway item). It stops an edit to a file, not a program that calls the Keychain on purpose.
struct PluginRecord {
    let service: String
    static let account = "approved"
    static let live = PluginRecord(service: AppIdentity.keychain("plugins"))

    static func encode(_ approved: [String: String]) -> Data? {
        try? JSONEncoder().encode(approved)
    }

    static func decode(_ data: Data) -> [String: String]? {
        try? JSONDecoder().decode([String: String].self, from: data)
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
    func load() -> [String: String] {
        read(dataProtection: protected).flatMap(Self.decode) ?? [:]
    }

    @discardableResult
    func save(_ approved: [String: String]) -> Bool {
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

/// What the app adds to the server's environment: CT_PLUGINS_ON (left out when none is on) and CT_PLUGINS_PAUSED=1 when
/// paused. With paused, the server lists the plug-ins that are on and loads none.
func pluginEnvironment(approved: [String: String], paused: Bool) -> [String: String] {
    var env: [String: String] = [:]
    let on = pluginsOnValue(approved)
    if !on.isEmpty { env["CT_PLUGINS_ON"] = on }
    if paused { env["CT_PLUGINS_PAUSED"] = "1" }
    return env
}

/// The fifth crash in five minutes: pause the plug-ins and start again, once, when at least one is on and they are not
/// paused yet. Otherwise the server stops trying, as before.
func pluginsPauseInsteadOfStopping(on: Int, paused: Bool) -> Bool {
    on > 0 && !paused
}

/// The Switch On alert's words: the name in the message, and what the plug-in can reach (nil when it adds nothing).
func switchOnAlertText(name: String, server: Bool, web: Bool) -> (message: String, detail: String?) {
    let detail: String?
    if server {
        detail = "This plug-in was not made by Creator Toolset. It runs on this Mac inside the app, with the app's access to your files, your keys and the internet."
    } else if web {
        detail = "This plug-in was not made by Creator Toolset. It adds pages to the app, and they can see and change everything in it."
    } else {
        detail = nil
    }
    return ("Switch on “\(name)”?", detail)
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
            approved[id] = nil
            guard PluginRecord.live.save(approved) else { return done(recordProblem) }
            approvalsChanged()
            done(["ok": true])
        case .resume:
            setPluginsPaused(false)
            done(["ok": true])
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
    /// and loads the page again when the server answers (serverReady), so the page sees the new set of plug-ins.
    func restartServerHere() {
        guard runsHere, let server else { return }
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
            let text = switchOnAlertText(name: prepared.name, server: prepared.server, web: prepared.web)
            let alert = NSAlert()
            alert.messageText = text.message
            if let detail = text.detail { alert.informativeText = detail }
            alert.addButton(withTitle: "Cancel")
            alert.addButton(withTitle: "Switch On")
            alert.beginSheetModal(for: window) { [weak self] response in
                guard response == .alertSecondButtonReturn, let self else { return done(["ok": false]) }
                var approved = PluginRecord.live.load()
                approved[prepared.id] = prepared.fingerprint
                guard PluginRecord.live.save(approved) else { return done(recordProblem) }
                self.approvalsChanged()
                done(["ok": true])
            }
        }
    }

    /// The record changed: This Mac's count is updated and the server starts again with the new set.
    private func approvalsChanged() {
        pluginCount = PluginRecord.live.load().count
        restartServerHere()
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
