// The window draws no title bar of its own: the page's top bar runs to the window's
// top edge, the window buttons sit inside it, and its empty parts move the window. The page makes
// room for the buttons on its [data-titlebar] rows when <html> has .mac-app (apps/captions/src/index.css). Servers and
// the rest of this Mac live in the page's Settings → This Mac (ThisMacBridge.swift).
import AppKit
import WebKit

/// Height of the site's top bar (AppBar's min-h-14): the window buttons are centred in it.
let titleBarHeight: CGFloat = 56

/// Runs in every page: marks it as inside the app and turns a press on an empty part of the top
/// bar into a window drag, a double-click into the Mac's double-click action.
func titleBarScript(fullScreen: Bool) -> String {
    """
    document.documentElement.classList.add("mac-app");
    document.documentElement.classList.toggle("mac-full", \(fullScreen));
    (() => {
      const ui = "a,button,input,select,textarea,label,summary,video,audio,[role=button],[role=link],[role=menuitem],[role=tab],[role=slider],[contenteditable],[draggable=true]";
      const onBar = (e) => e.button === 0 && e.clientY < \(Int(titleBarHeight)) && !e.target.closest?.(ui);
      addEventListener("mousedown", (e) => { if (onBar(e)) window.webkit.messageHandlers.window.postMessage("drag"); });
      addEventListener("dblclick", (e) => { if (onBar(e)) window.webkit.messageHandlers.window.postMessage("zoom"); });
    })();
    """
}

final class AppWebView: WKWebView, WKScriptMessageHandler, WKScriptMessageHandlerWithReply {
    private var lastMouseDown: NSEvent?
    private var observers: [NSObjectProtocol] = []
    private var fullScreen = false
    /// This Mac's device id on the open server, for the page's AI line (html data-mac-device); nil when not paired.
    var macDevice: String? {
        didSet { if macDevice != oldValue { installScripts() } }
    }
    /// The downloaded update waiting to install, for the page's Update button (html data-mac-update, Updates.swift).
    var macUpdate: UpdateWhenIdle.Held? {
        didSet { if macUpdate != oldValue { installScripts() } }
    }
    /// A page that posts `this-mac` (older servers' Settings → This Mac): opens the native panel.
    var onThisMac: (() -> Void)?
    /// The page's Settings → This Mac (`thismac-<what>`): servers, Take work from this server (ThisMacBridge.swift).
    var onThisMacCommand: ((String) -> Void)?
    /// The page's recorder messages (`record-<what>`, src/lib/mac-record.ts): the native recorder (Recorder.swift).
    var onRecord: ((String) -> Void)?
    /// The provider page's Sign in button (ProviderDetail.tsx): the CLI's driver and its home folder ("" = the default).
    var onSignIn: ((String, String) -> Void)?

