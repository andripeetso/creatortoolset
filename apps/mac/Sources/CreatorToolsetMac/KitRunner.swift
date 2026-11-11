// Draws one card of an edit on this Mac. The drawing code is a script someone's AI wrote, so it is never trusted. The
// script defines `kitFrame(t, card)`; it paints into `#stage`, a box the size of the card on a black page (white text
// until it says otherwise), for time t in seconds. The server never runs such a script: the editor's card step asks the Mac that claims it (CardJobs.swift),
// and that Mac calls this. What shuts the script in, each measured against a listener on this Mac
// (KitSandboxTests.swift):
//   - the page's Content-Security-Policy is default-src 'none': no fetch, socket, image, font, frame or worker from anywhere;
//   - the script's page is a sandboxed frame (scripts only) of a page with that policy, so the engine itself refuses
//     its navigations, forms and new windows before the app is even asked, and it can't touch the page above it;
//   - the web view refuses every navigation but that page and that frame, has none of the app's pages, handlers or
//     cookies, and keeps nothing (a data store of its own that is gone with the card);
//   - Lockdown Mode for the page: no WebRTC (which the policy does not govern), WebAssembly, WebGL or Web Audio;
//   - WebKit's link preconnect is switched off (a link click with target=_blank, or <link rel=preconnect>, otherwise
//     opens a connection whatever the policy says). WebKit has no public switch for it, so this is a private call,
//     and a Mac where it is missing draws no card;
//   - whatever else heads for a name or address outside this Mac is sent to a proxy address where nothing listens;
//   - one time limit for the whole card, and the page's process is ended with the card (a loop that never returns
//     otherwise keeps a processor busy until the app quits, and WebKit's own kill does not stop it).
import AppKit
import Network
import WebKit

/// One card to draw: the script, the size in points, the length, the frame rate and the card's content (JSON values,
/// handed to the script as `card`).
struct KitCard: @unchecked Sendable {
    let kit: String
    let width: Int
    let height: Int
    let seconds: Double
    let fps: Double
    let content: [String: Any]

    /// seconds × fps frames, at t = 0, 1/fps, 2/fps, …
    var frameCount: Int { max(1, Int((seconds * fps).rounded())) }
}

enum KitRunnerError: Error, Equatable {
    /// The card can't be drawn as asked, or its script threw: the words say which.
    case badCard(String)
    case loadFailed(String)
    case snapshotFailed
    /// The card's time ran out (a script that loops, or one too slow for this Mac).
    case timedOut
    /// The page's own process ended while it drew (it crashed, or macOS stopped it for the memory it took).
    case ended
    /// The first, middle and last frame are all the empty stage.
    case blank
    /// This Mac's WebKit lacks something the script is shut in with, so nothing is drawn: the words say what.
    case unsafe(String)
}

/// What shuts a card's script in besides its page's own policy and frame. Every card is drawn behind all of them; a
/// test takes them away to show that what a script tries does get out without them.
struct KitWalls: OptionSet {
    let rawValue: Int
    /// the web view refuses every navigation but the page it was given and the one frame in it
    static let stay = KitWalls(rawValue: 1)
    /// Lockdown Mode for the page
    static let lockdown = KitWalls(rawValue: 2)
    /// WebKit's link preconnect switched off
    static let noPreconnect = KitWalls(rawValue: 4)
    /// a proxy address where nothing listens, for everything bound for a name or address outside this Mac
    static let deadProxy = KitWalls(rawValue: 8)
    static let all: KitWalls = [.stay, .lockdown, .noPreconnect, .deadProxy]
}

enum KitRunner {
    /// The most time one card may take, from loading its page to its last frame.
    static let cardLimit: TimeInterval = 20
    /// Nothing loads but the page's own inline script and style, and `data:` images.
    static let policy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:"
    /// The dead proxy's port on this Mac: 1, which only the system could listen on and nothing does.
    static let deadPort: UInt16 = 1

    /// The kit's own page: the stage, the card's content and the kit as inline script.
    static func html(for card: KitCard) throws -> String {
        guard card.width > 0, card.height > 0, card.seconds > 0, card.fps > 0 else {
            throw KitRunnerError.badCard("size, length and frame rate must be above zero")
        }
        guard JSONSerialization.isValidJSONObject(card.content) else { throw KitRunnerError.badCard("the card's content is not JSON") }
        // JSONSerialization writes "/" as "\/", so the content can't close its script element
        let content = String(decoding: try JSONSerialization.data(withJSONObject: card.content, options: [.sortedKeys]), as: UTF8.self)
        // Escaping keeps the page well-formed; the policy and the frame are what hold the kit.
        let kit = card.kit.replacingOccurrences(of: "</script", with: "<\\/script", options: .caseInsensitive)
        return """
        <!doctype html>
        <html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(policy)">
        <style>html,body{margin:0;padding:0;overflow:hidden;background:#000;color:#fff}#stage{position:relative;width:\(card.width)px;height:\(card.height)px;overflow:hidden}</style>
        </head><body><div id="stage"></div>
        <script>const card = \(content);</script>
        <script>
        \(kit)
        </script>
        </body></html>
        """
    }

