// The window's web view and the Mac-side state the menu bar shows. No secrets are kept here:
// every request to the site sends the web view's own cookies (WebKit's store), so logging in
// once in the window is enough.
import AppKit
import Combine
import UniformTypeIdentifiers
import UserNotifications
import WebKit

@MainActor
final class Shell: NSObject, ObservableObject {
    /// Sign in with Google / Apple / GitHub to the site this window shows (SiteSignIn.swift).
    private let siteSignIn = SiteSignIn()
    let webView: WKWebView
    @Published private(set) var base: URL
    @Published private(set) var unread = 0
    /// The menu bar panel's Workshop rows (Activity.swift), from the open server.
    @Published private(set) var sessions: [SessionRow] = []
    /// The rows the server's plug-ins add (GET /api/activity), shown with the sessions.
    @Published private(set) var pluginRows: [PluginRow] = []
    /// The menu items the server's plug-ins add (GET /api/activity/menu): the Go menu and Settings & More (PluginMenu.swift).
    @Published private(set) var pluginMenu: [PluginMenuItem] = []
    /// How many plug-ins the person has switched on (Plugins.swift, the record in the Keychain): This Mac's Plug-ins row.
    @Published internal(set) var pluginCount = 0
    /// What the look at the plug-ins' folders remembers between looks (Plugins.swift pluginLook).
    let pluginWatch = PluginWatch()
    /// The Go menu's own tools (GET /api/activity/tools, PluginMenu.swift): the server's list for this account.
    @Published private(set) var appTools: [AppToolItem] = []
    @Published internal(set) var notice: String?
    /// This Mac as an AI device (Relay.swift): on = the person turned it on for the window's server; ai = what that
    /// server's runner reports. Every server this Mac is switched on for has its runner (Runners.swift).
    @Published private(set) var aiOn = false
    var ai: AIStatus { runners.windowStatus }
    /// Opens a window by its scene id ("main", "this-mac", "guide"); the main window sets it when it appears.
    var openWindowID: ((String) -> Void)?
    /// Screen recording (Recorder.swift): started from the page, the menu bar or the Record menu.
    let recorder = Recorder()
    /// The server on this Mac (Server.swift), when this build has one; runsHere = the window uses it, not a site.
    let server: LocalServer? = LocalServer.folder == nil ? nil : LocalServer()
    @Published private(set) var runsHere = false
    /// One runner and one worker per server this Mac takes work from, whatever the window shows (Runners.swift).
    let runners = Runners()
    /// The Download location workers were last started with (nil: not read yet this launch; .some(nil): the default).
    private var lastLocation: String?? = nil
    /// "Take work from this server", per server; a change starts or stops that server's runner.
    private var switches: HostSwitches {
        didSet {
            aiOn = hasServer && switches.aiOn(base.host ?? "")
            syncRunners()
        }
    }
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
    @Published internal(set) var accountComputers: [ServerEntry] = [] {
        didSet { if accountComputers != oldValue { syncRunners() } }
    }
    /// Reach from anywhere's state for the page (Connect.swift refreshReach), and when the link was last tried by itself.
    var reach: Reach = .signedOut
    var lastReachTry: Date?
    /// The relay token and the account's computers, kept between refreshes (Connect.swift BrokerCache).
    var broker = BrokerCache()

    private let noteCenter = NoteCenter()
    private var timer: Timer?
    private let seenKey = "seenNotificationIDs"
    private let notesAskedKey = "notificationsAsked"
    private let serversKey = "servers"
    private let currentKey = "currentServer"
    /// The page the window was on when an update relaunched the app (rememberPageForRelaunch), opened again once.
    private let pageBeforeUpdateKey = "pageBeforeUpdate"
    private var updateWatch: AnyCancellable?
    /// The window's server's runner.
    var runner: RelayRunner? { runners.relay(for: base.host) as? RelayRunner }
    private let museLogin = MuseLogin()
    private let antigravityLogin = AntigravityLogin()

