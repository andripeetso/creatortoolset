// The app's own log: launches, page loads that fail,
// a page whose web process died, the page's script errors, a page left blank. ~/Library/Logs/Creator Toolset.log,
// "Open app log" in the menu bar; a crash of the app itself is macOS's report in ~/Library/Logs/DiagnosticReports.
import Foundation

enum AppLog {
    /// Under XCTest a file of its own in the temporary folder, so tests never write to the person's log.
    static let path = underTests ? NSTemporaryDirectory() + "creator-toolset-tests.log"
        : NSHomeDirectory() + "/Library/Logs/Creator Toolset\(AppIdentity.tag()).log"

    /// Running inside `swift test`: nothing registers keys, taps or watchers, and nothing loads a model by itself.
    static let underTests = NSClassFromString("XCTestCase") != nil

    static func write(_ line: String) {
        append(Data("\(ISO8601DateFormatter().string(from: Date())) \(line)\n".utf8), to: path)
    }

    /// Adds bytes to the end of a log file, making it the first time (the server log too).
    static func append(_ data: Data, to path: String) {
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            FileManager.default.createFile(atPath: path, contents: data)
        }
    }

    /// Keeps the last 1 MB once the log passes 2 MB (called at launch).
    static func trim() {
        guard let data = FileManager.default.contents(atPath: path), data.count > 2_000_000 else { return }
        try? data.suffix(1_000_000).write(to: URL(fileURLWithPath: path))
    }
}

/// The page's errors reach the log, and a page still empty 10 s after it loaded says so ("blank").
let pageLogScript = """
(() => {
  const post = (m) => { try { window.webkit.messageHandlers.appLog.postMessage(String(m).slice(0, 2000)); } catch {} };
  addEventListener("error", (e) => post(`page error: ${e.message} at ${e.filename}:${e.lineno}:${e.colno}`));
  addEventListener("unhandledrejection", (e) => post(`page promise: ${e.reason && (e.reason.stack || e.reason.message) || e.reason}`));
  addEventListener("load", () => setTimeout(() => {
    const root = document.getElementById("root");
    if (root && !root.childElementCount) post(`blank: ${location.href}`);
  }, 10000));
})();
"""

private let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;").replacingOccurrences(of: "\"", with: "&quot;") }
private let pageHead = """
    <!doctype html><meta charset="utf-8"><style>
    html{background:#0b0b10;color:#d4d4d8;font:14px -apple-system,sans-serif;height:100%;display:grid;place-items:center}
    a{color:#a78bfa} p{margin:6px 0;text-align:center} small{color:#71717a}
    </style>
    """

/// A one-line page for the window after the server on this Mac stopped.
func messagePage(_ text: String) -> String {
    pageHead + "<div><p>\(esc(text))</p></div>"
}

/// The CT mark's three strokes (the same mark as the app icon, HomeLink.tsx's ToolsetLogo), class `k` on each.
private func ctStrokes(_ k: String) -> String {
    """
    <path class="\(k) c" pathLength="1" d="M412 285A235 235 0 1 0 582 682" stroke-width="130"/>
    <path class="\(k) b" pathLength="1" d="M410 285H910" stroke-width="130"/>
    <path class="\(k) t" pathLength="1" d="M726 350V820" stroke-width="128"/>
    """
}

/// The window while it waits (the server on this Mac starting, data moving): the CT mark draws itself, C then T, and
/// a soft light runs through it until the site opens. A line under it only when the person asked for the wait.
func splashPage(_ line: String? = nil) -> String {
    pageHead + """
    <style>
    .mark{width:120px;height:120px;display:block;margin:0 auto;overflow:visible}
    .s{fill:none;stroke-dasharray:1 1;stroke-dashoffset:1;animation:draw .5s cubic-bezier(.3,0,.2,1) forwards}
    .c{animation-duration:.65s} .b{animation-delay:.5s} .t{animation-delay:.75s}
    .r{fill:none;stroke-dasharray:.22 1.3;stroke-dashoffset:.22;animation:run 2.8s cubic-bezier(.45,0,.35,1) 1.2s infinite}
    .r.b{animation-delay:1.75s} .r.t{animation-delay:2s}
    .glow{position:fixed;inset:0;background:radial-gradient(circle,#4a28d045 0,transparent 30%);opacity:0;animation:show 1s ease .3s forwards,breathe 2.6s ease-in-out 1.3s infinite}
    .line{margin-top:28px;color:#a1a1aa;opacity:0;animation:show .4s ease 1s forwards}
    @keyframes draw{to{stroke-dashoffset:0}} @keyframes run{45%,100%{stroke-dashoffset:-1}}
    @keyframes show{to{opacity:1}} @keyframes breathe{50%{opacity:.5}}
    @media (prefers-reduced-motion:reduce){.s{animation:none;stroke-dashoffset:0}.shine{display:none}}
    </style>
    <div class="glow"></div>
    <div role="status" aria-label="\(esc(line ?? "Opening Creator Toolset"))">
    <svg class="mark" viewBox="111 120 800 800" aria-hidden="true">
    <linearGradient id="w" gradientUnits="userSpaceOnUse" x1="0" y1="200" x2="0" y2="840"><stop offset="0" stop-color="#ece7ff"/><stop offset="1" stop-color="#b3a1ff"/></linearGradient>
    <filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="22"/></filter>
    <g stroke="url(#w)">\(ctStrokes("s"))</g>
    <g class="shine" stroke="#fff" opacity=".8" filter="url(#soft)">\(ctStrokes("r"))</g>
    </svg>\(line.map { "<p class=\"line\">\(esc($0))</p>" } ?? "")
    </div>
    """
}

/// The page shown when the site can't be reached; it retries by itself.
func unreachablePage(_ url: URL, _ error: Error) -> String {
    return pageHead + """
    <div><p>Can't reach \(esc(url.host ?? "the site")) right now. Trying again…</p>
    <p><a href="\(esc(url.absoluteString))">Try now</a></p><p><small>\(esc(error.localizedDescription))</small></p></div>
    <script>setTimeout(() => location.href = \(String(reflecting: url.absoluteString)), 5000)</script>
    """
}
