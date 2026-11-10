// The parts that are plain functions of their inputs, so the unit tests can check them
// without a window, a site or a worker.
import Foundation

/// Settings text to a site address (https, or http for localhost only: the session cookie is sent by hand, so
/// it must never go in clear to another host); host and optional port. nil when it isn't one.
func siteURL(from text: String) -> URL? {
    guard let url = URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
          let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
          let host = url.host else { return nil }
    let local = ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host.lowercased())
    guard scheme == "https" || local else { return nil }
    let port = url.port.map { ":\($0)" } ?? ""
    return URL(string: "\(scheme)://\(host)\(port)")
}

/// Same host as the site: the window keeps these links, anything else opens in the default browser.
func isSite(_ url: URL, _ site: URL) -> Bool {
    url.host?.lowercased() == site.host?.lowercased()
}

/// A link the window should open: creatortoolset://review/<id>?v=2 (the scheme the app registers), or the site's own
/// https link, as `open -a "Creator Toolset" <url>` delivers it. The path, query and fragment to load in the window;
/// nil for anything else.
func appHref(from url: URL, site: URL) -> String? {
    guard let c = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    let path: String
    switch c.scheme?.lowercased() {
    case "creatortoolset":   // creatortoolset://review/abc: "review" is the URL's host
        path = "/" + (c.percentEncodedHost ?? "") + c.percentEncodedPath
    case "http", "https":
        guard isSite(url, site) else { return nil }
        path = c.percentEncodedPath.isEmpty ? "/" : c.percentEncodedPath
    default:
        return nil
    }
    let normalized = path.replacingOccurrences(of: "//", with: "/")
    return normalized + (c.percentEncodedQuery.map { "?" + $0 } ?? "") + (c.percentEncodedFragment.map { "#" + $0 } ?? "")
}

/// The cookies the site would be sent: cookies for its host or a parent domain of it (Secure ones only over https).
func cookies(for site: URL, in all: [HTTPCookie]) -> [HTTPCookie] {
    guard let host = site.host?.lowercased() else { return [] }
    return all.filter { cookie in
        if cookie.isSecure && site.scheme != "https" { return false }
        let domain = cookie.domain.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "."))
        return host == domain || host.hasSuffix("." + domain)
    }
}

/// "name.ext", then "name (2).ext", … so a download never replaces a file.
func uniqueURL(in folder: URL, named name: String) -> URL {
    var candidate = folder.appendingPathComponent(name)
    let ext = candidate.pathExtension
    let stem = candidate.deletingPathExtension().lastPathComponent
    var n = 2
    while FileManager.default.fileExists(atPath: candidate.path) {
        candidate = folder.appendingPathComponent(ext.isEmpty ? "\(stem) (\(n))" : "\(stem) (\(n)).\(ext)")
        n += 1
    }
    return candidate
}

/// Whether the AI comes on by itself when the open server answers: only when it was on before and no runner runs yet.
/// A first run is off (no pairing until the person presses Connect). Pure, so the tests check it without a window.
func startsAIWhenReady(aiOn: Bool, running: Bool) -> Bool { aiOn && !running }

/// One line of the site's inbox (api/review.ts notifications): the fields the bell shows.
struct ReviewNote: Decodable {
    let id: String
    let kind: String
    let by: String
    let name: String
    let text: String?
    let href: String
    let read: Bool?
}

struct NotesResponse: Decodable {
    let items: [ReviewNote]
    let unread: Int
}

/// The bell's wording (NotificationBell.tsx VERB).
private let verbs = [
    "comment": "commented on", "reply": "replied on", "approved": "approved", "changes": "requested changes on",
    "version": "uploaded a new version of", "ready": "made a cut for your review:", "producing": "started producing",
    "delivered": "delivered", "workshop": "finished a turn in", "failed": "could not finish a job in",
]

func noteTitle(_ note: ReviewNote) -> String {
    "\(note.by) \(verbs[note.kind] ?? "updated") \(note.name)"
}

/// Unread notes not seen before. `seen` is nil on the first run: nothing is shown then, the
/// inbox is only remembered, so old items don't flood the Mac.
func freshNotes(_ items: [ReviewNote], seen: [String]?) -> [ReviewNote] {
    guard let seen else { return [] }
    return items.filter { $0.read != true && !seen.contains($0.id) }
}

/// The ids to remember next time: this inbox first, then what was remembered, capped.
func rememberedIDs(_ items: [ReviewNote], seen: [String]?) -> [String] {
    var ids = items.map(\.id)
    for id in seen ?? [] where !ids.contains(id) { ids.append(id) }
    return Array(ids.prefix(200))
}

/// The main window's size on first open: most of the screen, up to 1440×920 (the pages are laid out for that), never
/// under the 960×640 minimum.
func roomyWindowFrame(screen: CGRect) -> CGRect {
    let w = max(960, min(1440, (screen.width * 0.85).rounded()))
    let h = max(640, min(920, (screen.height * 0.85).rounded()))
    return CGRect(x: (screen.midX - w / 2).rounded(), y: (screen.midY - h / 2).rounded(), width: w, height: h)
}

/// A window still at (or near) the minimum size grows to roomyWindowFrame once: earlier builds opened it that small
/// and macOS keeps the size, even across a reinstall. nil = leave it.
func grownWindowFrame(current: CGRect, screen: CGRect) -> CGRect? {
    current.width < 1000 && current.height < 700 ? roomyWindowFrame(screen: screen) : nil
}

/// A screenshot's size for the assistant: at most `longest` pixels on its longest side, never enlarged.
func fittedSize(width: Int, height: Int, longest: Int = 2000) -> (width: Int, height: Int) {
    let side = max(width, height)
    guard side > longest, side > 0 else { return (width, height) }
    let scale = Double(longest) / Double(side)
    return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
}

/// Where DaVinci Resolve's own script runner (fuscript, no Python) is, or nil when Resolve isn't installed: the helper
/// stays off then. `exists` is the file check (FileManager in the app, a fake in the tests).
func resolveScriptRunner(exists: (String) -> Bool) -> String? {
    let runner = "/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Libraries/Fusion/fuscript"
    return exists(runner) ? runner : nil
}

/// Review notes and macOS's notification prompt: a fresh note waits while macOS is undecided and the app is in the
/// background (nothing asked from behind), asks once with a line first when the app is in front, and posts otherwise
/// (answered, or asked before: a declined prompt makes the post a no-op).
enum NotePostStep: Equatable { case wait, askFirst, post }

func notePostStep(undetermined: Bool, appActive: Bool, asked: Bool) -> NotePostStep {
    guard undetermined, !asked else { return .post }
    return appActive ? .askFirst : .wait
}

/// Closing the last window keeps the app in the menu bar, and says so once. Not while the app is quitting: quitting
/// (and the relaunches that quit) closes the windows too.
func closeNoticeNeeded(quitting: Bool, said: Bool) -> Bool { !quitting && !said }