    private var lastBlankReload = Date.distantPast
    /// The editor's packed see-through videos on their way in (AlphaVideo.swift): where each is kept, and the video it becomes.
    private var alphaDownloads: [WKDownload: (file: URL, final: URL, stacked: Bool)] = [:]
    /// Every other download, by where it goes: shown in Finder when it is there (owner, 2026-11-12: "Okay, downloaded,
    /// but it's like from where and what and how").
    private var plainDownloads: [WKDownload: URL] = [:]
    /// The screen editor's export: the name the page asked with and where it goes, asked before it is made (askExportPlace)
    private var exportPlace: (name: String, url: URL, reveal: Bool)?
    /// Exports on their way to the place asked for, with the name the page asked with: it hears 'mac-saved' when each is there
    private var exportDownloads: [WKDownload: (name: String, reveal: Bool)] = [:]
    /// The see-through video being made; the page's Stop ends it ("record-alpha-stop").
    private var alphaTask: Task<Void, Never>?
    /// Recordings whose camera file is being searched for the face (findFaces).
    private var facesRunning = Set<String>()

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
        // the servers paired before the switch was per server keep the old switch's value (LocationAgents' list)
        let paired = ([server?.url] + list.map { siteURL(from: $0.url) }).compactMap { $0?.host }
        switches = HostSwitches(paired: paired.filter { DeviceVault.token(for: $0) != nil })
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
        updateWatch = UpdateWhenIdle.shared.$held.sink { [weak view] held in
            DispatchQueue.main.async { view?.macUpdate = held }
        }
        // the menu's rows and counts follow every server's runner and worker
        runners.onChange = { [weak self] in self?.objectWillChange.send() }
        runners.make = { [unowned self] host, url, token, id in self.startRunner(host: host, url: url, token: token, id: id) }
        runners.windowHost = current == nil ? nil : base.host
        // only the window's server may ask this Mac anything (Consent.swift)
        Consent.show(current == nil ? nil : Consent.key(for: base))
        recorderWatch = recorder.$phase.sink { [weak self] phase in
            DispatchQueue.main.async { self?.pushRecorderState(phase) }
        }
        recorder.upload = { [weak self] project, destination, workspace, progress in
            guard let self else { throw SiteError.status(0) }
            var site = await self.client()
            site.workspace = workspace
            if workspace == nil { site.workspace = await self.pageWorkspace() }   // the /record page's Share: the window's workspace
            let page = try await site.uploadRecording(project, to: destination, progress: progress)
            // picked on the panel: the page opens in that workspace (src/lib/workspace.ts openedIn), so a guide made there lands there too
            guard let workspace, let ws = workspace.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(.init(charactersIn: "-_"))) else { return page }
            return page + (page.contains("?") ? "&" : "?") + "ws=\(ws)"
        }
        recorder.workspaces = { [weak self] in
            guard let self else { return ([], nil) }
            let got: RecordWorkspaces? = try? await self.client().get("/api/workshop/workspace", timeout: 10)
            let here = await self.pageWorkspace()
            return (got?.projects ?? [], here ?? got?.currentProjectId)
        }
        recorder.onRecordingsChanged = { [weak self] in self?.pushRecordings() }
        recorder.pageAlert = { [weak self] title, text, done in
            guard let self else { return done(false) }
            self.pageAlert(title, text, done)
        }
        if Recorder.available { RecordShortcut.shared.install(recorder) }
        // after the recording shortcut: its hotkey handler runs first and passes on every other hotkey
        Dictation.shared.languages = { [weak self] in await self?.voiceLanguages() }
        Dictation.shared.site = { [weak self] in self?.hasServer == true ? await self?.client() : nil }
        // this Mac's dictation models are its speech models on the Voice page: a change here is claimed at once
        SpeechModels.shared.onChange = { [weak self] in self?.runners.forEach { $0.modelsChanged() } }
        Dictation.shared.start()
        recorder.openPage = { [weak self] in self?.showWindow(href: $0) }
        view.onThisMacCommand = { [weak self] in self?.thisMacCommand($0) }
        view.onThisMacAsk = { [weak self, weak view] ask, done in
            guard let self else { return done(["aiOn": false, "paired": false]) }
            // Face Blur's page (FaceBlurBridge.swift): the files it may take are the ones picked or dropped in this window
            if faceBlurAsk(ask) == .pick { return self.faceBlurPick(in: view?.window, done) }
            if isFaceBlurAsk(ask) {
                let allowed = Set((self.pickedFiles + (view?.droppedFiles ?? [])).map(\.path))
                if let trial = faceBlurAsk(ask), case .trial = trial {
                    Task { done(await FaceBlurTrial.shared.answer(trial, allowed: allowed)) }
                    return
                }
                return done(FaceBlurJobs.shared.answer(ask, allowed: allowed))
            }
            // Show in Finder for a library clip or a Review version's own file (Reveal.swift): the path comes from the
            // window's server; one elsewhere only a video, sound or picture file
            if isRevealAsk(ask) {
                // a copy of the library: the page names the folder, its marker must be that copy's
                if let c = copyRevealAsk(ask) {
                    Task { done(await Reveal.answerCopy(c.path, library: c.library, copy: c.copy)) }
                    return
                }
                // a Settings → Folders folder: only one the window's server lists as this Mac's
                if let path = folderRevealAsk(ask) {
                    var hosts: Set<String> = self.runsHere ? ["this-computer"] : []
                    if let id = DeviceVault.deviceID(for: self.base.host ?? "") { hosts.insert(id) }
                    Task { done(await Reveal.answerFolder(path, listed: Reveal.ownFolders(await self.client().listedFolders(), hosts: hosts))) }
                    return
                }
                // this Mac's kept proxy of a version: only the one in the proxy folder of this window's account
                if let version = proxyRevealAsk(ask) {
                    let folder = ProxyCache.allowed(page: self.base)
                    Task { done(await Reveal.answerProxy(version, folder: folder)) }
                    return
                }
                let clip = revealAsk(ask), review = reviewRevealAsk(ask)
                guard clip != nil || review != nil else { return done(["problem": Reveal.problem]) }
                let here = self.runsHere && self.server != nil
                let device = DeviceVault.deviceID(for: self.base.host ?? "")
                Task {
                    let path = if let review { await self.client().reviewPath(asset: review.asset, n: review.n) }
                               else { await self.client().clipPath(library: clip!.library, asset: clip!.asset, version: clip!.version, device: device) }
                    done(await Reveal.answer(path, anyFile: here))
                }
                return
            }
            // here or away (Places.swift): the paths to try come from the window's server, never from the page
            if isPlacesAsk(ask) {
                switch placesAsk(ask) {
                case .check(let library, let versions)?:
                    let device = DeviceVault.deviceID(for: self.base.host ?? "")
                    // the proxy cache is a server elsewhere's (no worker runs for This Mac)
                    let cache = !self.runsHere
                    // what the page may play: this server's folders allowed on this Mac too, not only the open-panel picks
                    let granted = MediaFiles.granted(server: MediaFiles.serverKey(self.base), workspace: nil)
                    Task { done(await Places.shared.answerCheck(library: library, versions: versions, site: await self.client(), device: device, cache: cache, granted: granted)) }
                case .connect(let root)?:
                    // a share this Mac never had asks first, naming this window's server
                    let server = [self.base.host, self.base.port.map(String.init)].compactMap { $0 }.joined(separator: ":")
                    Task { done(await Places.shared.connect(root: root, server: server)) }
                case .search(let library)?:
                    let device = DeviceVault.deviceID(for: self.base.host ?? "")
                    Task { done(PlacesSearch.shared.start(library: library, site: await self.client(), device: device, pressed: true)) }
                case .searchState?:
                    done(PlacesSearch.shared.state)
                case nil:
                    done(["problem": "Not an ask this app knows."])
                }
                return
            }
            // Open in <editor> on an AI Editor draft (Editors.swift): the editors this Mac has, and opening one there
            if ask == "editors" { return done(["editors": Editors.installed().map(\.reply)]) }
            if isEditorAsk(ask) {
                if let back = openEditorAsk(ask, prefix: "take-back-editor:") {
                    Task { done(await Editors.takeBack(back)) }
                    return
                }
                guard let open = openEditorAsk(ask) else { return done(["problem": "Could not open the draft"]) }
                Task { done(await Editors.open(open, site: await self.client())) }
                return
            }
            // the Media Library's imports (Import.swift): a copy reads only from this window's recent drops and picks
            if isImportAsk(ask) {
                return Imports.shared.answer(ask, sources: (self.pickedFiles + (view?.droppedPlaces ?? [])).map(\.path), server: MediaFiles.serverKey(self.base), done: done)
            }
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
            // Settings → Providers → Install on a server that is not this Mac: this Mac's server is not running, so the
            // app runs its installer itself; a tool installed is reported to the open server at once
            if let id = aiInstallAsk(ask) {
                guard let folder = LocalServer.folder else { return done(["ok": false, "problem": "Could not install it here."]) }
                return AiInstall.shared.run(id, folder: folder) { [weak self] reply in
                    if reply["ok"] as? Bool == true { self?.runner?.reportNow() }
                    done(reply)
                }
            }
            if let reply = self.storageAsk(ask) { return done(reply) }
            switch ask {
            case "state": done(self.thisMacState())
            case "ai-install-progress": done(AiInstall.shared.progress)
            case "access": Task { done(await self.accessFromOtherDevices()) }
            case "access:off": Task { done(self.thisMacState(problem: await self.setOtherDevices(false))) }
            // setup's Add this computer: the same link as the Servers menu's; answers once it is done (linked) or not
            case "connect": Task { done(self.thisMacState(problem: await self.connectThisComputer())) }
            // Settings → Computers → Reach from anywhere: the switch, answered once the link (or unlink) is done
            case "connect.link": Task { done(self.thisMacState(problem: await self.setReach(true))) }
            case "connect.unlink": Task { done(self.thisMacState(problem: await self.setReach(false))) }
            case "folder": done(self.chooseFolder())
            // Settings → Folders' "This Mac" on a server it isn't on yet (a press): paired, the AI left as it is
            case "pair": Task { if !self.pairedHere { try? await self.pairThisMac() }; self.syncRunners(); done(self.thisMacState()) }
            case "files": done(pickedFilesReply(self.pickedFiles, here: self.runsHere && self.server != nil))
            default: Task { done(await self.startThisMac()) }
            }
        }
        account.window = { [weak self] in self?.webView.window }
        view.onPublishPack = { [weak self] text, done in
            guard let self else { return done(["state": "off"]) }
            self.account.publish(text, done: done)
        }
        account.leaving = { [weak self] old, new in await self?.leaveAccount(oldToken: old, newToken: new) }
        account.signedIn = { [weak self] profile in
            self?.ownerProfile(profile)
            Task { await self?.refreshReach(force: true) }   // signed in: this Mac joins the account by itself while the switch is on
        }
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
        aiOn = hasServer && switches.aiOn(base.host ?? "")
        pluginCount = PluginRecord.live.load().on.count
        markDevice()
        let back = UserDefaults.standard.url(forKey: pageBeforeUpdateKey).flatMap { isSite($0, base) ? $0 : nil }
        UserDefaults.standard.removeObject(forKey: pageBeforeUpdateKey)
        if runsHere {
            pluginWatch.returnTo = back
            startServer()   // the page and the AI runner wait for it
        } else if current != nil {
            if let back { webView.load(URLRequest(url: back)) } else { open("/") }
            if aiOn { startAI() }
        }
        syncRunners()
        // here or away (Places.swift): a disk came, went, went away or came back; this Mac's report goes now (the
        // server's view of its disks), and the page checks its originals again
        Places.shared.onChange = { [weak self] in
            MainActor.assumeIsolated {
                self?.runners.forEach { $0.reportNow() }
                // the Download location's disk went or came back: each idle worker starts again with the folder playback
                // uses, and what was downloaded meanwhile on the internal disk joins it
                if let self, let last = self.lastLocation, last != DownloadLocation.path() {
                    self.locationMoved()
                    DownloadLocation.settleInBackground { [weak self] in self?.locationMoved() }
                }
                self?.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mac-places', {detail: {at: Date.now()}}))")
            }
        }
        Places.shared.start()
        // quitting (an update's relaunch too): every server's worker group goes, with one grace for all
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.runners.stopAll() }
        }
        // the location agents (LocationAgent.swift): one per server this Mac is paired with, AI on or off
        LocationAgents.shared.start(servers: { [unowned self] in (self.server.map { [$0.url] } ?? []) + self.servers.compactMap { URL(string: $0.url) } },
                                    local: { [unowned self] in self.server?.url })
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

    /// The window opens this server: This Mac starts the server here, another one stops it (and This Mac's runner with it;
    /// the other servers' runners keep running).
    func select(_ id: String?) {
        guard id != current else { return }
        current = id
        UserDefaults.standard.set(id, forKey: currentKey)
        let here = id == thisMacID && server != nil
        if runsHere && !here { Task { await server?.stop() } }
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
        syncRunners()
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
        Task {
            await signIn()
            // This Mac is paired on its first run, AI off: its location agent reports its folders (LocationAgent.swift)
            if runsHere, !pairedHere { try? await pairThisMac() }
            LocationAgents.shared.poke()
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

    /// Network access: the server listens on every interface (on) or on this Mac only (off), and restarts on it. Phones
    /// sign in with a pairing link or through the account, never with a password, so nothing is asked here.
    func setOtherDevices(_ on: Bool) async -> String? {
        guard let server else { return nil }
        server.otherDevices = on
        // another server is open: the one here starts with this when it is opened
        guard runsHere else { return nil }
        await server.stop()
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
        runners.stop(host: server.url.host ?? "")
        webView.loadHTMLString(splashPage("Moving your data…"), baseURL: nil)
        let problem = await server.move(to: dest)
        // another server was opened during the move: the one here stays stopped, and the window stays on that server
        guard runsHere else { await server.stop(); return problem }
        if problem != nil, server.state == .running { open("/") }
        return problem
    }

    func useDataFolder(_ url: URL) {
        // this Mac's device token belongs to the old folder's server: pair afresh once the new one answers
        let host = server?.url.host ?? base.host ?? ""
        runners.stop(host: host)
        DeviceVault.remove(for: host)
        DeviceVault.setDeviceID(nil, for: host)
        markDevice()
        Task { await server?.useFolder(url) }
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
        // This Mac's runner only while its server runs (the sink runs before `state` changes: the new one is passed)
        syncRunners(localRunning: state == .running)
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
        Task {
            await server.stop()
            server.port = port
            switchTo(server.url)
            startServer()
        }
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
        // the counts are every server's; the error dot is only the window's server's (another one's goes to the log)
        let s = menuStatus(serverFailed: failed, serverUp: runsHere && server?.state == .running, aiOn: !runners.isEmpty,
                           aiRunning: runners.running, aiError: ai.lastError != nil, lowSpace: spaceLine != nil)
        return s != .problem && !rows.active.isEmpty ? .busy : s
    }

    var rows: (active: [ActivityRow], forYou: [ActivityRow]) {
        var rows = activityRows(sessions: sessions, aiRunning: runners.running, plugin: pluginRows, drawing: runners.drawing)
        rows.active.insert(contentsOf: runners.workRows, at: 0)
        return rows
    }

    /// This Mac's work for every server it takes work from.
    var aiLine: String {
        guard !runners.isEmpty else { return "Taking work: off" }
        return runners.running > 0 ? "Taking work: running \(runners.running)" : "Taking work: on"
    }

    /// The Mac's device is known for this site (paired once); "Remove this Mac from the account" needs it.
    var pairedHere: Bool { DeviceVault.deviceID(for: base.host ?? "") != nil }

    // MARK: window and site

    /// Just before an update relaunches the app: the page it is on, for the next launch.
    func rememberPageForRelaunch() {
        if let url = webView.url, isSite(url, base) { UserDefaults.standard.set(url, forKey: pageBeforeUpdateKey) }
    }

    func open(_ href: String) {
        guard hasServer, let url = URL(string: href, relativeTo: base)?.absoluteURL else { return }
        if isSite(url, base) {
            webView.load(URLRequest(url: url))
        } else if opensOutside(url) {
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
        case "streams": if let project { recorder.saveStreams(project) }   // Save the streams…
        case "faces": if let project { findFaces(project) }   // the editor's Follow my face
        case "trash": if let project { recorder.delete(project) }   // the page has asked
        case "delete": if let project { recorder.delete(project, asking: true) }   // a page from before "trash"
        case "alpha-stop": alphaTask?.cancel()   // the editor's Stop while its see-through video is made
        // the editor's Export, before it is made ("save-for": one the page goes on with, Send to Editor: not shown in Finder)
        case "save-as", "save-for": askExportPlace(parts.dropFirst().joined(separator: ":"), reveal: parts[0] == "save-as")
        case "save-drop": exportPlace = nil   // that export stopped or failed before its download
        default: break   // "state": only the answer
        }
        pushRecorderState()
    }

    /// Where an export goes, asked when Export is pressed (the page's "record-save-as:<file name>"), not after minutes
    /// of making it: the download of that name is then written there. The page hears 'mac-save-as' {ok}.
    private func askExportPlace(_ name: String, reveal: Bool) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = name
        panel.allowedContentTypes = [.mpeg4Movie]
        let chosen = { [weak self] (response: NSApplication.ModalResponse) in
            guard let self else { return }
            let place = response == .OK ? panel.url : nil
            self.exportPlace = place.map { (name, $0, reveal) }
            self.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mac-save-as', {detail: {ok: \(place != nil)}}))")
        }
        if let window = webView.window { panel.beginSheetModal(for: window, completionHandler: chosen) } else { panel.begin(completionHandler: chosen) }
    }

    /// An export asked for with "record-save-as:" is written (path) or failed (nil): 'mac-saved' {name, path}.
    private func pushSaved(_ name: String, _ path: String?) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["name": name, "path": path as Any? ?? NSNull()] as [String: Any]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mac-saved', {detail: \(json)}))")
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
    /// The face in a recording's camera file (CameraFaces.swift), once at a time per recording; the editor follows it
    /// with 'mac-faces' events: "making" (`part` 0 to 1), then "done" or "failed".
    private func findFaces(_ project: LocalProject) {
        let id = project.id
        guard facesRunning.insert(id).inserted else { return }
        let push = { [weak self] (state: String, part: Double) in
            guard let data = try? JSONSerialization.data(withJSONObject: ["id": id, "state": state, "part": part]),
                  let json = String(data: data, encoding: .utf8) else { return }
            self?.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('mac-faces', {detail: \(json)}))")
        }
        var last = -1.0
        Task { @MainActor in
            do {
                try await CameraFaces.make(project) { part in
                    Task { @MainActor in
                        guard part - last >= 0.02 else { return }
                        last = part
                        push("making", part)
                    }
                }
                push("done", 1)
            } catch {
                AppLog.write("faces not found in \(id): \(error.localizedDescription)")
                push("failed", 0)
            }
            facesRunning.remove(id)
        }
    }

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
        if action.run.hasPrefix(workCancelVerb + ":") {
            runners.worker(for: String(action.run.dropFirst(workCancelVerb.count + 1)))?.cancel()
            return
        }
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

    /// The notes, the switch and the menu's error follow the window's address. The runners do not: every server this Mac
    /// is switched on for keeps its own.
    private func switchTo(_ url: URL) {
        base = url
        markDevice()
        Task { await refresh() }
        let host = url.host ?? ""
        runners.windowHost = hasServer ? host : nil
        Consent.show(hasServer ? Consent.key(for: url) : nil)
        // shown again: a pairing that failed is tried again (the didSet syncs the runners and sets aiOn)
        switches.pairFailed.remove(host)
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
    /// the browser, and a sheet says the code that page asks to confirm. Antigravity's Google page opens in the browser too.
    func signIn(driver: String, home: String) {
        let userHome = FileManager.default.homeDirectoryForCurrentUser
        if driver == "antigravity" { return antigravityLogin.start() }
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

    /// The workspace the window's page is in (src/lib/current-workspace.ts sets window.ctWorkspace); nil for a page from before.
    func pageWorkspace() async -> String? {
        let id = (try? await webView.evaluateJavaScript("typeof window.ctWorkspace === 'string' ? window.ctWorkspace : ''")) as? String
        return id?.isEmpty == false ? id : nil
    }

    /// The site's cookies from the web view's store, for the requests below.
    func client() async -> Site {
        let base = self.base   // the site open when asked, not the one opened while the cookies were read
        let all: [HTTPCookie] = await withCheckedContinuation { continuation in
            webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { continuation.resume(returning: $0) }
        }
        return Site(base: base, cookies: cookies(for: base, in: all))
    }

    // MARK: this Mac for the person's AI (Relay.swift)

    /// "Take work from this server", for the window's server only: on pairs this Mac once (signed in to the site in the
    /// window) and starts its runner; off stops that one and keeps the pairing. Other servers' runners are untouched.
    func setAI(_ on: Bool) {
        guard hasServer else { return }
        switches.set(base.host ?? "", on)
        if on { startAI() }
    }

    private func startAI() { _ = bringUpAI() }

    /// The pairings in progress, by site, so a second press joins the open site's instead of pairing again.
    private var pairing: [URL: Task<Bool, Never>] = [:]

    /// Pairs this Mac with the open site once, then starts the runner. The task's value: whether the runner is running.
    private func bringUpAI() -> Task<Bool, Never> {
        let site = base
        if let task = pairing[site] { return task }
        let task = Task { () -> Bool in
            defer { pairing[site] = nil }
            // another server opened meanwhile: its own task pairs and starts the runner there
            guard hasServer, base == site else { return false }
            if DeviceVault.token(for: site.host ?? "") == nil {
                do {
                    try await pairThisMac()
                } catch {
                    if base == site { pairingFailed(site.host ?? "", "Could not add this Mac: \(error.localizedDescription)") }
                    return false
                }
                // turned off, or another server opened, while pairing: the pairing stays, no runner
                guard aiOn, base == site else { return false }
            }
            syncRunners()
            return runners.relay(for: site.host) != nil
        }
        pairing[site] = task
        return task
    }

    /// The page's Connect (TitleBar.swift, bridge "thisMac" start): turns the AI on, pairs this Mac and waits for that,
    /// so the page's next check finds the device. Replies with the state.
    func startThisMac() async -> [String: Any] {
        guard hasServer else { return thisMacState() }
        // paired first, AI still off (its location agent starts on the token); then the AI the page asked for
        if !pairedHere { try? await pairThisMac() }
        if !aiOn { setAI(true) }
        if await bringUpAI().value { runner?.reportNow() }
        return thisMacState()
    }


    /// POST /api/devices with the window's cookies: the site makes the device and returns its token once.
    private func pairThisMac() async throws {
        let client = await client()
        let host = client.base.host ?? ""   // the site the device is made on, whatever is open when it answers
        let name = Host.current().localizedName ?? macHostName()
        let data = try await client.postData("/api/devices", ["name": name, "version": appVersion, "machineId": MachineID.value])
        let pair = try JSONDecoder().decode(PairReply.self, from: data)
        guard DeviceVault.save(pair.token, for: host) else { throw SiteError.keychain }
        DeviceVault.setDeviceID(pair.device.id, for: host)
        markDevice()
        LocationAgents.shared.poke()
    }

    /// Idle workers start again with the Download location as it is now.
    func locationMoved() {
        lastLocation = .some(DownloadLocation.path())
        runners.restartIdleWorkers()
    }

    /// The servers whose runner should run now, and those runners started or stopped to match (Runners.swift).
    /// `localRunning`: whether This Mac's own server runs (passed while its state is changing).
    func syncRunners(localRunning: Bool? = nil) {
        let urls = listed.map { Self.url(of: $0.id, in: listed, local: server) }.filter { $0 != Self.noServer }
        let hosts = runnerHosts(listed: urls, on: { self.switches.runs($0) }, hasToken: { DeviceVault.token(for: $0) != nil },
                                localHost: server?.url.host, localRunning: localRunning ?? (server?.state == .running))
        var wanted: [String: URL] = [:]
        for url in urls { if let host = url.host, hosts.contains(host), wanted[host] == nil { wanted[host] = url } }
        // once a launch, before any worker starts: the caches go to the Download location (its default the first time)
        if lastLocation == nil {
            lastLocation = .some(DownloadLocation.path())
            DownloadLocation.settleInBackground { [weak self] in self?.locationMoved() }
        }
        runners.sync(wanted, token: { DeviceVault.token(for: $0) })
    }

    /// One server's runner and worker (Runners.sync starts it). Its callbacks act only while it is that server's current one.
    private func startRunner(host: String, url: URL, token: String, id: UUID) -> (HostRelay, Worker) {
        let local = host == server?.url.host
        let work = relayFolder(for: url, localData: local ? server?.dataDir : nil)
        let worker = Worker(folder: LocalServer.folder)
        worker.onNeedsUpdate = { UpdateWhenIdle.shared.neededByServer() }
        let relay = RelayRunner(base: url, token: token, work: work,
            prompt: windowConsentPrompt(window: { [weak self] in self?.webView.window }), speech: SpeechModels.link(host: host),
            onStatus: { [weak self] status in
                Task { @MainActor in
                    guard let self, self.runners.isCurrent(host, id) else { return }
                    if let line = self.runners.note(status, host: host) { AppLog.write(line) }
                }
            },
            onRevoked: { [weak self] in
                Task { @MainActor in self?.revoked(host: host, token: token) }
            },
            // from the runner's thread: whether a worker was started now (one runs already, or This Mac: no)
            onWork: { [weak self] in
                DispatchQueue.main.sync {
                    MainActor.assumeIsolated {
                        // a hung worker (silent past silentAfter) is replaced; a busy one never is
                        guard let self, self.runners.isCurrent(host, id), !worker.isRunning || worker.isSilent else { return false }
                        return worker.start(server: url, token: token, data: work.appendingPathComponent("work"), thisMac: local)
                    }
                }
            })
        AppLog.write("[relay] started for \(host)")
        return (relay, worker)
    }

    /// A server no longer knows this Mac (its token was refused): only when that token is still the one in the vault and
    /// in that server's runner, drop it, stop that server's runner and say so. A late refusal from a replaced runner only syncs.
    private func revoked(host: String, token: String) {
        guard runners.refused(host: host, token: token, vault: DeviceVault.token(for: host)) else { return syncRunners() }
        DeviceVault.remove(for: host)
        DeviceVault.setDeviceID(nil, for: host)
        markDevice()
        runners.stop(host: host)
        setAIOff(host: host, removedNotice(serverName(host)))
    }

    /// That server's switch goes off (its runner stops); other servers are untouched.
    private func setAIOff(host: String, _ message: String?) {
        switches.set(host, false)
        notice = message
    }

    /// A pairing failed: no runner for that server until the window shows it again or the app restarts; its switch stays.
    private func pairingFailed(_ host: String, _ message: String) {
        switches.pairFailed.insert(host)
        notice = message
    }

    /// The name the Servers list gives a host, else the host.
    private func serverName(_ host: String) -> String {
        listed.first { Self.url(of: $0.id, in: listed, local: server).host == host }?.name ?? host
    }

    /// "Remove this Mac from the account": stops it, drops its token here and asks the site to remove the device.
    func forgetThisMac() {
        let host = base.host ?? ""
        let id = DeviceVault.deviceID(for: host)
        setAIOff(host: host, nil)
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
        Task { await refreshReach() }   // a slow or down broker must not hold up the badge and notes
        let client = await client()
        sessions = (try? await client.get("/api/workshop/sessions/summary")) ?? []
        let rows: [PluginRow] = (try? await client.get("/api/activity")) ?? []
        activityLogLines(before: pluginRows, after: rows).forEach(AppLog.write)
        pluginRows = rows
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
                if let one = macNote(fresh) { post(one) }
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

    private func post(_ note: MacNote) {
        let content = UNMutableNotificationContent()
        content.title = note.title
        content.body = note.body
        content.sound = .default
        content.userInfo = ["href": note.href, "id": note.ids.joined(separator: ",")]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: note.ids.joined(separator: ","), content: content, trigger: nil))
    }

    private func noteClicked(href: String, id: String) {
        showWindow(href: href)
        Task {
            let client = await client()
            try? await client.post("/api/review/notifications/read", ["ids": id.split(separator: ",").map(String.init)])
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


    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        (webView as? AppWebView)?.wheelPageChanged()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        (webView as? AppWebView)?.wheelPageChanged()
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
        // the login screen's Sign in with Google / Apple / GitHub: in the system's sheet, ending in this window (SiteSignIn.swift)
        if let start = siteSignInStart(url, site: base) {
            siteSignIn.window = { [weak self] in self?.webView.window }
            siteSignIn.start(provider: start.provider, site: base, back: start.back,
                             run: { [weak self] script in self?.webView.evaluateJavaScript(script) },
                             show: { [weak self] back, error in
                                 guard let self, let target = URL(string: back, relativeTo: self.base)?.absoluteURL,
                                       var parts = URLComponents(url: target, resolvingAgainstBaseURL: false) else { return }
                                 parts.queryItems = (parts.queryItems ?? []).filter { $0.name != "error" } + [URLQueryItem(name: "error", value: error)]
                                 if let to = parts.url, isSite(to, self.base) { self.webView.load(URLRequest(url: to)) }
                             })
            return decisionHandler(.cancel)
        }
        let inside = ["about", "blob", "data", "javascript"].contains(url.scheme ?? "") || isSite(url, base)
        if inside {
            decisionHandler(.allow)
        } else {
            if opensOutside(url) { NSWorkspace.shared.open(url) }
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
        // the page's next video after the ask is that export (one at a time; WebKit may change the name it was asked with)
        if let place = exportPlace, suggestedFilename.lowercased().hasSuffix(".mp4") {
            exportPlace = nil
            try? FileManager.default.removeItem(at: place.url)   // the panel asked before replacing it
            plainDownloads[download] = place.url
            exportDownloads[download] = (place.name, place.reveal)
            return completionHandler(place.url)
        }
        let folder = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        let file = uniqueURL(in: folder, named: suggestedFilename)
        plainDownloads[download] = file
        completionHandler(file)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        plainDownloads[download] = nil
        if let export = exportDownloads.removeValue(forKey: download) { pushSaved(export.name, nil) }
        if let alpha = alphaDownloads.removeValue(forKey: download) { try? FileManager.default.removeItem(at: alpha.file) }
        pushAlpha("failed")   // an editor waiting on its see-through video stops waiting (one that failed before it had a place too)
        _ = dialog("The download failed: \(error.localizedDescription)", buttons: ["OK"])
    }

    /// A packed see-through video has arrived: it becomes the .mov that was asked for, shown in Finder when it is
    /// there. The editor hears how far it is, and its Stop ends it.
    func downloadDidFinish(_ download: WKDownload) {
        if let file = plainDownloads.removeValue(forKey: download) {
            let export = exportDownloads.removeValue(forKey: download)
            if let export { pushSaved(export.name, file.path) }   // the page goes on with it
            if export?.reveal ?? true { NSWorkspace.shared.activateFileViewerSelecting([file]) }   // the file, picked in its folder
            return
        }
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

    /// Face Blur's Choose files (`faceblur:pick`): this app's own open panel, on whichever server the window shows. A file
    /// input's pick is told to the page only on this Mac's own server ("files"); these paths go to the Face Blur page, for
    /// its job on this Mac, and join the files Face Blur may take. { paths }, none when the panel is cancelled.
    private func faceBlurPick(in window: NSWindow?, _ done: @escaping ([String: Any]) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.image, .movie]
        let finish: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .OK, let self else { return done(["paths": [String]()]) }
            self.pickedFiles = rememberPicks(panel.urls, in: self.pickedFiles)
            done(["paths": panel.urls.map(\.path)])
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: finish) } else { panel.begin(completionHandler: finish) }
    }

    /// The page's file inputs and drop zones: the Mac's own open panel.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseFiles = true
        panel.canChooseDirectories = parameters.allowsDirectories
        let done: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            // remembered first: the page asks where they are ("files") as soon as it has them; and granted, so what the
            // library indexes from them is read here later (MediaFiles.grantPicked)
            // a pick of another server's Blur faces footage never reaches this page (as a drop, AppWebView.performDragOperation)
            if response == .OK, let self, let refused = MediaFiles.blurredElsewhere(panel.urls.map(\.path), server: MediaFiles.serverKey(self.base)) {
                (webView as? AppWebView)?.refuse(refused)
                return completionHandler(nil)
            }
            if response == .OK, let self {
                self.pickedFiles = rememberPicks(panel.urls, in: self.pickedFiles)
                MediaFiles.grantPicked(panel.urls)
            }
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

private struct RecordWorkspaces: Decodable {
    let currentProjectId: String?
    let projects: [RecordWorkspace]
}

/// The site's API with the window's own session: cookies from WebKit, nothing stored here.
struct Site {
    let base: URL
    let cookies: [HTTPCookie]
    /// The workspace a recording's upload goes to (X-CT-Workspace, api/lib/workspace-scope.ts); nil: the person's stored one.
    var workspace: String? = nil

    /// `timeout`: the longest wait for the server (a server that doesn't answer is a URLError); the system's 60 s by default.
    func get<T: Decodable>(_ path: String, timeout: TimeInterval? = nil) async throws -> T {
        let (data, _) = try await send("GET", path, body: nil, timeout: timeout)
        return try JSONDecoder().decode(T.self, from: data)
    }

    func post(_ path: String, _ body: [String: Any]) async throws {
        _ = try await send("POST", path, body: body)
    }

    /// A GET's raw answer (a timeline file).
    func data(_ path: String) async throws -> Data {
        try await send("GET", path, body: nil).0
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

    private func send(_ method: String, _ path: String, body: [String: Any]?, timeout: TimeInterval? = nil) async throws -> (Data, URLResponse) {
        var request = URLRequest(url: URL(string: path, relativeTo: base) ?? base)
        request.httpMethod = method
        if let timeout { request.timeoutInterval = timeout }
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
        case .keychain: return "the Keychain did not keep this Mac's token"
        }
    }
}
