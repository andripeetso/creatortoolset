// Spike: draws one design-system motion kit (a level 1 pack's drawing code) for one card, on this Mac. The kit runs in a
// WKWebView with no network (the page's Content-Security-Policy is default-src 'none'), no storage that outlives the
// render, and no way to leave its own page (no links, redirects, forms or new windows). The kit is a script that
// defines `kitFrame(t, card)`; it paints into `#stage`, a box the size of the card, for time t in seconds. Each frame
// comes back as a PNG of exactly width × height pixels. The server never runs a kit: the editor's card step asks the
// device that claims it, and that device calls this.
import AppKit
import WebKit

/// One card to draw: the kit's script, the size in points, the length, the frame rate and the card's content.
struct KitCard {
    let kit: String
    let width: Int
    let height: Int
    let seconds: Double
    let fps: Int
    let content: [String: String]

    /// seconds × fps frames, at t = 0, 1/fps, 2/fps, …
    var frameCount: Int { max(1, Int((seconds * Double(fps)).rounded())) }
}

enum KitRunnerError: Error, Equatable {
    case badCard(String)
    case loadFailed(String)
    case snapshotFailed
}

enum KitRunner {
    /// The page the kit runs in. The kit is inline script; nothing else may load (no fetch, images from the network,
    /// frames, workers or fonts).
    static func html(for card: KitCard) throws -> String {
        guard card.width > 0, card.height > 0, card.seconds > 0, card.fps > 0 else {
            throw KitRunnerError.badCard("size, length and frame rate must be above zero")
        }
        let content = String(decoding: try JSONSerialization.data(withJSONObject: card.content, options: [.sortedKeys]), as: UTF8.self)
        // Escaping keeps the page well-formed; the CSP is what holds the kit.
        let kit = card.kit.replacingOccurrences(of: "</script", with: "<\\/script", options: .caseInsensitive)
        return """
        <!doctype html>
        <html><head><meta charset="utf-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">
        <style>html,body{margin:0;padding:0;overflow:hidden;background:transparent}#stage{position:relative;width:\(card.width)px;height:\(card.height)px;overflow:hidden}</style>
        </head><body><div id="stage"></div>
        <script>const card = \(content);</script>
        <script>
        \(kit)
        </script>
        </body></html>
        """
    }

    /// Draws every frame of the card in order and returns each one as PNG data, exactly width × height pixels.
    @MainActor
    static func frames(_ card: KitCard) async throws -> [Data] {
        // ponytail: no timeout, so a kit that never returns hangs its render; add a watchdog when the card step calls this.
        let page = KitWebView(width: card.width, height: card.height)
        try await page.load(try html(for: card))
        var out: [Data] = []
        for i in 0..<card.frameCount {
            let t = Double(i) / Double(card.fps)
            let status = try await page.webView.evaluateJavaScript(
                "(function () { try { kitFrame(\(t), card); return 'ok'; } catch (e) { return 'error: ' + e; } })()"
            ) as? String
            guard status == "ok" else { throw KitRunnerError.badCard(status ?? "the kit returned nothing") }
            out.append(try png(of: try await page.snapshot(), width: card.width, height: card.height))
        }
        return out
    }

    /// Re-draws the snapshot into a bitmap of exactly width × height pixels, whatever the screen's scale is.
    private static func png(of image: NSImage, width: Int, height: Int) throws -> Data {
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8, samplesPerPixel: 4,
            hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ), let context = NSGraphicsContext(bitmapImageRep: rep) else { throw KitRunnerError.snapshotFailed }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        image.draw(in: NSRect(x: 0, y: 0, width: width, height: height))
        NSGraphicsContext.restoreGraphicsState()
        guard let data = rep.representation(using: .png, properties: [:]) else { throw KitRunnerError.snapshotFailed }
        return data
    }
}

/// A web view for one kit: a non-persistent data store, and navigation only to the page it was given.
@MainActor
private final class KitWebView: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    private var loading: CheckedContinuation<Void, Error>?

    init(width: Int, height: Int) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
        super.init()
        webView.navigationDelegate = self
    }

    func load(_ html: String) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            loading = continuation
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    func snapshot() async throws -> NSImage {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<NSImage, Error>) in
            webView.takeSnapshot(with: nil) { image, error in
                if let image { continuation.resume(returning: image) } else { continuation.resume(throwing: error ?? KitRunnerError.snapshotFailed) }
            }
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(action.request.url?.absoluteString == "about:blank" ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loading?.resume()
        loading = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(error)
    }

    private func fail(_ error: Error) {
        loading?.resume(throwing: KitRunnerError.loadFailed(error.localizedDescription))
        loading = nil
    }
}
