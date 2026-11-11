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
    /// A page that posts `this-mac` (older servers' Settings → This Mac): opens the native panel.
    var onThisMac: (() -> Void)?
    /// The page's Settings → This Mac (`thismac-<what>`): servers, the AI on this Mac (ThisMacBridge.swift).
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
        // Retains self: the window's one web view lives as long as the app.
        configuration.userContentController.add(self, name: "window")
        configuration.userContentController.add(self, name: "appLog")
        configuration.userContentController.add(self, name: "badge")
        configuration.userContentController.add(self, name: "signIn")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "account")
        // This Mac's AI (src/lib/thisMac.ts): "state", "start" and "access", answered with { aiOn, paired, problem };
        // "folder" (the folder picker, src/lib/thisMac.ts chooseFolderOnMac), answered with { path }
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "thisMac")
        // A picture of the page for the assistant (src/lib/page-context.ts snapshot()): replies with a PNG in base64
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "snapshot")
        installScripts()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// A press on the top bar of a window in the background moves it at once, like a title bar.
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool {
        guard let event else { return super.acceptsFirstMouse(for: event) }
        return convert(event.locationInWindow, from: nil).y < titleBarHeight || super.acceptsFirstMouse(for: event)
    }

    override func mouseDown(with event: NSEvent) {
        lastMouseDown = event
        super.mouseDown(with: event)
    }

    /// The Finder items of the drag over this window, kept from when it came in: a page only gets a dropped item's
    /// contents, so the assistant asks for these ("dropped") to point at a folder where it lies instead of uploading it.
    private(set) var dragItems: [[String: Any]] = []

    override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation {
        dragItems = droppedItems(sender.draggingPasteboard)
        return super.draggingEntered(sender)
    }

    // A wheel mouse's steps glide instead of jumping the page (WheelGlide.swift).
    private var glide = WheelGlide()
    private var glideLink: CADisplayLink?
    /// The newest wheel step: its place, window and held keys are reused for the frames of its glide.
    private var glideStep: CGEvent?

    override func scrollWheel(with event: NSEvent) {
        // precise: a trackpad, a Magic Mouse, or a mouse whose driver smooths already
        guard !event.hasPreciseScrollingDeltas, event.phase.isEmpty, event.momentumPhase.isEmpty,
              !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, let step = event.cgEvent?.copy() else {
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
    /// The site the window shows (Shell sets it): only its own pages may ask for a screenshot.
    var site: (() -> URL)?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        if message.name == "snapshot" { return snapshot(message, replyHandler) }
        if message.name == "thisMac" { return thisMac(message, replyHandler) }
        guard let ask = accountAsk(message.body, mainFrame: message.frameInfo.isMainFrame), let onAccount else { return replyHandler(["state": "off"], nil) }
        onAccount(ask) { replyHandler($0, nil) }
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "appLog", let line = message.body as? String {
            AppLog.write(line)
            if line.hasPrefix("blank:") { onBlank?() }
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
        // ctlocal:// takes several requests at once from this version on (ProjectScheme.swift); in an older app the
        // page reads a recording's files one after another instead (src/lib/local-files.ts)
        scripts.addUserScript(WKUserScript(source: "document.documentElement.dataset.macLocalFiles = '2';", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let device = macDeviceScript(macDevice)
        scripts.addUserScript(WKUserScript(source: device, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        evaluateJavaScript(device)   // the page already open learns it too (after pairing)
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

    /// "thisMac": only the open server's own main frame may ask; anything else gets the same answer as "off".
    fileprivate func thisMac(_ message: WKScriptMessage, _ replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let page = message.frameInfo.request.url ?? url, let site, isSite(page, site()),
              let ask = message.body as? String, thisMacAsks.contains(ask) || installAsk(ask) != nil || isPluginAsk(ask), let onThisMacAsk else {
            return replyHandler(["aiOn": false, "paired": false], nil)
        }
        if ask == "dropped" { return replyHandler(["items": dragItems], nil) }
        onThisMacAsk(ask) { replyHandler($0, nil) }
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