    /// What the web view loads: nothing but the kit's page in a sandboxed frame. A frame's own navigations are checked
    /// against the policy of the page around it, inside the engine; the top page's are not.
    static func page(for card: KitCard) throws -> String {
        let kit = try html(for: card).replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
        return """
        <!doctype html>
        <html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="\(policy)">
        <style>html,body{margin:0;padding:0;overflow:hidden;background:#000}iframe{display:block;border:0;width:\(card.width)px;height:\(card.height)px}</style>
        </head><body><iframe sandbox="allow-scripts" srcdoc="\(kit)"></iframe></body></html>
        """
    }

    /// Draws every frame of the card in order and hands each to `frame` with its number. `limit` is for the whole
    /// card: loading the page (the script's own top level runs then), every call into the script and every picture.
    /// Past it the card fails with `timedOut`.
    @MainActor
    static func draw(_ card: KitCard, limit: TimeInterval = cardLimit, frame: @MainActor (Int, CGImage) async throws -> Void) async throws {
        try await draw(card, on: try KitWebView(width: card.width, height: card.height), limit: limit, frame: frame)
    }

    /// The same on a web view the caller made (the tests look at its process afterwards).
    @MainActor
    static func draw(_ card: KitCard, on page: KitWebView, limit: TimeInterval, frame: @MainActor (Int, CGImage) async throws -> Void) async throws {
        let late = DispatchWorkItem { MainActor.assumeIsolated { page.stop(.timedOut) } }
        DispatchQueue.main.asyncAfter(deadline: .now() + limit, execute: late)
        defer {
            late.cancel()
            page.end()
        }
        try await page.load(try self.page(for: card))
        for i in 0..<card.frameCount {
            try await page.paint(at: Double(i) / card.fps)
            try await frame(i, try await page.picture())
        }
    }
}

