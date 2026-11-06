// The window's web view and the Mac-side state the menu bar shows. No secrets are kept here:
// every request to the site sends the web view's own cookies (WebKit's store), so logging in
// once in the window is enough.
import AppKit
import Combine
import UserNotifications
import WebKit

@MainActor
final class Shell: NSObject, ObservableObject {
    let webView: WKWebView
    @Published private(set) var base: URL
    @Published private(set) var unread = 0
    @Published private(set) var notice: String?
    /// This Mac as an AI device (Relay.swift): on = the person turned it on; ai = what the runner reports.
    @Published private(set) var aiOn = false
    @Published private(set) var ai = AIStatus()
    /// Opens the main window; the window sets it so a notification click can bring a closed window back.
    var openWindow: (() -> Void)?

    private let noteCenter = NoteCenter()
    private var timer: Timer?
    private let seenKey = "seenNotificationIDs"
    private let siteKey = "siteAddress"
    private let aiKey = "aiOnThisMac"
    private var runner: RelayRunner?
    private var runnerID = UUID()

    private var lastBlankReload = Date.distantPast

    override init() {
        AppLog.trim()
        AppLog.write("launched \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")")
        let view = AppWebView()
        webView = view
        base = UserDefaults.standard.string(forKey: "siteAddress").flatMap(siteURL(from:)) ?? productionSite
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true
        view.onBlank = { [weak self] in
            guard let self, Date().timeIntervalSince(self.lastBlankReload) > 60 else { return }
            self.lastBlankReload = Date()
            AppLog.write("reloading the blank page")
            self.webView.reload()
        }
        noteCenter.open = { [weak self] href, id in
            Task { @MainActor in self?.noteClicked(href: href, id: id) }
        }
        UNUserNotificationCenter.current().delegate = noteCenter
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
        open("/")
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        Task { await refresh() }
        aiOn = UserDefaults.standard.bool(forKey: aiKey)
        if aiOn { startAI() }
    }

    // MARK: menu bar state

    /// The menu bar's icon: off, on, or running a job.
    var menuSymbol: String {
        guard aiOn else { return "moon.zzz" }
        return ai.running > 0 ? "wand.and.stars" : "wand.and.rays"
    }

    var aiLine: String {
        guard aiOn else { return "AI on this Mac: off" }
        return ai.running > 0 ? "AI on this Mac: running \(ai.running)" : "AI on this Mac: on"
    }

    /// The Mac's device is known for this site (paired once); "Forget this Mac" needs it.
    var pairedHere: Bool { DeviceVault.deviceID(for: base.host ?? "") != nil }

    // MARK: window and site

