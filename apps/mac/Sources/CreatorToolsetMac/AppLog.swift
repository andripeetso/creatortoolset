// The app's own log: launches, page loads that fail,
// a page whose web process died, the page's script errors, a page left blank. ~/Library/Logs/Creator Toolset.log,
// "Open app log" in the menu bar; a crash of the app itself is macOS's report in ~/Library/Logs/DiagnosticReports.
import Foundation

enum AppLog {
    static let path = NSHomeDirectory() + "/Library/Logs/Creator Toolset\(AppIdentity.tag()).log"

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

/// A one-line page for the window while the server on this Mac starts, or after it stopped.
func messagePage(_ text: String) -> String {
    pageHead + "<div><p>\(esc(text))</p></div>"
}

/// The page shown when the site can't be reached; it retries by itself.
func unreachablePage(_ url: URL, _ error: Error) -> String {
    return pageHead + """
    <div><p>Can't reach \(esc(url.host ?? "the site")) right now. Trying again…</p>
    <p><a href="\(esc(url.absoluteString))">Try now</a></p><p><small>\(esc(error.localizedDescription))</small></p></div>
    <script>setTimeout(() => location.href = \(String(reflecting: url.absoluteString)), 5000)</script>
    """
}