    init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // the login stays between launches
        // a recording's editor opens playing, with its sound: no press is asked for first
        config.mediaTypesRequiringUserActionForPlayback = []
        // ctlocal://<recording>/<file>: the recordings on this Mac, for the editor on the site's page (ProjectScheme.swift).
        // Marked secure, or the https page may play the video but not fetch it (the editor's export and the pointer log).
        config.setURLSchemeHandler(ProjectScheme(root: { Recorder.folder }), forURLScheme: ProjectScheme.scheme)
        let secure = NSSelectorFromString("_registerURLSchemeAsSecure:")
        if config.processPool.responds(to: secure) { config.processPool.perform(secure, with: ProjectScheme.scheme) }
        super.init(frame: .zero, configuration: config)
        // no white square before the first page paints: the window's own (dark or light) background shows instead
        // private key: checked first, so a macOS without it brings the white square back instead of a launch crash
        if responds(to: NSSelectorFromString("_setDrawsBackground:")) { setValue(false, forKey: "drawsBackground") }
        // Retains self: the window's one web view lives as long as the app.
        configuration.userContentController.add(self, name: "window")
        configuration.userContentController.add(self, name: "appLog")
        configuration.userContentController.add(self, name: "badge")
        configuration.userContentController.add(self, name: "signIn")
        // the kind of place under the pointer, "snap" or "glide" (src/lib/mac-wheel.ts): no glide over a canvas
        configuration.userContentController.add(self, name: "wheel")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "account")
        // This Mac's AI (src/lib/thisMac.ts): "state", "start" and "access", answered with { aiOn, paired, problem };
        // "folder" (the folder picker, src/lib/thisMac.ts chooseFolderOnMac), answered with { path }
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "thisMac")
        // A picture of the page for the assistant (src/lib/page-context.ts snapshot()): replies with a PNG in base64
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "snapshot")
        // Publish to Community with this Mac's account (src/lib/pack-catalog.ts publishFromMac): the pack as JSON text,
        // answered with { state } once this app's own alert is answered (Account.swift publish)
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "publishPack")
        // The folders whose original video and sound files ctlocal://media/ may serve (src/lib/local-files.ts
        // askMediaFolder): { ask: folder } opens this app's open panel, { list: true }, { remove: folder };
        // answered with { granted: [folders] }
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "mediaAccess")
        // Chat mode switched on or off (src/lib/chat-mode.ts washTo): the wave is drawn over the page (ChatWave.swift)
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "chatWave")
        installScripts()
        _ = chatWave   // its shader compiles now, not on the first switch
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// A press on a window in the background does what it presses at once: the top bar moves it, a button, slider or
    /// timeline takes it. The web view's own answer is no for nearly everything, which made the first press after
    /// coming back from another window (the recorder's toolbar, another app) do nothing.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func mouseDown(with event: NSEvent) {
        lastMouseDown = event
        super.mouseDown(with: event)
    }

    /// The Finder items of a drop on this window: a page only gets a dropped item's contents, so the assistant asks for
    /// these ("dropped") to point at a folder where it lies instead of uploading it. Only a real drop hands them over.
    private var drag = DragPaths()
    /// The files of the drops the page asked about ("dropped"): Face Blur takes these (FaceBlurBridge.swift).
    private(set) var droppedFiles: [URL] = []
    /// The files and folders of those drops: a Media Library copy reads only from under these (Import.swift).
    private(set) var droppedPlaces: [URL] = []

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        drag.entered(droppedItems(sender.draggingPasteboard))
        return super.draggingEntered(sender)
    }

    override func draggingExited(_ sender: NSDraggingInfo?) {
        drag.exited()
        super.draggingExited(sender)
    }

    // before super: the page's drop event (and its "dropped" ask) comes from inside super's handling
    override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
        // footage of another server's Blur faces workspace never reaches this page, which would upload it unblurred (every
        // file of the drag, not only the first 50 the page is told about)
        if let refused = blurredElsewhere(sender.draggingPasteboard) {
            drag.exited()
            super.draggingExited(sender)   // the page's drop zone lets go, as when the drag leaves
            refuse(refused)
            return false
        }
        drag.dropped()
        return super.performDragOperation(sender)
    }

    /// Cmd-V of files copied in Finder: the same check as a drop (the window gets the key before the Edit menu does).
    /// shortcut: Edit → Paste chosen with the mouse isn't checked; a paste(_:) of our own once WebKit exposes it.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        // Caps Lock and the like don't count: only ⌘ held, of the keys that change a shortcut
        if event.type == .keyDown, event.modifierFlags.intersection([.command, .shift, .option, .control]) == .command, event.charactersIgnoringModifiers?.lowercased() == "v",
           let refused = blurredElsewhere(NSPasteboard.general) {
            refuse(refused)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    /// The refusal line for a drag or a paste whose files lie in another server's Blur faces Media folder, else nil.
    private func blurredElsewhere(_ board: NSPasteboard) -> String? {
        guard let site else { return nil }
        let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        return urls.isEmpty ? nil : MediaFiles.blurredElsewhere(urls.map(\.path), server: MediaFiles.serverKey(site()))
    }

    /// One line in a sheet over this window: why a drop or a pick didn't reach the page.
    func refuse(_ line: String) {
        let alert = NSAlert()
        alert.messageText = line
        alert.addButton(withTitle: "OK")
        if let window { alert.beginSheetModal(for: window) } else { alert.runModal() }
    }

    // A wheel mouse's steps glide instead of jumping the page (WheelGlide.swift).
    private(set) var glide = WheelGlide()
    private var glideLink: CADisplayLink?
    /// The newest wheel step: its place, window and held keys are reused for the frames of its glide.
    private var glideStep: CGEvent?
    /// The pointer is over a canvas, timeline or viewer that pans and zooms by the wheel itself (the page's "wheel" message).
    var wheelSnaps = false {
        // a step already gliding must not keep moving a canvas the pointer just reached
        didSet { if wheelSnaps { glide.stop() } }
    }

    /// A new page (or a web process that ended) has not said where the pointer is yet, and an older server never does:
    /// the wheel glides until it does (Shell's navigation delegate).
    func wheelPageChanged() {
        wheelSnaps = false
        glide.stop()
    }

    override func scrollWheel(with event: NSEvent) {
        guard WheelGlide.glides(event, snap: wheelSnaps, reduceMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion),
              let step = event.cgEvent?.copy() else {
            glide.stop()
            return super.scrollWheel(with: event)
        }
        glideStep = step
        glide.add(x: event.deltaX * WheelGlide.pointsPerLine, y: event.deltaY * WheelGlide.pointsPerLine)
        if glideLink == nil {
            let link = displayLink(target: self, selector: #selector(glideTick(_:)))
            link.add(to: .main, forMode: .common)
            glideLink = link
        }
        glideLink?.isPaused = false
    }

    @objc private func glideTick(_ link: CADisplayLink) {
        glideFrame(link.targetTimestamp - link.timestamp)
    }

    /// One frame of the glide: the page gets its share of what is left, as a precise scroll.
    func glideFrame(_ dt: Double) {
        let move = glide.frame(dt)
        if glide.resting { glideLink?.isPaused = true }
        guard move.x != 0 || move.y != 0, let event = WheelGlide.event(from: glideStep, x: move.x, y: move.y) else { return }
        super.scrollWheel(with: event)
    }

    /// A page still blank 10 s after loading (pageLogScript); reloaded at most once a minute.
    var onBlank: (() -> Void)?
    /// The account step (AccountStep.tsx): "status", "apple" or "google"; the reply resolves the page's postMessage.
    var onAccount: ((String, @escaping (AccountReply) -> Void) -> Void)?
    /// This Mac's AI for the page (thisMac): one of thisMacAsks; the reply is { aiOn, paired, problem }.
    var onThisMacAsk: ((String, @escaping ([String: Any]) -> Void) -> Void)?
    /// Publish a pack (the "publishPack" message): the pack's JSON text; the reply is { state, message }.
    var onPublishPack: ((String, @escaping (AccountReply) -> Void) -> Void)?
    /// The site the window shows (Shell sets it): only its own pages may ask for a screenshot.
    var site: (() -> URL)?
    /// A mediaAccess open panel is showing: a second ask while it is gets { granted: [] }.
    fileprivate var mediaPanelOpen = false
    private lazy var chatWave = ChatWaveHost(self)

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        if message.name == "snapshot" { return snapshot(message, replyHandler) }
        if message.name == "thisMac" { return thisMac(message, replyHandler) }
        if message.name == "publishPack" { return publishPack(message, replyHandler) }
        if message.name == "mediaAccess" { return mediaAccess(message, replyHandler) }
        if message.name == "chatWave" {
            guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? url, let site, isSite(page, site()) else {
                return replyHandler(false, nil)
            }
            return chatWave.handle(message.body) { replyHandler($0, $1) }
        }
        guard let ask = accountAsk(message.body, mainFrame: message.frameInfo.isMainFrame), let onAccount else { return replyHandler(["state": "off"], nil) }
        onAccount(ask) { replyHandler($0, nil) }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "appLog", let line = message.body as? String {
            AppLog.write(line)
            if line.hasPrefix("blank:") { onBlank?() }
            return
        }
        if message.name == "wheel" {
            wheelSnaps = message.body as? String == "snap"
            return
        }
        // The Workshop's replies waiting for you (WorkshopSidebar): the count on the Dock icon, "" clears it
        if message.name == "badge", let count = message.body as? String {
            NSApp.dockTile.badgeLabel = count.isEmpty ? nil : count
            return
        }
        // The provider page's sign-in button: {driver, home}, from the site's own main frame only
        if message.name == "signIn" {
            if message.frameInfo.isMainFrame, let body = message.body as? [String: String],
               let driver = body["driver"], let home = body["home"] { onSignIn?(driver, home) }
            return
        }
        guard let window else { return }
        switch message.body as? String {
        case "drag":
            if let event = lastMouseDown { window.performDrag(with: event) }
        case "this-mac":
            onThisMac?()
        case "update-install":
            // the page's Restart to update (NewVersionPill.tsx), from the site's own page only
            if message.frameInfo.isMainFrame { UpdateWhenIdle.shared.installNow() }
        case let m? where m.hasPrefix("thismac-"):
            // only the site's own page, never a frame inside it (ThisMacBridge.swift)
            if message.frameInfo.isMainFrame { onThisMacCommand?(String(m.dropFirst(8))) }
        case let m? where m.hasPrefix("record-"):
            // only the site's own page, never a frame inside it
            if message.frameInfo.isMainFrame { onRecord?(String(m.dropFirst(7))) }
        case "zoom":
            // System Settings › Desktop & Dock › "Double-click a window's title bar to"
            switch UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick") {
            case "Minimize": window.performMiniaturize(nil)
            case "None": break
            default: window.performZoom(nil)
            }
        default: break
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers = []
        guard let window else { return }
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.styleMask.insert(.fullSizeContentView)
        // the page's own colours (index.html theme-color), so the first paint doesn't shift from the system grey
        window.backgroundColor = NSColor(name: nil) { look in
            look.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(srgbRed: 0x0b / 255, green: 0x0b / 255, blue: 0x10 / 255, alpha: 1)
                : NSColor(srgbRed: 0xfa / 255, green: 0xfa / 255, blue: 0xfa / 255, alpha: 1)
        }
        placeButtons()
        // AppKit puts the buttons back where it likes after a layout, a resize or full screen.
        DispatchQueue.main.async { [weak self] in
            self?.placeButtons()
            self?.growOnce()
        }
        let watch: [(Notification.Name, (AppWebView) -> Void)] = [
            (NSWindow.didBecomeKeyNotification, { $0.placeButtons() }),
            (NSWindow.didResizeNotification, { $0.placeButtons() }),
            (NSWindow.didEndLiveResizeNotification, { $0.placeButtons() }),
            (NSWindow.willEnterFullScreenNotification, { $0.setFullScreen(true) }),
            (NSWindow.didExitFullScreenNotification, { $0.setFullScreen(false); $0.placeButtons() }),
        ]
        for (name, act) in watch {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { if let self { act(self) } }
            })
        }
    }

    /// Grows a window left at the old 960×640 opening size, once per install (after macOS restored the saved frame).
    private func growOnce() {
        let key = "grewSmallWindow"
        guard let window, let screen = window.screen ?? NSScreen.main, !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        if let frame = grownWindowFrame(current: window.frame, screen: screen.visibleFrame) {
            window.setFrame(frame, display: true, animate: false)
        }
    }

    /// Centres the window buttons in the page's top bar, as far from the left edge as from the top.
    private func placeButtons() {
        guard let window, !window.styleMask.contains(.fullScreen),
              let close = window.standardWindowButton(.closeButton),
              let mini = window.standardWindowButton(.miniaturizeButton),
              let zoom = window.standardWindowButton(.zoomButton),
              let bar = close.superview?.superview else { return }
        let inset = ((titleBarHeight - close.frame.height) / 2).rounded()
        var frame = bar.frame
        frame.size.height = close.frame.height + inset
        frame.origin.y = window.frame.height - frame.size.height
        bar.frame = frame
        let gap = mini.frame.minX - close.frame.minX
        for (i, button) in [close, mini, zoom].enumerated() {
            button.setFrameOrigin(NSPoint(x: inset + CGFloat(i) * gap, y: 0))
        }
    }

    /// Full screen hides the buttons, so the page drops the room it kept for them.
    private func setFullScreen(_ on: Bool) {
        fullScreen = on
        installScripts()
        evaluateJavaScript("document.documentElement.classList.toggle('mac-full', \(on))")
    }

    private func installScripts() {
        let scripts = configuration.userContentController
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: titleBarScript(fullScreen: fullScreen), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        scripts.addUserScript(WKUserScript(source: pageLogScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // the page shows Settings → This Mac only inside this app (ThisMacSection.tsx)
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macThisMac = '1';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // the page shows its Record screen buttons only where this app can record (macOS 15+)
        if Recorder.available {
            scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macRecord = '1';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
            // "record-trash:<id>" throws a recording away without asking: the page asks in its own dialog (mac-record.ts)
            scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macRecordTrash = '1';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // a download named "….ctalpha.mp4" becomes a see-through video (AlphaVideo.swift): the editor offers no
        // background only where this is set (mac-record.ts)
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macRecordAlpha = '1';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // "record-save-as:<file name>" asks where the screen editor's Export goes before it is made (mac-record.ts askSavePlace)
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macSaveAs = '1';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // ctlocal:// takes several requests at once from '2' on (ProjectScheme.swift); in an older app the page reads a
        // recording's files one after another instead. '3': it also serves ctlocal://media/ (an edit's originals from
        // the granted folders, MediaFiles.swift). src/lib/local-files.ts
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macLocalFiles = '3';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // the Media Library's thumbs and sprites from this Mac's cache (ThumbCache.swift, ctlocal://thumb/): src/lib/local-thumbs.ts.
        // '2': Review's thumbs too
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macLocalThumbs = '2';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // a library clip's Show in Finder (the "reveal:" ask, Reveal.swift): src/pages/library/clip.ts canReveal. '2': on a
        // server elsewhere it needs no granted folder (the page asks for none first)
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macReveal = '2';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // a library copy's Show in Finder (the "reveal:" ask with copy and path, Reveal.swift): Settings → Media Library → Copies
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macCopyReveal = '1';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // a Settings → Folders folder's Show in Finder (the "reveal:" ask with folder, Reveal.swift): StorageRows.tsx canRevealFolder
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macFolderReveal = '1';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // the Media Library's copy, progress, cancel, scan and print asks ("import:", Import.swift): src/lib/thisMac.ts
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macImport = '1';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        // here or away: the places:check and places:connect asks and the mac-places event (Places.swift; contracts/places.ts);
        // 2: also Find missing files, places:search (PlacesSearch.swift)
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macPlaces = '2';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let device = macDeviceScript(macDevice)
        scripts.addUserScript(WKUserScript(source: device, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        evaluateJavaScript(device)   // the page already open learns it too (after pairing)
        let update = macUpdateScript(macUpdate)
        scripts.addUserScript(WKUserScript(source: update, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        evaluateJavaScript(update)
    }
}

/// Sets or clears <html data-mac-device>, which the page's Settings → Your AI reads to say "this Mac".
func macDeviceScript(_ id: String?) -> String {
    let value = id.flatMap { String(data: (try? JSONEncoder().encode($0)) ?? Data(), encoding: .utf8) } ?? "null"
    return "(() => { const id = \(value); if (id) document.documentElement.dataset.macDevice = id; else delete document.documentElement.dataset.macDevice; })();"
}

/// A menu item that runs a closure.
final class ActionItem: NSMenuItem {
    private let run: () -> Void

    init(_ title: String, checked: Bool = false, key: String = "", _ run: @escaping () -> Void) {
        self.run = run
        super.init(title: title, action: #selector(fire), keyEquivalent: key)
        target = self
        state = checked ? .on : .off
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("not used") }

    @objc private func fire() { run() }
}

extension AppWebView {
    /// "snapshot": the visible part of the page as a PNG, at most 2000 px on its longest side, in base64; answered
    /// only for the open server's own main frame.
    fileprivate func snapshot(_ message: WKScriptMessage, _ replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? url, let site, isSite(page, site()) else {
            return replyHandler(nil, "not allowed")
        }
        takeSnapshot(with: nil) { image, error in
            guard let image, let png = pngData(of: image) else {
                return replyHandler(nil, error?.localizedDescription ?? "no picture")
            }
            replyHandler(png.base64EncodedString(), nil)
        }
    }

    /// "publishPack": only the open server's own main frame may ask, with text; anything else is "off".
    fileprivate func publishPack(_ message: WKScriptMessage, _ replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? url, let site, isSite(page, site()),
              let text = message.body as? String, let onPublishPack else {
            return replyHandler(["state": "off"], nil)
        }
        onPublishPack(text) { replyHandler($0, nil) }
    }

    /// "mediaAccess": only the open server's own main frame may ask. The page's folder is only where the panel starts:
    /// what is kept is the folder chosen in the panel, which may be a higher one. Cancelled, or a panel already open:
    /// { granted: [] }. No ask ({list: true}): this server's grants. {folderGrant: {path}} → {granted} (Settings →
    /// Folders' Allow on this Mac); {placesState: {paths}} → {states, disks} (MediaFiles.placeState); {look: true} → the
    /// location agents pass again (a folder added in Settings → Folders).
    fileprivate func mediaAccess(_ message: WKScriptMessage, _ replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? url, let site, isSite(page, site()),
              let body = message.body as? [String: Any] else {
            return replyHandler(["granted": [String]()], nil)
        }
        if let folder = body["remove"] as? String { MediaFiles.remove(folder) }
        let server = MediaFiles.serverKey(site())
        // Settings → Folders' "Allow on this Mac" (a press on the page): a folder this server lists for this Mac
        if let ask = body["folderGrant"] as? [String: Any], let path = ask["path"] as? String {
            let granted = MediaFiles.allow(path, server: server)
            if granted { LocationAgents.shared.poke() }
            return replyHandler(["granted": granted], nil)
        }
        // a Settings → Folders folder just added on this page: the location agent reads the list again now, not at the next wake
        if body["look"] as? Bool == true {
            LocationAgents.shared.poke()
            return replyHandler(["ok": true], nil)
        }
        if let ask = body["placesState"] as? [String: Any], let paths = ask["paths"] as? [String] {
            let list = Array(paths.prefix(500))
            DispatchQueue.global(qos: .userInitiated).async {
                var states: [String: String] = [:], disks: [String: String] = [:]
                for p in list {
                    let (state, disk) = MediaFiles.placeState(p, server: server)
                    states[p] = state
                    if let disk { disks[p] = disk }
                }
                DispatchQueue.main.async { replyHandler(["states": states, "disks": disks], nil) }
            }
            return
        }
        guard let ask = body["ask"] as? String else { return replyHandler(["granted": MediaFiles.granted(server: server, workspace: nil)], nil) }
        guard !mediaPanelOpen, let window else { return replyHandler(["granted": [String]()], nil) }
        mediaPanelOpen = true
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: MediaFiles.nearestExisting(ask.hasPrefix("/") ? ask : "/"), isDirectory: true)
        // one panel for every ask (Show in Finder, a clip or an edit playing its original), so it says what Allow does
        panel.title = "Original files"
        panel.message = "Choose the folder with your original videos. Asked once for each folder: after Allow, the videos in it play here and Show in Finder opens them. Creator Toolset only reads video and sound files in the folder you choose."
        panel.prompt = "Allow"
        panel.beginSheetModal(for: window) { [weak self] answer in
            self?.mediaPanelOpen = false
            guard answer == .OK, let chosen = panel.url else { return replyHandler(["granted": [String]()], nil) }
            MediaFiles.add(chosen.path)
            replyHandler(["granted": MediaFiles.granted(server: server, workspace: nil)], nil)
        }
    }

    /// "thisMac": only the open server's own main frame may ask; anything else gets the same answer as "off".
    fileprivate func thisMac(_ message: WKScriptMessage, _ replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? url, let site, isSite(page, site()),
              let ask = message.body as? String, thisMacAsks.contains(ask) || installAsk(ask) != nil || aiInstallAsk(ask) != nil || isPluginAsk(ask) || isFaceBlurAsk(ask) || isRevealAsk(ask) || isImportAsk(ask) || isPlacesAsk(ask) || isEditorAsk(ask),
              let onThisMacAsk else {
            return replyHandler(["aiOn": false, "paired": false], nil)
        }
        if ask == "dropped" {
            let items = drag.take()
            droppedFiles = rememberPicks(items.compactMap { $0["folder"] as? Bool == false ? ($0["path"] as? String).map(URL.init(fileURLWithPath:)) : nil }, in: droppedFiles)
            droppedPlaces = rememberPicks(items.compactMap { ($0["path"] as? String).map(URL.init(fileURLWithPath:)) }, in: droppedPlaces)
            MediaFiles.grantDropped(items)
            return replyHandler(["items": items], nil)
        }
        onThisMacAsk(ask) { replyHandler($0, nil) }
    }
}

/// A drag's Finder items as the page may see them: nothing while a drag only passes over or after it left, the items of
/// a drop once (the first "dropped" ask takes them), and nothing once that drop is 10 seconds old.
struct DragPaths {
    private var over: [[String: Any]] = []
    private var drop: (items: [[String: Any]], at: Date)?

    mutating func entered(_ items: [[String: Any]]) { over = items }
    mutating func exited() { over = [] }
    mutating func dropped(at now: Date = Date()) {
        drop = (over, now)
        over = []
    }
    mutating func take(at now: Date = Date()) -> [[String: Any]] {
        defer { drop = nil }
        guard let drop, now.timeIntervalSince(drop.at) < 10 else { return [] }
        return drop.items
    }
}

/// A drag's Finder files and folders: { path, folder } each (anything else on the pasteboard is left out).
func droppedItems(_ board: NSPasteboard) -> [[String: Any]] {
    let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
    return urls.prefix(50).map { url in
        let folder = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true
        return ["path": url.path, "folder": folder]
    }
}

/// The image at its real pixel size, scaled down to fit 2000 px, as PNG.
private func pngData(of image: NSImage) -> Data? {
    guard let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { return nil }
    let size = fittedSize(width: cg.width, height: cg.height)
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size.width, pixelsHigh: size.height,
                                     bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                     colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let context = NSGraphicsContext(bitmapImageRep: rep) else { return nil }
    context.imageInterpolation = .high
    context.cgContext.draw(cg, in: CGRect(x: 0, y: 0, width: size.width, height: size.height))
    return rep.representation(using: .png, properties: [:])
}
