// The window draws no title bar of its own: the page's top bar runs to the window's
// top edge, the window buttons sit inside it, and its empty parts move the window. The page makes
// room for the buttons on its [data-titlebar] rows when <html> has .mac-app (apps/captions/src/index.css).
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

    init() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()   // the login stays between launches
        super.init(frame: .zero, configuration: config)
        // Retains self: the window's one web view lives as long as the app.
        configuration.userContentController.add(self, name: "window")
        configuration.userContentController.add(self, name: "appLog")
        configuration.userContentController.add(self, name: "badge")
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "account")
        setFullScreen(false)
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
    }

    /// Full screen hides the buttons, so the page drops the room it kept for them.
    private func setFullScreen(_ on: Bool) {
        let scripts = configuration.userContentController
        scripts.removeAllUserScripts()
        scripts.addUserScript(WKUserScript(source: titleBarScript(fullScreen: on), injectionTime: .atDocumentStart, forMainFrameOnly: true))
        scripts.addUserScript(WKUserScript(source: pageLogScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        evaluateJavaScript("document.documentElement.classList.toggle('mac-full', \(on))")
    }
}