/// A web view for one kit.
@MainActor
final class KitWebView: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    private let walls: KitWalls
    /// the page's own first navigation was let through
    private var began = false
    /// the frame the kit runs in, once the page has made it
    private var frame: WKFrameInfo?
    /// ends the step now waiting (a load, a call into the script, a picture) with an error
    private var fail: ((Error) -> Void)?
    private var loaded: (() -> Void)?
    /// set once the card's time is up or its page is gone: no further step starts
    private var over: KitRunnerError?

    private static let processIdentifier = Selector(("_webProcessIdentifier"))

    /// `walls` and `proxyPort` are for the tests: every card is drawn with the defaults.
    init(width: Int, height: Int, walls: KitWalls = .all, proxyPort: UInt16 = KitRunner.deadPort) throws {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        if walls.contains(.lockdown) { config.defaultWebpagePreferences.isLockdownModeEnabled = true }
        if walls.contains(.noPreconnect) { try Self.switchOff(["LinkPreconnect"], and: ["LinkDNSPrefetchEnabled"], in: config.preferences) }
        if walls.contains(.deadProxy), let port = NWEndpoint.Port(rawValue: proxyPort) {
            config.websiteDataStore.proxyConfigurations = [ProxyConfiguration(socksv5Proxy: .hostPort(host: "127.0.0.1", port: port))]
        }
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
        self.walls = walls
        super.init()
        guard webView.responds(to: Self.processIdentifier) else { throw KitRunnerError.unsafe("this macOS gives no way to end a card's page") }
        webView.navigationDelegate = self
    }

    /// Switches entries of WebKit's own feature list off for this page's preferences (they are this page's alone).
    /// Private WebKit calls: WebKit has no public switch for link preconnect. `needed` must end up off, or this
    /// throws and no card is drawn; `wanted` are switched off where this macOS has them.
    private static func switchOff(_ needed: Set<String>, and wanted: Set<String>, in preferences: WKPreferences) throws {
        let list = Selector(("_features")), set = Selector(("_setEnabled:forFeature:")), get = Selector(("_isEnabledForFeature:"))
        let key = Selector(("key"))
        guard WKPreferences.responds(to: list), preferences.responds(to: set), preferences.responds(to: get),
              let features = WKPreferences.perform(list)?.takeUnretainedValue() as? [NSObject] else {
            throw KitRunnerError.unsafe("this macOS has no switch for link preconnect")
        }
        typealias Setter = @convention(c) (AnyObject, Selector, Bool, AnyObject) -> Void
        typealias Getter = @convention(c) (AnyObject, Selector, AnyObject) -> Bool
        let setter = unsafeBitCast(preferences.method(for: set), to: Setter.self)
        let getter = unsafeBitCast(preferences.method(for: get), to: Getter.self)
        var off: Set<String> = []
        for feature in features where feature.responds(to: key) {
            guard let name = feature.value(forKey: "key") as? String, needed.contains(name) || wanted.contains(name) else { continue }
            setter(preferences, set, false, feature)
            if !getter(preferences, get, feature) { off.insert(name) }
        }
        guard off.isSuperset(of: needed) else { throw KitRunnerError.unsafe("this macOS has no switch for link preconnect") }
    }

    /// The page's own process, 0 when it has none (a private WebKit call: nothing public names it).
    var processID: pid_t {
        (webView.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value ?? 0
    }

    /// Whether `pid` is a WebKit page process, by the program it runs.
    static func isPageProcess(_ pid: pid_t) -> Bool {
        var path = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
        return pid > 0 && proc_pidpath(pid, &path, UInt32(path.count)) > 0 && String(cString: path).contains("com.apple.WebKit.WebContent")
    }

    /// Ends the page's process. Each card's page has a process and a data store of its own, so nothing else lives in it.
    func end() {
        let pid = processID
        if Self.isPageProcess(pid) { kill(pid, SIGKILL) }
    }

    /// Ends the card: the step now waiting fails with `why`, and so does every later one.
    func stop(_ why: KitRunnerError) {
        if over == nil { over = why }
        fail?(why)
    }

    /// One step of the page. Its own answer or `stop`, whichever is first, is the result; the other is ignored.
    private func step<T>(_ start: (@escaping (Result<T, Error>) -> Void) -> Void) async throws -> T {
        if let over { throw over }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
            var open = true
            let finish = { [weak self] (result: Result<T, Error>) in
                guard open else { return }
                open = false
                self?.fail = nil
                continuation.resume(with: result)
            }
            fail = { finish(.failure($0)) }
            start(finish)
        }
    }

    func load(_ html: String) async throws {
        try await step { (finish: @escaping (Result<Void, Error>) -> Void) in
            loaded = { finish(.success(())) }
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    /// Runs script where the kit is and returns what it answers, as text. Behind the walls that is only ever the frame.
    func run(_ script: String) async throws -> String {
        if walls.contains(.stay), frame == nil { throw KitRunnerError.loadFailed("the page made no frame for the script") }
        return try await step { finish in
            webView.evaluateJavaScript(script, in: frame, in: .page) { result in
                finish(result.map { $0 as? String ?? "" })
            }
        }
    }

    /// Calls the kit for time `t`. A kit that throws, or that defines no kitFrame, is a bad card with the script's own words.
    func paint(at t: Double) async throws {
        let said: String
        do {
            said = try await run("(function () { try { kitFrame(\(t), card); return 'ok'; } catch (e) { return 'error: ' + e; } })()")
        } catch let error as KitRunnerError {
            throw error
        } catch {
            throw KitRunnerError.badCard(error.localizedDescription)
        }
        guard said == "ok" else { throw KitRunnerError.badCard(said.hasPrefix("error: ") ? String(said.dropFirst(7)) : "the script answered nothing") }
    }

    func picture() async throws -> CGImage {
        let image: NSImage = try await step { finish in
            webView.takeSnapshot(with: nil) { image, error in
                if let image { finish(.success(image)) } else { finish(.failure(error ?? KitRunnerError.snapshotFailed)) }
            }
        }
        guard let picture = image.cgImage(forProposedRect: nil, context: nil, hints: nil) else { throw KitRunnerError.snapshotFailed }
        return picture
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard walls.contains(.stay) else { return decisionHandler(.allow) }
        let url = action.request.url?.absoluteString
        if !began, url == "about:blank", action.targetFrame?.isMainFrame == true {
            began = true
            return decisionHandler(.allow)
        }
        if frame == nil, url == "about:srcdoc", let target = action.targetFrame, !target.isMainFrame {
            frame = target
            return decisionHandler(.allow)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded?()
        loaded = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail?(KitRunnerError.loadFailed(error.localizedDescription))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail?(KitRunnerError.loadFailed(error.localizedDescription))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        stop(.ended)
    }
}
