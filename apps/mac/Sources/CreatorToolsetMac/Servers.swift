// The servers the window can open: "This Mac" (the bundled server, Server.swift) and any server added by its address.
// The list is [{id, name, url}] in UserDefaults; "This Mac" is never stored, it is there whenever the build has a server.
// Plain functions of their inputs, so the tests can check them; Shell.swift keeps the state.
import Foundation

struct ServerEntry: Codable, Equatable, Identifiable {
    let id: String
    var name: String
    var url: String
}

/// The id of the server on this Mac in the menus and in `currentServer`.
let thisMacID = "this-mac"

/// The menus' list: This Mac first (when this build has a server), then the added ones in the order they were added.
func listedServers(_ added: [ServerEntry], hasLocal: Bool) -> [ServerEntry] {
    (hasLocal ? [ServerEntry(id: thisMacID, name: "This Mac", url: "")] : []) + added
}

/// The old settings (one "siteAddress", the "runServerHere" switch) as the list, once. The old keys are left as they
/// are: another copy of the app may still read them. No address saved = no server added; there is no default site.
func migratedServers(site: String?, runsHere: Bool?, hasLocal: Bool, newID: () -> String = { UUID().uuidString })
    -> (servers: [ServerEntry], current: String?) {
    var servers: [ServerEntry] = []
    if let site, let url = siteURL(from: site) {
        servers.append(ServerEntry(id: newID(), name: url.host ?? url.absoluteString, url: url.absoluteString))
    }
    if hasLocal && runsHere != false { return (servers, thisMacID) }
    return (servers, servers.first?.id)
}

/// What "Add server" was given: the server's address, and a one-time sign-in link's path when one was pasted
/// (…/api/auth/link/<code>, from a server signed in elsewhere). A bare name gets https://.
struct ServerInput: Equatable {
    let url: URL
    let signInPath: String?
}

func serverInput(_ text: String) -> ServerInput? {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    let full = trimmed.contains("://") ? trimmed : "https://" + trimmed
    guard let url = siteURL(from: full), let parts = URLComponents(string: full) else { return nil }
    let prefix = "/api/auth/link/"
    let path = parts.percentEncodedPath
    let signIn = path.hasPrefix(prefix) && path.count > prefix.count && !path.dropFirst(prefix.count).contains("/") ? path : nil
    return ServerInput(url: url, signInPath: signIn)
}

/// The list with the server added, and its id. A server already in the list (same scheme, host and port) is not
/// added twice: its id comes back.
func addingServer(_ url: URL, name: String, to list: [ServerEntry], newID: () -> String = { UUID().uuidString })
    -> (servers: [ServerEntry], id: String) {
    if let known = list.first(where: { $0.url == url.absoluteString }) { return (list, known.id) }
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    let entry = ServerEntry(id: newID(), name: trimmed.isEmpty ? (url.host ?? url.absoluteString) : trimmed, url: url.absoluteString)
    return (list + [entry], entry.id)
}

/// Removing the server the window shows leaves no server picked (the window asks to pick or add one).
func removingServer(_ id: String, from list: [ServerEntry], current: String?) -> (servers: [ServerEntry], current: String?) {
    (list.filter { $0.id != id }, current == id ? nil : current)
}

/// A new name; an empty one keeps the old.
func renamingServer(_ id: String, to name: String, in list: [ServerEntry]) -> [ServerEntry] {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return list }
    return list.map { $0.id == id ? ServerEntry(id: $0.id, name: trimmed, url: $0.url) : $0 }
}

/// The saved pick, if it still exists in this build (This Mac needs a build with the server).
func validCurrent(_ saved: String?, in list: [ServerEntry], hasLocal: Bool) -> String? {
    guard let saved else { return nil }
    if saved == thisMacID { return hasLocal ? saved : nil }
    return list.contains { $0.id == saved } ? saved : nil
}

// MARK: Run your own server: the guide's checks

/// One check's outcome: ok, failed (with what to do), or not run yet / can't tell.
struct GuideCheck: Equatable {
    enum State: Equatable { case unknown, ok, failed }
    let state: State
    let text: String

    static func ok(_ text: String) -> GuideCheck { GuideCheck(state: .ok, text: text) }
    static func failed(_ text: String) -> GuideCheck { GuideCheck(state: .failed, text: text) }
    static func unknown(_ text: String) -> GuideCheck { GuideCheck(state: .unknown, text: text) }
}

/// GET https://<domain>/api/health, read as two checks: is HTTPS valid, and does the app answer. `status` and `body`
/// are the answer, `error` the failure (NSURLError codes).
func healthChecks(status: Int?, body: Data?, error: Error?) -> (https: GuideCheck, reachable: GuideCheck) {
    if let error {
        let e = error as NSError
        let cert = [NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate, NSURLErrorServerCertificateNotYetValid,
                    NSURLErrorServerCertificateHasUnknownRoot, NSURLErrorSecureConnectionFailed, NSURLErrorClientCertificateRejected]
        if e.domain == NSURLErrorDomain && cert.contains(e.code) {
            return (.failed("The certificate isn't valid yet. Caddy gets one once the name points at the server and ports 80 and 443 are open: docker compose logs caddy"),
                    .unknown("Waits for HTTPS"))
        }
        if e.domain == NSURLErrorDomain && [NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed].contains(e.code) {
            return (.unknown("Waits for the name"), .failed("The name doesn't resolve yet. Add the A record and give it a few minutes: dig +short <your domain>"))
        }
        if e.domain == NSURLErrorDomain && [NSURLErrorCannotConnectToHost, NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost].contains(e.code) {
            return (.unknown("Waits for the server"), .failed("Nothing answers on port 443. Is the server on, the kit started (docker compose ps) and the port open?"))
        }
        return (.unknown("Couldn't tell"), .failed(e.localizedDescription))
    }
    let https = GuideCheck.ok("HTTPS is valid")
    guard let status else { return (https, .failed("No answer")) }
    struct Health: Decodable { let ok: Bool }
    if status == 200, let body, (try? JSONDecoder().decode(Health.self, from: body))?.ok == true {
        return (https, .ok("The app answers"))
    }
    if status == 502 || status == 503 || status == 504 {
        return (https, .failed("Caddy answers but the app doesn't yet (\(status)). The first build takes a while: docker compose logs app"))
    }
    return (https, .failed("The address answered \(status), not the app's health check. Is it the right address?"))
}

// MARK: the menu bar icon's status

enum MenuStatus: Equatable {
    /// nothing runs here: the server is off (or elsewhere) and this Mac doesn't answer AI
    case idle
    /// the server here runs, or this Mac answers AI
    case up
    /// this Mac is running AI jobs
    case busy
    /// the server here failed, or the last AI job failed, or the data disk is nearly full
    case problem
}

func menuStatus(serverFailed: Bool, serverUp: Bool, aiOn: Bool, aiRunning: Int, aiError: Bool, lowSpace: Bool) -> MenuStatus {
    if serverFailed || aiError || lowSpace { return .problem }
    if aiOn && aiRunning > 0 { return .busy }
    return serverUp || aiOn ? .up : .idle
}
