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
    /// The menu bar panel's Workshop rows (Activity.swift), from the open server.
    @Published private(set) var sessions: [SessionRow] = []
    /// The rows the server's plug-ins add (GET /api/activity), shown with the sessions.
    @Published private(set) var pluginRows: [PluginRow] = []
    /// The menu items the server's plug-ins add (GET /api/activity/menu): the Go and gear menus (PluginMenu.swift).
    @Published private(set) var pluginMenu: [PluginMenuItem] = []
    /// How many plug-ins the person has switched on (Plugins.swift, the record in the Keychain): This Mac's Plug-ins row.
    @Published internal(set) var pluginCount = 0
    /// What the look at the plug-ins' folders remembers between looks (Plugins.swift pluginLook).
    let pluginWatch = PluginWatch()
    /// The Go menu's own tools (GET /api/activity/tools, PluginMenu.swift): the server's list for this account.
    @Published private(set) var appTools: [AppToolItem] = []
    @Published internal(set) var notice: String?
    /// This Mac as an AI device (Relay.swift): on = the person turned it on; ai = what the runner reports.
    @Published private(set) var aiOn = false
    @Published private(set) var ai = AIStatus()
    /// Opens a window by its scene id ("main", "this-mac", "guide"); the main window sets it when it appears.
    var openWindowID: ((String) -> Void)?
    /// Screen recording (Recorder.swift): started from the page, the menu bar or the Record menu.
    let recorder = Recorder()
    /// The server on this Mac (Server.swift), when this build has one; runsHere = the window uses it, not a site.
    let server: LocalServer? = LocalServer.folder == nil ? nil : LocalServer()
    @Published private(set) var runsHere = false
    /// The files picked in the open panel for the page (rememberPicks, ThisMacBridge.swift): the page's "files" ask.
    private var pickedFiles: [URL] = []
    /// The servers added by address (Servers.swift) and the one the window shows: thisMacID, an added one's id, or nil
    /// (no server picked: the window asks to pick or add one).
    @Published private(set) var servers: [ServerEntry] = []
    @Published private(set) var current: String?
    @Published private(set) var serverLine: String?
    /// The plain words for a server that could not start (the window's Try again card); nil when it is fine.
    @Published private(set) var serverProblem: String?
    /// "Only N GB free on the data disk", when under 10 GB (checked with the notes, every 30 s).
    @Published private(set) var spaceLine: String?
    private var serverWatch: AnyCancellable?
    private var recorderWatch: AnyCancellable?

    /// The person's account (Account.swift): first run's sign-in with Apple or Google.
    let account = Account()
    /// This Mac's tunnel to the account's broker (Connect.swift), and the account's other computers from it (Servers).
    let tunnel = TunnelRunner()
    @Published internal(set) var accountComputers: [ServerEntry] = []

    private let noteCenter = NoteCenter()
    private var timer: Timer?
    private let seenKey = "seenNotificationIDs"
    private let notesAskedKey = "notificationsAsked"
    private let serversKey = "servers"
    private let currentKey = "currentServer"
    private let aiKey = "aiOnThisMac"
    private var runner: RelayRunner?
    private var runnerID = UUID()
    private let museLogin = MuseLogin()

    private var lastBlankReload = Date.distantPast
    /// The editor's packed see-through videos on their way in (AlphaVideo.swift): where each is kept, and the video it becomes.
    private var alphaDownloads: [WKDownload: (file: URL, final: URL, stacked: Bool)] = [:]
    /// The see-through video being made; the page's Stop ends it ("record-alpha-stop").
    private var alphaTask: Task<Void, Never>?

    override init() {
        AppLog.trim()
        AppLog.write("launched \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")")
        let view = AppWebView()
        webView = view
        let defaults = UserDefaults.standard
        let hasLocal = server != nil
        if !defaults.bool(forKey: "serversMigrated") {
            // once: the old "siteAddress" and "runServerHere" become the list; the old keys stay for older copies
            let old = migratedServers(site: defaults.string(forKey: "siteAddress"), runsHere: defaults.object(forKey: "runServerHere") as? Bool, hasLocal: hasLocal)
            defaults.set(try? JSONEncoder().encode(old.servers), forKey: serversKey)
            defaults.set(old.current, forKey: currentKey)
            defaults.set(true, forKey: "serversMigrated")
        }
        var list = defaults.data(forKey: serversKey).flatMap { try? JSONDecoder().decode([ServerEntry].self, from: $0) } ?? []
        // the build's DEFAULT_SERVER, once: added to the list the first time this copy runs
        let seeded = seedingDefaultServer(Bundle.main.object(forInfoDictionaryKey: "CTDefaultServer") as? String, into: list,
                                          seeded: defaults.bool(forKey: "defaultServerSeeded"))
        if seeded.servers != list { defaults.set(try? JSONEncoder().encode(seeded.servers), forKey: serversKey) }
        defaults.set(seeded.seeded, forKey: "defaultServerSeeded")
        list = seeded.servers
        let picked = validCurrent(defaults.string(forKey: currentKey), in: list, hasLocal: hasLocal)
        servers = list
        current = picked
        runsHere = picked == thisMacID
        base = Self.url(of: picked, in: list, local: server)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.isInspectable = true
        view.site = { [unowned self] in self.base }
        view.onBlank = { [weak self] in
            guard let self, Date().timeIntervalSince(self.lastBlankReload) > 60 else { return }
            self.lastBlankReload = Date()
            AppLog.write("reloading the blank page")
            self.webView.reload()
        }
        view.onThisMac = { [weak self] in self?.openWindowID?("this-mac") }
        view.onRecord = { [weak self] in self?.recorderCommand($0) }
        view.onSignIn = { [weak self] driver, home in self?.signIn(driver: driver, home: home) }
        recorderWatch = recorder.$phase.sink { [weak self] phase in
            DispatchQueue.main.async { self?.pushRecorderState(phase) }
        }
        recorder.upload = { [weak self] project, destination, progress in
            guard let self else { throw SiteError.status(0) }
            return try await self.client().uploadRecording(project, to: destination, progress: progress)
        }
        recorder.onRecordingsChanged = { [weak self] in self?.pushRecordings() }
        recorder.pageAlert = { [weak self] title, text, done in
            guard let self else { return done(false) }
            self.pageAlert(title, text, done)
        }
        if Recorder.available { RecordShortcut.shared.install(recorder) }
        recorder.openPage = { [weak self] in self?.showWindow(href: $0) }
        view.onThisMacCommand = { [weak self] in self?.thisMacCommand($0) }
        view.onThisMacAsk = { [weak self] ask, done in
            guard let self else { return done(["aiOn": false, "paired": false]) }
            // plug-ins (Plugins.swift): answered before the default below, which turns the AI on
            if isPluginAsk(ask) { return self.pluginAnswer(pluginAsk(ask), done: done) }
            // Headless access → Install: the open server into Claude Code or Codex on this Mac (off the main thread: a
            // command-line tool runs). The reply is { ok } or { ok: false, problem }.
            if let install = installAsk(ask) {
                let url = self.base.appendingPathComponent("api/mcp").absoluteString
                DispatchQueue.global(qos: .userInitiated).async {
                    let problem = installInAI(app: install.app, url: url, key: install.key)
                    DispatchQueue.main.async { done(problem.map { ["ok": false, "problem": $0] } ?? ["ok": true]) }
                }
                return
            }
            switch ask {
            case "state": done(self.thisMacState())
            case "access": Task { done(await self.accessFromOtherDevices()) }
            // setup's Add this computer: the same link as the Servers menu's; answers once it is done (linked) or not
            case "connect": Task { done(self.thisMacState(problem: await self.connectThisComputer())) }
            case "folder": done(self.chooseFolder())
            case "files": done(pickedFilesReply(self.pickedFiles, here: self.runsHere && self.server != nil))
            default: Task { done(await self.startThisMac()) }
            }
        }
        account.window = { [weak self] in self?.webView.window }
        view.onPublishPack = { [weak self] text, done in
            guard let self else { return done(["state": "off"]) }
            self.account.publish(text, done: done)
        }
        account.signedIn = { [weak self] profile in self?.ownerProfile(profile) }
        view.onAccount = { [weak self] ask, done in
            guard let self else { return done(["state": "off"]) }
            if ask == "status" || ask == "offered" {
                Task { done(await self.account.status()) }
            } else if ask == "signout" {
                Task { done(await self.account.signOut()) }
            } else if ask.hasPrefix("unlink:") {
                Task { done(await self.account.unlink(String(ask.dropFirst(7)))) }
            } else if ask.hasPrefix("link:") {
                self.account.signIn(String(ask.dropFirst(5)), link: true, done: done)
            } else {
                self.account.signIn(ask, done: done)
            }
        }
        noteCenter.open = { [weak self] href, id in
            Task { @MainActor in self?.noteClicked(href: href, id: id) }
        }
        UNUserNotificationCenter.current().delegate = noteCenter
        serverWatch = server?.$state.sink { [weak self] state in
            MainActor.assumeIsolated { self?.serverChanged(state) }
        }
        server?.onReady = { [weak self] in self?.serverReady() }
        aiOn = UserDefaults.standard.bool(forKey: aiKey)
        pluginCount = PluginRecord.live.load().on.count
        markDevice()
        if runsHere {
            startServer()   // the page and the AI runner wait for it
        } else if current != nil {
            open("/")
            if aiOn { startAI() }
        }
        // back at the app (maybe after installing claude in Terminal): this Mac reports its coding tools again
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.runner?.reportNow() }
        }
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        // a plug-in that is on takes up the changes to its folder (Plugins.swift)
        Timer.scheduledTimer(withTimeInterval: pluginLookSeconds, repeats: true) { [weak self] _ in
            Task { @MainActor in await self?.pluginLook() }
        }
        Task { await refresh() }
    }

    /// Where the window has no server: nothing loads, nothing is polled, no runner starts.
    private static let noServer = URL(string: "about:blank")!

    private static func url(of id: String?, in list: [ServerEntry], local: LocalServer?) -> URL {
        if id == thisMacID, let local { return local.url }
        return list.first { $0.id == id }.flatMap { siteURL(from: $0.url) } ?? noServer
    }

    var hasServer: Bool { current != nil }

    // MARK: servers (Servers.swift)

    /// This Mac (with the server in this build) and the added servers, in menu order.
    var listed: [ServerEntry] { listedServers(servers + accountComputers, hasLocal: server != nil) }

    var currentName: String? { listed.first { $0.id == current }?.name }

    /// The window opens this server: This Mac starts the server here, another one stops it (one runner at a time).
    func select(_ id: String?) {
        guard id != current else { return }
        current = id
        UserDefaults.standard.set(id, forKey: currentKey)
        let here = id == thisMacID && server != nil
        if runsHere && !here { server?.stop() }
        runsHere = here
        switchTo(Self.url(of: id, in: listed, local: server))
        if here {
            startServer()
        } else if hasServer {
            open("/")
        } else {
            webView.loadHTMLString("", baseURL: nil)
        }
    }

    /// "Add server": the address (or a pasted one-time sign-in link), added once and opened. Returns what's wrong, or nil.
    @discardableResult func addServer(_ text: String, name: String = "") -> String? {
        guard let input = serverInput(text) else {
            return "Use the server's address, such as https://tools.example.com (http only for this Mac)."
        }
        let added = addingServer(input.url, name: name, to: servers)
        saveServers(added.servers)
        select(added.id)
        if let path = input.signInPath { open(path) }   // signs the window in on that server
        showWindow()
        return nil
    }

    func removeServer(_ id: String) {
        let next = removingServer(id, from: servers, current: current)
        saveServers(next.servers)
        if next.current != current { select(next.current) }
    }

    func renameServer(_ id: String, to name: String) {
        saveServers(renamingServer(id, to: name, in: servers))
    }

    private func saveServers(_ list: [ServerEntry]) {
        servers = list
        UserDefaults.standard.set(try? JSONEncoder().encode(list), forKey: serversKey)
        markDevice()
    }

    /// This Mac is a Settings section in the page (Settings → This Mac, ThisMacBridge.swift); the window keeps the rest.
    /// The page learns this Mac's device id on the open server (html data-mac-device), for its AI line.
    private func markDevice() {
        (webView as? AppWebView)?.macDevice = hasServer ? DeviceVault.deviceID(for: base.host ?? "") : nil
    }

    /// The guide's two network checks for https://<domain>: HTTPS valid, the app answers (GET /api/health).
    func probe(_ url: URL) async -> (https: GuideCheck, reachable: GuideCheck) {
        var request = URLRequest(url: url.appendingPathComponent("api/health"), timeoutInterval: 10)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            return healthChecks(status: (response as? HTTPURLResponse)?.statusCode, body: data, error: nil)
        } catch {
            return healthChecks(status: nil, body: nil, error: error)
        }
    }

    /// The guide's last check: the window's cookies for that server sign it in (GET /api/auth/check).
    func signedIn(at url: URL) async -> Bool {
        let all: [HTTPCookie] = await withCheckedContinuation { continuation in
            webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        let check: AuthCheck? = try? await Site(base: url, cookies: cookies(for: url, in: all)).get("/api/auth/check")
        return check?.authed ?? false
    }

    // MARK: the server on this Mac (Server.swift)

    private func startServer() {
        webView.loadHTMLString(splashPage(), baseURL: nil)
        server?.start()
    }

    /// The server answers: the window signs in as the owner by itself and leaves the starting (or stopped) page. The AI
    /// comes on here only when it was on before; a first run leaves it off until the person presses Connect (startThisMac).
    private func serverReady() {
        if let server { tunnel.start(server: LocalServer.folder, dataDir: server.dataDir) }   // a linked Mac's tunnel comes back
        Task {
            await signIn()
            // after a restart for the plug-ins (Plugins.swift) the window goes back to the page it was on
            let back = pluginWatch.returnTo
            pluginWatch.returnTo = nil
            if !(webView.url.map { isSite($0, base) } ?? false) {
                if let back, isSite(back, base) { webView.load(URLRequest(url: back)) } else { open("/") }
            }
            // ponytail: aiOn is one flag for every site; per environment when the Mac app keeps several (slice 8)
            if startsAIWhenReady(aiOn: aiOn, running: runner != nil) { startAI() }
        }
    }

    /// The owner's sign-in, from the Keychain into the window's WebKit store (POST /api/auth/login). Already signed in:
    /// nothing. It fails only when the data folder's owner has another password: the sign-in page shows then.
    private func signIn() async {
        guard let server else { return }
        if let check: AuthCheck = try? await client().get("/api/auth/check"), check.authed { return }
        let store = webView.configuration.websiteDataStore.httpCookieStore
        for password in server.ownerPasswords() {
            guard let cookies = try? await Site(base: base, cookies: []).postForCookies("/api/auth/login", ["username": LocalServer.ownerName, "password": password]),
                  !cookies.isEmpty else { continue }
            for cookie in cookies { await store.setCookie(cookie) }
            return
        }
        AppLog.write("the window could not sign in as this Mac's owner: the sign-in page shows")
    }

    /// Access from other devices: on needs the owner's own password first (the server refuses another device's sign-in
    /// while it is still APP_SECRET); the window keeps its session through the change. The server restarts on the new
    /// interface. Returns what went wrong, or nil.
    func setOtherDevices(_ on: Bool, password: String? = nil) async -> String? {
        guard let server else { return nil }
        if on && !server.hasOwnerPassword {
            guard let password, password.count >= 10 else { return "Use at least 10 characters." }
            guard let current = server.ownerPasswords().last else { return "The Keychain did not give the server's secret." }
            // the Keychain first: a password the server took but the app lost would lock the window out
            guard server.saveOwnerPassword(password) else { return "The Keychain did not keep the password." }
            do {
                let cookies = try await client().postForCookies("/api/auth/password", ["current": current, "password": password])
                for cookie in cookies { await webView.configuration.websiteDataStore.httpCookieStore.setCookie(cookie) }
            } catch {
                server.forgetOwnerPassword()
                return "Could not set the password: \(error.localizedDescription)"
            }
        }
        server.otherDevices = on
        server.stop()
        startServer()
        return nil
    }

    /// The account's name and email become the owner's profile on the server on this Mac (api/owner-profile.ts).
    private func ownerProfile(_ profile: AccountProfile) {
        guard runsHere else { return }
        Task {
            do {
                try await client().post("/api/owner-profile", ["name": profile.name, "email": profile.email])
            } catch {
                AppLog.write("the server on this Mac did not take the account's profile: \(error.localizedDescription)")
            }
        }
    }

    /// A creatortoolset://account link (the sign-in ended outside the sheet): the code is swapped here and the
    /// window's account step asks again. The code never reaches the page or the log.
    func accountLink(_ code: String) {
        Task {
            await account.link(code: code)
            _ = try? await webView.evaluateJavaScript("dispatchEvent(new Event('ct-account'))")
            showWindow()
        }
    }

    // MARK: data location (This Mac)

    /// Move… : the window shows a message while the server is stopped; the runner restarts on the new folder.
    func moveData(to dest: URL) async -> String? {
        guard let server else { return nil }
        stopRunner()
        webView.loadHTMLString(splashPage("Moving your data…"), baseURL: nil)
        let problem = await server.move(to: dest)
        if problem != nil, server.state == .running { open("/") }
        return problem
    }

    func useDataFolder(_ url: URL) {
        stopRunner()
        // this Mac's device token belongs to the old folder's server: pair afresh once the new one answers
        let host = base.host ?? ""
        DeviceVault.remove(for: host)
        DeviceVault.setDeviceID(nil, for: host)
        markDevice()
        server?.useFolder(url)
    }

    private func serverChanged(_ state: LocalServer.State) {
        guard let server else { return }
        // a fine state has no line: only starting and a failure say anything
        switch state {
        case .off, .running:
            serverLine = nil
            serverProblem = nil
        case .starting:
            serverLine = "Starting the server…"
            serverProblem = nil
        case .failed(let why):
            serverLine = why
            serverProblem = why
            if runsHere { webView.loadHTMLString(messagePage(why), baseURL: nil) }
        }
    }

    /// Try again (the window's card, This Mac): the server starts once more, with its crash count reset.
    func retryServer() { server?.retry() }

    /// "Run the server on this Mac" (This Mac): on = the window opens it; off = the first added server, or none.
    func setRunsHere(_ on: Bool) {
        guard server != nil else { return }
        select(on ? thisMacID : servers.first?.id)
    }

    func setServerPort(_ port: Int) {
        guard let server, port != server.port else { return }
        server.stop()
        server.port = port
        switchTo(server.url)
        startServer()
    }

    func openServerLog() {
        if !FileManager.default.fileExists(atPath: ServerLog.path) { AppLog.append(Data(), to: ServerLog.path) }
        NSWorkspace.shared.open(URL(fileURLWithPath: ServerLog.path))
    }

    // MARK: menu bar state

    /// The menu bar icon's dot (MenuIcon.swift).
    var status: MenuStatus {
        var failed = false
        if case .failed = server?.state { failed = runsHere }
        let s = menuStatus(serverFailed: failed, serverUp: runsHere && server?.state == .running, aiOn: aiOn,
                           aiRunning: ai.running, aiError: ai.lastError != nil, lowSpace: spaceLine != nil)
        return s != .problem && !rows.active.isEmpty ? .busy : s
    }

    var rows: (active: [ActivityRow], forYou: [ActivityRow]) {
        activityRows(sessions: sessions, aiRunning: aiOn ? ai.running : 0, plugin: pluginRows)
    }

    var aiLine: String {
        guard aiOn else { return "AI on this Mac: off" }
        return ai.running > 0 ? "AI on this Mac: running \(ai.running)" : "AI on this Mac: on"
    }

    /// The Mac's device is known for this site (paired once); "Remove this Mac from my account" needs it.
    var pairedHere: Bool { DeviceVault.deviceID(for: base.host ?? "") != nil }

    // MARK: window and site

    func open(_ href: String) {
        guard hasServer, let url = URL(string: href, relativeTo: base)?.absoluteURL else { return }
        if isSite(url, base) {
            webView.load(URLRequest(url: url))
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    /// A `record-<what>` message from the page (src/lib/mac-record.ts). Every one answers with the recorder's state.
    private func recorderCommand(_ what: String) {
        // "<verb>:<id>[:<rest>]": the rest (a look's JSON) may hold colons itself
        let parts = what.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        let project = parts.count > 1 ? ProjectStore.project(id: parts[1], root: recorder.folder) : nil
        switch parts[0] {
        case "toolbar": recorder.openToolbar()
        case "stop": recorder.stop()
        case "folder": recorder.pickFolder()
        case "show": recorder.showFolder()
        case "list": pushRecordings()
        case "look":
            if let project, parts.count == 3 {
                do { try project.writeLook(Data(parts[2].utf8)) } catch { AppLog.write("recording look not saved: \(error.localizedDescription)") }
            }
        case "share":
            if let project, parts.count == 3, let destination = ShareDestination(rawValue: parts[2]) {
                Task { await recorder.share(project, to: destination) }
            }
        case "reveal": if let project { NSWorkspace.shared.activateFileViewerSelecting([project.screenURL]) }
        case "trash": if let project { recorder.delete(project) }   // the page has asked
        case "delete": if let project { recorder.delete(project, asking: true) }   // a page from before "trash"
        case "alpha-stop": alphaTask?.cancel()   // the editor's Stop while its see-through video is made
        default: break   // "state": only the answer
        }
        pushRecorderState()
    }

    /// The recordings on this Mac, for the /record page ('mac-recordings').
    private func pushRecordings() {
        let items = recorder.recordings.map(\.listing)
        guard let data = try? JSONSerialization.data(withJSONObject: ["items": items]), let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mac-recordings', {detail: \(json)}))")
    }

    /// A message in the app's own dialog instead of the system's alert: the window comes forward and the page draws
    /// it (AppDialogs sets window.ctAlert). `done` hears false when no page can: no server, or a page without it.
    private func pageAlert(_ title: String, _ text: String, _ done: @escaping (Bool) -> Void) {
        guard hasServer, let data = try? JSONSerialization.data(withJSONObject: [title, text]),
              let said = String(data: data, encoding: .utf8) else { return done(false) }
        showWindow()
        webView.evaluateJavaScript("window.ctAlert ? (window.ctAlert(...\(said)), true) : false") { shown, _ in done(shown as? Bool == true) }
    }

    /// How the see-through video stands, for the editor that waits on it ('mac-alpha'): "making" (`part` 0 to 1),
    /// then "done", "failed" or "cancelled".
    private func pushAlpha(_ state: String, part: Double = 0) {
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mac-alpha', {detail: {state: '\(state)', part: \(part)}}))")
    }

    private func pushRecorderState(_ phase: Recorder.Phase? = nil) {
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mac-recorder', {detail: \(recorder.pageState(phase))}))")
    }

    func showWindow(href: String? = nil) {
        if let href { open(href) }
        NSApp.setActivationPolicy(.regular)   // back in the Dock (closing the last window takes it out)
        openWindowID?("main")
        NSApp.activate(ignoringOtherApps: true)
    }

    func openThisMac() {
        NSApp.setActivationPolicy(.regular)
        openWindowID?("this-mac")
        NSApp.activate(ignoringOtherApps: true)
    }

    /// A pill row's button (LaunchAgent.swift): start, stop or restart the agent, off the main thread; a failure shows in
    /// the panel's notice, and the rows load again.
    func runAgent(_ action: PluginAction) {
        Task.detached {
            let problem = LaunchAgent.run(verb: action.run, label: action.label)
            await MainActor.run { [weak self] in
                self?.notice = problem
                Task { await self?.refresh() }
            }
        }
    }

    /// "Settings…": the server's Settings in the window; with no server picked, This Mac (Servers is there).
    func openSettings() {
        if hasServer { showWindow(href: "/settings") } else { openWindowID?("this-mac"); NSApp.activate(ignoringOtherApps: true) }
    }

    /// The notes and the AI runner follow the window's address.
    private func switchTo(_ url: URL) {
        base = url
        markDevice()
        Task { await refresh() }
        stopRunner()
        ai = AIStatus()
        // a token is per site: pair again if this one has none (the server on this Mac: once it answers, serverReady)
        if aiOn && !runsHere && hasServer { startAI() }
    }

    func openAppLog() {
        if !FileManager.default.fileExists(atPath: AppLog.path) { AppLog.write("log started") }
        NSWorkspace.shared.open(URL(fileURLWithPath: AppLog.path))
    }

    /// The provider page's Sign in button: writes the CLI's login as a .command file under Application Support and opens
    /// it, so Terminal runs it. Only the CLIs in signInCommands; the home must be a folder under the user's home.
    /// Terminal needs no Apple Events permission for this. Coming back to the app re-reports this Mac's sign-ins (init's
    /// didBecomeActive observer), which the page reads while it waits. Muse Code needs no Terminal: Meta's page opens in
    /// the browser, and a sheet says the code that page asks to confirm.
    func signIn(driver: String, home: String) {
        let userHome = FileManager.default.homeDirectoryForCurrentUser
        if driver == "musecode", let path = binary(driver, home: userHome) {
            return museLogin.start(binary: path) { page, code in
                DispatchQueue.main.async { [weak self] in
                    NSWorkspace.shared.open(page)
                    let a = NSAlert()
                    a.messageText = "Sign in to Muse Code in your browser"
                    a.informativeText = "Meta's page asks you to confirm this code: \(code)"
                    if let window = self?.webView.window { a.beginSheetModal(for: window) } else { a.runModal() }
                }
            }
        }
        do {
            let folder = home.isEmpty ? "" : try checkedHome(home, root: userHome)
            guard let path = binary(driver, home: userHome),
                  let script = signInScript(driver: driver, home: folder, binary: path) else {
                return AppLog.write("sign in: \(driver) has no sign-in on this Mac")
            }
            let dir = appSupport.appendingPathComponent("sign-in", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let file = dir.appendingPathComponent("\(driver).command")
            try script.write(to: file, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            NSWorkspace.shared.open(file)
        } catch {
            AppLog.write("sign in: \(error.localizedDescription)")
        }
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

    private func startAI() { _ = bringUpAI() }

    /// The pairing in progress, so a second press joins it instead of pairing again.
    private var pairing: Task<Bool, Never>?

    /// Pairs this Mac with the open site once, then starts the runner. The task's value: whether the runner is running.
    private func bringUpAI() -> Task<Bool, Never> {
        if let pairing { return pairing }
        let task = Task { () -> Bool in
            defer { pairing = nil }
            guard hasServer else { return false }
            if DeviceVault.token(for: base.host ?? "") == nil {
                do {
                    try await pairThisMac()
                } catch {
                    setAIOff("Could not pair this Mac: \(error.localizedDescription)")
                    return false
                }
                guard aiOn else { return false }   // turned off while pairing: the pairing stays, no runner
            }
            startRunner()
            return runner != nil
        }
        pairing = task
        return task
    }

    /// The page's Connect (TitleBar.swift, bridge "thisMac" start): turns the AI on, pairs this Mac and waits for that,
    /// so the page's next check finds the device. Replies with the state.
    func startThisMac() async -> [String: Any] {
        guard hasServer else { return thisMacState() }
        if !aiOn { setAI(true) }
        if await bringUpAI().value { runner?.reportNow() }
        return thisMacState()
    }


    /// POST /api/devices with the window's cookies: the site makes the device and returns its token once.
    private func pairThisMac() async throws {
        let host = base.host ?? ""
        let client = await client()
        let name = Host.current().localizedName ?? macHostName()
        let data = try await client.postData("/api/devices", ["name": name, "version": appVersion])
        let pair = try JSONDecoder().decode(PairReply.self, from: data)
        guard DeviceVault.save(pair.token, for: host) else { throw SiteError.keychain }
        DeviceVault.setDeviceID(pair.device.id, for: host)
        markDevice()
    }

    private func startRunner() {
        let host = base.host ?? ""
        guard runner == nil, let token = DeviceVault.token(for: host) else { return }
        let id = UUID()
        let work = relayFolder(for: base, localData: runsHere ? server?.dataDir : nil)
        let relay = RelayRunner(base: base, token: token, work: work,
            prompt: windowConsentPrompt(window: { [weak self] in self?.webView.window }),
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
        markDevice()
        setAIOff("This Mac was removed from your account. Turn it on again to pair it.")
    }

    private func setAIOff(_ message: String?) {
        stopRunner()
        aiOn = false
        UserDefaults.standard.set(false, forKey: aiKey)
        ai = AIStatus()
        notice = message
    }

    /// "Remove this Mac from my account": stops it, drops its token here and asks the site to remove the device.
    func forgetThisMac() {
        let host = base.host ?? ""
        let id = DeviceVault.deviceID(for: host)
        setAIOff(nil)
        DeviceVault.remove(for: host)
        DeviceVault.setDeviceID(nil, for: host)
        markDevice()
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
        if runsHere, let server, let free = freeBytes(server.dataDir) {
            spaceLine = free < lowSpaceBytes ? "Only \(bytesText(free)) free on the data disk" : nil
        } else {
            spaceLine = nil
        }
        guard hasServer else {
            sessions = []
            pluginRows = []
            pluginMenu = []
            appTools = []
            return
        }
        Task { accountComputers = await brokerComputers() }   // a slow or down broker must not hold up the badge and notes
        let client = await client()
        sessions = (try? await client.get("/api/workshop/sessions/summary")) ?? []
        pluginRows = (try? await client.get("/api/activity")) ?? []
        let items: [PluginMenuItem] = (try? await client.get("/api/activity/menu")) ?? []
        pluginMenu = pluginMenuItems(items)
        appTools = appToolItems((try? await client.get("/api/activity/tools")) ?? [])
        do {
            let notes: NotesResponse = try await client.get("/api/review/notifications")
            unread = notes.unread
            NSApplication.shared.dockTile.badgeLabel = notes.unread > 0 ? "\(notes.unread)" : nil
            let seen = UserDefaults.standard.stringArray(forKey: seenKey)
            let fresh = freshNotes(notes.items, seen: seen)
            if !fresh.isEmpty {
                // the first note that needs a Mac notification is when macOS is asked (with a line first); the seen list
                // waits too, so a note is not lost while the app is in the background
                let status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
                switch notePostStep(undetermined: status == .notDetermined, appActive: NSApp.isActive,
                                    asked: UserDefaults.standard.bool(forKey: notesAskedKey)) {
                case .wait: return
                case .askFirst: await askForNotifications()
                case .post: break
                }
                fresh.forEach(post)
            }
            UserDefaults.standard.set(rememberedIDs(notes.items, seen: seen), forKey: seenKey)
        } catch {
            // not signed in yet: the window signs in
        }
    }

    /// The line before macOS's own notification prompt: once, when the first Review note needs a notification.
    private func askForNotifications() async {
        UserDefaults.standard.set(true, forKey: notesAskedKey)
        let a = NSAlert()
        a.messageText = "Get a Mac notification when something is ready to review?"
        a.informativeText = "Creator Toolset tells you when a video or a note is waiting for your review. macOS asks next. You can change this later in System Settings → Notifications."
        a.addButton(withTitle: "Continue")
        a.addButton(withTitle: "Not now")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
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
        // The screen recording editor's packed picture is not a video to keep: it becomes a see-through video
        // (downloadDidFinish). That one is about 3 GB a minute, so where it goes is asked (the dialog remembers the
        // folder), and the packed picture waits in that same folder: nothing of it lands on another disk.
        if let alpha = alphaDownload(named: suggestedFilename) {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = alpha.name + ".mov"
            panel.allowedContentTypes = [.quickTimeMovie]
            let chosen = { [weak self] (response: NSApplication.ModalResponse) in
                guard let self, response == .OK, let final = panel.url else {
                    self?.pushAlpha("cancelled")
                    return completionHandler(nil)
                }
                let file = alphaWorkFile(beside: final, ext: "mp4")
                self.alphaDownloads[download] = (file, final, alpha.stacked)
                completionHandler(file)
            }
            if let window = webView.window { panel.beginSheetModal(for: window, completionHandler: chosen) } else { panel.begin(completionHandler: chosen) }
            return
        }
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        completionHandler(uniqueURL(in: folder, named: suggestedFilename))
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let alpha = alphaDownloads.removeValue(forKey: download) { try? FileManager.default.removeItem(at: alpha.file) }
        pushAlpha("failed")   // an editor waiting on its see-through video stops waiting (one that failed before it had a place too)
        _ = dialog("The download failed: \(error.localizedDescription)", buttons: ["OK"])
    }

    /// A packed see-through video has arrived: it becomes the .mov that was asked for, shown in Finder when it is
    /// there. The editor hears how far it is, and its Stop ends it.
    func downloadDidFinish(_ download: WKDownload) {
        guard let alpha = alphaDownloads.removeValue(forKey: download) else { return }
        alphaTask = Task {
            do {
                try await makeAlphaVideo(packed: alpha.file, stacked: alpha.stacked, to: alpha.final) { [weak self] part in
                    DispatchQueue.main.async { self?.pushAlpha("making", part: part) }
                }
                pushAlpha("done")
                NSWorkspace.shared.activateFileViewerSelecting([alpha.final])
            } catch where Task.isCancelled || error is CancellationError {
                pushAlpha("cancelled")   // Stop in the editor: nothing is left of it, and nothing failed
            } catch {
                pushAlpha("failed")
                // the system's own errors say little alone ("Cannot Open"): its reason goes with it ("This media may be damaged.")
                let e = error as NSError
                let why = [e.localizedDescription, e.localizedFailureReason].compactMap { $0 }.joined(separator: ". ")
                _ = dialog("The transparent video could not be made: \(why)", buttons: ["OK"])
            }
            alphaTask = nil
        }
    }

    /// The assistant's mic: the open server's page gets it without a second WebKit prompt; macOS still asks once
    /// (NSMicrophoneUsageDescription, build-app.sh).
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host.lowercased() == base.host?.lowercased() ? .grant : .deny)
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
        let done: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            // remembered first: the page asks where they are ("files") as soon as it has them
            if response == .OK, let self { self.pickedFiles = rememberPicks(panel.urls, in: self.pickedFiles) }
            completionHandler(response == .OK ? panel.urls : nil)
        }
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

    /// A POST whose answer sets the session cookie (sign-in, a new password): the cookies it set.
    func postForCookies(_ path: String, _ body: [String: Any]) async throws -> [HTTPCookie] {
        let (_, response) = try await send("POST", path, body: body)
        let headers = ((response as? HTTPURLResponse)?.allHeaderFields as? [String: String]) ?? [:]
        return HTTPCookie.cookies(withResponseHeaderFields: headers, for: base)
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

/// GET /api/auth/check: whether the window's cookie signs it in.
struct AuthCheck: Decodable {
    let authed: Bool
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
