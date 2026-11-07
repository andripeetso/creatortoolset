// The window draws no title bar of its own: the page's top bar runs to the window's
// top edge, the window buttons sit inside it, and its empty parts move the window. The page makes
// room for the buttons on its [data-titlebar] rows when <html> has .mac-app (apps/captions/src/index.css). Right of the
// window buttons sits the server picker: the servers, Add server, Run your own server, This Mac.
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

final class AppWebView: WKWebView, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, NSMenuDelegate {
    private var lastMouseDown: NSEvent?
    private var observers: [NSObjectProtocol] = []
    private var fullScreen = false
    /// The server picker right of the window buttons; its menu is built each time it opens.
    let picker = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 34, height: 22), pullsDown: true)
    var pickerMenu: (() -> [NSMenuItem])?
    /// This Mac's device id on the open server, for the page's AI line (html data-mac-device); nil when not paired.
    var macDevice: String? {
        didSet { if macDevice != oldValue { installScripts() } }
    }
    /// The page's Settings → This Mac (only shown inside the app): opens the native panel.
    var onThisMac: (() -> Void)?

    init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // the login stays between launches
        super.init(frame: .zero, configuration: config)
        // Retains self: the window's one web view lives as long as the app.
        configuration.userContentController.add(self, name: "window")
        configuration.userContentController.add(self, name: "appLog")
        configuration.userContentController.add(self, name: "badge")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "account")
        installScripts()
        picker.isBordered = false
        picker.toolTip = "Servers"
        picker.setAccessibilityLabel("Servers")
        picker.menu?.delegate = self
        picker.addItem(withTitle: "")
        picker.item(at: 0)?.image = NSImage(systemSymbolName: "server.rack", accessibilityDescription: "Servers")
        addSubview(picker)
    }

    /// The picker's menu, fresh each time: item 0 is the button's own face.
    func menuNeedsUpdate(_ menu: NSMenu) {
        let face = menu.item(at: 0)
        menu.removeAllItems()
        if let face { menu.addItem(face) }
        for item in pickerMenu?() ?? [] { menu.addItem(item) }
    }

    override func layout() {
        super.layout()
        placePicker()
    }

    /// Right of the window buttons, centred in the top bar; hidden in full screen (no buttons, no room kept).
    private func placePicker() {
        picker.isHidden = fullScreen
        let x = window?.standardWindowButton(.zoomButton).map { $0.convert($0.bounds, to: nil).maxX + 6 } ?? 80
        let top = ((titleBarHeight - picker.frame.height) / 2).rounded()
        picker.setFrameOrigin(NSPoint(x: x, y: isFlipped ? top : bounds.height - top - picker.frame.height))
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

    /// A page still blank 10 s after loading (pageLogScript); reloaded at most once a minute.
    var onBlank: (() -> Void)?
    /// The account step (AccountStep.tsx): "status", "apple" or "google"; the reply resolves the page's postMessage.
    var onAccount: ((String, @escaping (AccountReply) -> Void) -> Void)?

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void) {
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
        guard let window else { return }
        switch message.body as? String {
        case "drag":
            if let event = lastMouseDown { window.performDrag(with: event) }
        case "this-mac":
            onThisMac?()
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
        DispatchQueue.main.async { [weak self] in self?.placeButtons() }
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
        placePicker()
    }

    /// Full screen hides the buttons, so the page drops the room it kept for them.
    private func setFullScreen(_ on: Bool) {
        fullScreen = on
        installScripts()
        placePicker()
        evaluateJavaScript("document.documentElement.classList.toggle('mac-full', \(on))")
    }

    private func installScripts() {
        let scripts = configuration.userContentController
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: titleBarScript(fullScreen: fullScreen), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        scripts.addUserScript(WKUserScript(source: pageLogScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let device = macDeviceScript(macDevice)
        scripts.addUserScript(WKUserScript(source: device, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        evaluateJavaScript(device)   // the page already open learns it too (after pairing)
    }
}

/// Sets or clears <html data-mac-device>, which the page's Settings → AI providers reads to say "this Mac".
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