    func open(_ href: String) {
        guard let url = URL(string: href, relativeTo: base)?.absoluteURL else { return }
        if isSite(url, base) {
            webView.load(URLRequest(url: url))
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    func showWindow(href: String? = nil) {
        if let href { open(href) }
        openWindow?()
        NSApp.activate(ignoringOtherApps: true)
    }

    func setSite(_ url: URL) {
        base = url
        UserDefaults.standard.set(url.absoluteString, forKey: siteKey)
        open("/")
        Task { await refresh() }
        stopRunner()
        if aiOn { startAI() }   // a token is per site: pair again if this one has none
    }

    func openAppLog() {
        if !FileManager.default.fileExists(atPath: AppLog.path) { AppLog.write("log started") }
        NSWorkspace.shared.open(URL(fileURLWithPath: AppLog.path))
    }

    /// The site's cookies from the web view's store, for the requests below.
    func client() async -> Site {
        let all: [HTTPCookie] = await withCheckedContinuation { continuation in
            webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        return Site(base: base, cookies: cookies(for: base, in: all))
    }

    // MARK: this Mac for the person's AI (Relay.swift)

    /// "Use this Mac for my AI": on pairs this Mac once (signed in to the site in the window) and starts the runner; off stops it and keeps the pairing.
    func setAI(_ on: Bool) {
        aiOn = on
        UserDefaults.standard.set(on, forKey: aiKey)
        if on {
            startAI()
        } else {
            stopRunner()
            ai = AIStatus()
        }
    }

    private func startAI() {
        if DeviceVault.token(for: base.host ?? "") != nil {
            startRunner()
            return
        }
        Task {
            do {
                try await pairThisMac()
                startRunner()
            } catch {
                setAIOff("Could not pair this Mac: \(error.localizedDescription)")
            }
        }
    }

    /// POST /api/devices with the window's cookies: the site makes the device and returns its token once.
    private func pairThisMac() async throws {
        let host = base.host ?? ""
        let client = await client()
        let name = Host.current().localizedName ?? ProcessInfo.processInfo.hostName
        let data = try await client.postData("/api/devices", ["name": name, "version": appVersion])
        let pair = try JSONDecoder().decode(PairReply.self, from: data)
        guard DeviceVault.save(pair.token, for: host) else { throw SiteError.keychain }
        DeviceVault.setDeviceID(pair.device.id, for: host)
    }

    private func startRunner() {
        let host = base.host ?? ""
        guard runner == nil, let token = DeviceVault.token(for: host) else { return }
        let id = UUID()
        let relay = RelayRunner(base: base, token: token,
            onStatus: { [weak self] status in
                Task { @MainActor in
                    guard let self, self.runnerID == id else { return }
                    self.ai = status
                }
            },
            onRevoked: { [weak self] in
                Task { @MainActor in
                    guard let self, self.runnerID == id else { return }
                    self.revoked()
                }
            })
        runner = relay
        runnerID = id
        relay.start()
    }

    private func stopRunner() {
        runner?.stop()
        runner = nil
        runnerID = UUID()
    }

    /// The site no longer knows this Mac (its token was revoked): drop the token and say so in the menu.
    private func revoked() {
        let host = base.host ?? ""
        DeviceVault.remove(for: host)
        DeviceVault.setDeviceID(nil, for: host)
        setAIOff("This Mac was removed from your account. Turn it on again to pair it.")
    }

    private func setAIOff(_ message: String?) {
        stopRunner()
        aiOn = false
        UserDefaults.standard.set(false, forKey: aiKey)
        ai = AIStatus()
        notice = message
    }

    /// "Forget this Mac": stops it, drops its token here and asks the site to remove the device.
    func forgetThisMac() {
        let host = base.host ?? ""
        let id = DeviceVault.deviceID(for: host)
        setAIOff(nil)
        DeviceVault.remove(for: host)
        DeviceVault.setDeviceID(nil, for: host)
        guard let id else { return }
        Task {
            let client = await client()
            do {
                try await client.delete("/api/devices/\(id)")
                notice = "This Mac was forgotten"
            } catch {
                notice = "Forgotten here; the site did not answer: \(error.localizedDescription)"
            }
        }
    }

    /// The Dock badge and the Review notes; called every 30 s and when the menu opens.
    func refresh() async {
        let client = await client()
        do {
            let notes: NotesResponse = try await client.get("/api/review/notifications")
            unread = notes.unread
            NSApplication.shared.dockTile.badgeLabel = notes.unread > 0 ? "\(notes.unread)" : nil
            let seen = UserDefaults.standard.stringArray(forKey: seenKey)
            for note in freshNotes(notes.items, seen: seen) { post(note) }
            UserDefaults.standard.set(rememberedIDs(notes.items, seen: seen), forKey: seenKey)
        } catch {
            // not signed in yet: the window signs in
        }
    }

    private func post(_ note: ReviewNote) {
        let content = UNMutableNotificationContent()
        content.title = noteTitle(note)
        content.body = note.text ?? ""
        content.sound = .default
        content.userInfo = ["href": note.href, "id": note.id]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: note.id, content: content, trigger: nil))
    }

    private func noteClicked(href: String, id: String) {
        showWindow(href: href)
        Task {
            let client = await client()
            try? await client.post("/api/review/notifications/read", ["ids": [id]])
            await refresh()
        }
    }
}

// MARK: web view behaviour

extension Shell: WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    // A load that fails (the site restarting after a deploy, no network) used to leave the window black:
    // it now says so and tries again every 5 s. A web process that dies reloads the page.
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        AppLog.write("the page's web process ended: reloading \(webView.url?.absoluteString ?? "")")
        if webView.url == nil { open("/") } else { webView.reload() }
    }


    private func failed(_ error: Error) {
        let e = error as NSError
        // a newer load replaced it, or a download took over
        if e.code == NSURLErrorCancelled || (e.domain == "WebKitErrorDomain" && e.code == 102) { return }
        let url = (e.userInfo[NSURLErrorFailingURLErrorKey] as? URL) ?? webView.url ?? base
        AppLog.write("load failed: \(url.absoluteString): \(e.domain) \(e.code) \(e.localizedDescription)")
        guard isSite(url, base) else { return }
        webView.loadHTMLString(unreachablePage(url, error), baseURL: nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        if action.shouldPerformDownload { return decisionHandler(.download) }
        // A file dropped outside a drop zone must not replace the page.
        if url.isFileURL { return decisionHandler(.cancel) }
        // Embeds and players stay where the page put them.
        if action.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
        let inside = ["about", "blob", "data", "javascript"].contains(url.scheme ?? "") || isSite(url, base)
        if inside {
            decisionHandler(.allow)
        } else {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        let attachment = disposition.lowercased().hasPrefix("attachment")
        decisionHandler(response.canShowMIMEType && !attachment ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        completionHandler(uniqueURL(in: folder, named: suggestedFilename))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        _ = dialog("The download failed: \(error.localizedDescription)", buttons: ["OK"])
    }

    /// target=_blank and window.open go to the default browser, not a second window.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    /// The page's file inputs and drop zones: the Mac's own open panel.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        let done: (NSApplication.ModalResponse) -> Void = { completionHandler($0 == .OK ? panel.urls : nil) }
        if let window = webView.window {
            panel.beginSheetModal(for: window, completionHandler: done)
        } else {
            panel.begin(completionHandler: done)
        }
    }

    // The site's confirm and prompt (delete, rename) must show something; WebKit shows nothing by default.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        _ = dialog(message, buttons: ["OK"])
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        completionHandler(dialog(message, buttons: ["OK", "Cancel"]) == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 320, height: 24)
        let answer = dialog(prompt, buttons: ["OK", "Cancel"], field: field)
        completionHandler(answer == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    private func dialog(_ message: String, buttons: [String], field: NSTextField? = nil) -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.messageText = message
        for title in buttons { alert.addButton(withTitle: title) }
        alert.accessoryView = field
        return alert.runModal()
    }
}

/// Shows Review notes as Mac notifications; a click hands the note's link and id back.
final class NoteCenter: NSObject, UNUserNotificationCenterDelegate {
    var open: ((String, String) -> Void)?

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void) {
        done([.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        if let href = info["href"] as? String, let id = info["id"] as? String { open?(href, id) }
        done()
    }
}

/// The site's API with the window's own session: cookies from WebKit, nothing stored here.
struct Site {
    let base: URL
    let cookies: [HTTPCookie]

    func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, _) = try await send("GET", path, body: nil)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func post(_ path: String, _ body: [String: Any]) async throws {
        _ = try await send("POST", path, body: body)
    }

    func postData(_ path: String, _ body: [String: Any]) async throws -> Data {
        try await send("POST", path, body: body).0
    }

    func delete(_ path: String) async throws {
        _ = try await send("DELETE", path, body: nil)
    }

    private func send(_ method: String, _ path: String, body: [String: Any]?) async throws -> (Data, URLResponse) {
        var request = URLRequest(url: URL(string: path, relativeTo: base) ?? base)
        request.httpMethod = method
        request.httpShouldHandleCookies = false
        request.allHTTPHeaderFields = HTTPCookie.requestHeaderFields(with: cookies)
        if let body {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw SiteError.status(code) }
        return (data, response)
    }
}

enum SiteError: LocalizedError {
    case status(Int)
    case keychain

    var errorDescription: String? {
        switch self {
        case .status(let code): return code == 401 || code == 403 ? "sign in in the window first" : "the site answered \(code)"
        case .keychain: return "the Keychain did not keep the device token"
        }
    }
}
