// Connect on this Mac: the account's other computers (from the broker, apps/relay), and this Mac on the account so the
// person's other devices reach it ("Reach from anywhere" in Settings → Computers). The app links with its own account
// sign-in, no page to approve: a challenge from the broker, a proof of it signed by the server's own key
// (/api/connect/link-proof), the broker's link, then the server keeps it and starts its tunnel (/api/connect/relay-config;
// api/connect/connector.ts runs a pinned cloudflared). Pure functions first, so the tests can check them.
import AppKit
import Foundation

/// The hosted connect service (apps/relay), the same one the iPhone app and `creatortoolset connect` use.
let defaultConnectService = URL(string: "https://connect.creatortoolset.com")!

/// The connect service's address, as saved in UserDefaults `connectBroker`: never set = defaultConnectService;
/// "" = none (forks, own setups). Having one sends nothing by itself: the service is asked only once "Add this Mac to
/// the account…" is pressed or Reach from anywhere is on, or for the account's computers while signed in to an account
/// (Shell.refreshReach).
func connectBrokerURL(_ saved: String?) -> URL? {
    guard let saved else { return defaultConnectService }
    return saved.trimmingCharacters(in: .whitespaces).isEmpty ? nil : siteURL(from: saved)
}

/// The connect service this Mac is set to use, if any. The menu item, the server's CT_CONNECT_URL and the account's
/// other computers all hang on it, so they are there together or not at all.
var connectService: URL? { connectBrokerURL(UserDefaults.standard.string(forKey: "connectBroker")) }

/// One computer on the account, as the broker lists it (GET /v1/computers).
struct BrokerComputer: Decodable, Equatable {
    let id: String
    let name: String
    let hostname: String
    let status: String
}

/// The account's other computers as Servers entries, on their tunnel hostnames. This computer, a computer the broker has
/// dropped ("gone"), and any hostname that is not a plain DNS name are left out: the window opens only what we can name.
func accountServers(_ computers: [BrokerComputer], thisComputer: String?) -> [ServerEntry] {
    computers.compactMap { c -> ServerEntry? in
        guard c.id != thisComputer, c.status != "gone", isPlainHostname(c.hostname),
              let url = siteURL(from: "https://\(c.hostname)") else { return nil }
        return ServerEntry(id: "computer-\(c.id)", name: c.name.isEmpty ? c.hostname : c.name, url: url.absoluteString)
    }
}

func isPlainHostname(_ host: String) -> Bool {
    !host.isEmpty && host.count <= 253 && host.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "." || $0 == "-") }
        && host == host.lowercased()
}

/// The broker's HTTP calls from this Mac: the account's computers (with a relay token from AccountClient.relayToken).
struct BrokerClient {
    let base: URL
    var session: URLSession = .shared
    /// This Mac's key: a relay token minted from its bound account token names it, and the broker takes such a token
    /// only with this key's proof on each request. A token that names no key ignores the proof.
    var key: DPoPKey? = nil

    private func authorize(_ request: inout URLRequest, _ token: String) throws {
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let key, let url = request.url else { return }
        request.setValue(try DPoP.proof(method: request.httpMethod ?? "GET", url: url, accessToken: token, key: key), forHTTPHeaderField: "DPoP")
    }

    func computers(token: String) async throws -> [BrokerComputer] {
        var request = URLRequest(url: URL(string: "/v1/computers", relativeTo: base)!)
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = false
        try authorize(&request, token)
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw BrokerError.status((response as? HTTPURLResponse)?.statusCode ?? 0) }
        struct Reply: Decodable { let computers: [BrokerComputer] }
        return try JSONDecoder().decode(Reply.self, from: data).computers
    }

    /// POST with the account token; the body is passed as it is (a proof the server signed is never re-encoded).
    func post(_ path: String, token: String, body: Data) async throws -> Data {
        var request = URLRequest(url: URL(string: path, relativeTo: base)!)
        request.httpMethod = "POST"
        request.timeoutInterval = 30
        request.httpShouldHandleCookies = false
        try authorize(&request, token)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw BrokerError.status((response as? HTTPURLResponse)?.statusCode ?? 0) }
        return data
    }

    /// Takes a computer off the account (204, or 404 when it already is).
    func unlink(_ computerId: String, token: String) async throws {
        var request = URLRequest(url: URL(string: "/v1/computers/\(computerId)", relativeTo: base)!)
        request.httpMethod = "DELETE"
        request.timeoutInterval = 30
        request.httpShouldHandleCookies = false
        try authorize(&request, token)
        let (_, response) = try await session.data(for: request)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard code == 204 || code == 404 else { throw BrokerError.status(code) }
    }

    /// The Mac app's account is changing (`newToken` nil: signing out). When the new account doesn't have this computer,
    /// the old account drops it first, with the old account's token, so it is never left behind there. True: it was
    /// dropped, so the server forgets the link too. The new account's list not coming = nothing is done.
    func leave(_ computerId: String, oldToken: String, newToken: String?) async -> Bool {
        if let newToken {
            guard let list = try? await computers(token: newToken) else { return false }
            if list.contains(where: { $0.id == computerId }) { return false }
        }
        do {
            try await unlink(computerId, token: oldToken)
            return true
        } catch {
            return false
        }
    }

    /// The link with the account token: the broker's challenge, the server's signed proof of it, the broker's link, and
    /// the server keeps what the broker answered (with the broker's address) and starts its tunnel. `local` posts JSON to
    /// this Mac's own server as its owner and returns the answer.
    func link(token: String, local: (String, [String: Any]) async throws -> Data) async throws {
        struct Challenge: Decodable { let challenge: String }
        let challenge = try JSONDecoder().decode(Challenge.self, from: try await post("/v1/computers/link-challenges", token: token, body: Data("{}".utf8)))
        let relayUrl = base.absoluteString
        let proof = try await local("/api/connect/link-proof", ["challenge": challenge.challenge, "relayUrl": relayUrl])
        let linked = try await post("/v1/computers/link", token: token, body: proof)
        guard let answer = try JSONSerialization.jsonObject(with: linked) as? [String: Any] else { throw BrokerError.status(0) }
        // the fields the server's relay-config takes (api/connect/contract.md), and the broker it linked with
        var config = answer.filter { ["owner", "computerId", "hostname", "tunnelToken", "brokerKey", "brokerKid"].contains($0.key) }
        config["brokerUrl"] = relayUrl
        _ = try await local("/api/connect/relay-config", config)
    }
}

/// What this Mac keeps from the connect service between refreshes (every 30 s): the relay token until a minute before
/// it ends, and the account's computers for 60 s; both for one account token only, so another sign-in asks again.
struct BrokerCache {
    static let listFor: TimeInterval = 60
    private var account: String?
    private var relay: (token: String, until: Date)?
    private var list: (at: Date, computers: [BrokerComputer])?

    /// The kept relay token for this account token, or nil: none, another account's, or within a minute of its end.
    func relayToken(for account: String, now: Date = Date()) -> String? {
        guard account == self.account, let relay, now < relay.until else { return nil }
        return relay.token
    }

    /// `expiresIn`: the token's life as the account server said it (300 s when it didn't).
    mutating func keep(relayToken token: String, expiresIn: TimeInterval?, for account: String, now: Date = Date()) {
        use(account)
        relay = (token, now.addingTimeInterval((expiresIn ?? 300) - 60))
    }

    /// The account's computers fetched less than 60 s ago for this account token, or nil.
    func list(for account: String, now: Date = Date()) -> [BrokerComputer]? {
        guard account == self.account, let list, now.timeIntervalSince(list.at) < Self.listFor else { return nil }
        return list.computers
    }

    mutating func keep(list computers: [BrokerComputer], for account: String, now: Date = Date()) {
        use(account)
        list = (now, computers)
    }

    /// The connect service turned the relay token down (401): the next call mints a new one.
    mutating func failed(_ error: Error) {
        if case BrokerError.status(401) = error { relay = nil }
    }

    /// Another account token: nothing kept for the last one counts.
    private mutating func use(_ account: String) {
        if account != self.account { self = BrokerCache(); self.account = account }
    }
}

/// Reach from anywhere (Settings → Computers): this Mac on the account. On by itself once the Mac app is signed in;
/// turned off by the person, or when the account no longer has this Mac.
enum Reach: String {
    case signedOut = "signed-out", off, unreachable, available, removed

    /// The row's words (the page shows them under the switch).
    var text: String {
        switch self {
        case .signedOut: return "Sign in to make this Mac available to your other devices."
        case .off: return "Make this Mac available to your other devices through your account."
        case .unreachable: return "On, but other devices can't reach this Mac."
        case .available: return "Available to your other devices through your account."
        case .removed: return "This Mac was removed from your account. Turn it on to add it again."
        }
    }
}

/// UserDefaults: the switch (never set = on), and the account dropping this Mac (cleared when it is turned on again).
let reachKey = "connectReach"
let reachRemovedKey = "connectReachRemoved"
var reachSwitch: Bool {
    get { UserDefaults.standard.object(forKey: reachKey) as? Bool ?? true }
    set { UserDefaults.standard.set(newValue, forKey: reachKey) }
}

/// The row's state. `listed`: this Mac in the broker's list for the account (nil: not in it, or the list did not come).
func reachState(signedIn: Bool, on: Bool, removed: Bool, linked: Bool, listed: BrokerComputer?) -> Reach {
    guard signedIn else { return .signedOut }
    if removed { return .removed }
    guard on else { return .off }
    return linked && ["healthy", "degraded"].contains(listed?.status ?? "") ? .available : .unreachable
}

/// Whether the account dropped this Mac: it is linked here, the account's list came, and this Mac is not in it.
func droppedFromAccount(linkedId: String?, list: [BrokerComputer]?) -> Bool {
    guard let linkedId, let list else { return false }
    return !list.contains { $0.id == linkedId }
}

enum BrokerError: Error, Equatable {
    case status(Int)
}

/// This computer's tunnel, from connect.json in the data folder. Nil = not linked, or the file cannot be read (then no
/// tunnel is started: fail closed).
struct TunnelConfig: Decodable, Equatable {
    let computerId: String
    let hostname: String
    let tunnelToken: String
}

func tunnelConfig(data: Data?) -> TunnelConfig? {
    guard let data, let c = try? JSONDecoder().decode(TunnelConfig.self, from: data), !c.tunnelToken.isEmpty else { return nil }
    return c
}

extension Shell {
    private var linkedConfig: TunnelConfig? {
        tunnelConfig(data: server.flatMap { try? Data(contentsOf: $0.dataDir.appendingPathComponent("connect.json")) })
    }

    /// Whether this Mac is on an account already (its server's connect.json, written once a link finishes).
    var linkedHere: Bool { linkedConfig != nil }

    /// The broker account token, minted by the account server from this Mac's sign-in and kept until a minute before it
    /// ends. Nil: signed out, no service, or the account server did not answer.
    private func relayToken() async -> String? {
        guard let accountServer = account.server, connectService != nil, let token = await account.token() else { return nil }
        if let kept = broker.relayToken(for: token) { return kept }
        guard let minted = try? await AccountClient(server: accountServer, key: DPoPKey.shared).relayToken(token) else { return nil }
        broker.keep(relayToken: minted.token, expiresIn: minted.expiresIn, for: token)
        return minted.token
    }

    /// Every refresh: the account's other computers, the switch's state, and the link made by itself when the switch is
    /// on and the Mac app is signed in. The account dropping this Mac turns the switch off and forgets the link here.
    /// The list is asked for at most once a minute; `force`: now (the person changed something, or signed in).
    func refreshReach(force: Bool = false) async {
        let signedIn = account.profile != nil
        var list: [BrokerComputer]?
        if signedIn, connectService != nil {
            if !force, let token = await account.token() { list = broker.list(for: token) }
            if list == nil { list = try? await refreshedList() }
        }
        let mine = linkedConfig?.computerId
        accountComputers = accountServers(list ?? [], thisComputer: mine)
        if reachSwitch, droppedFromAccount(linkedId: mine, list: list) {
            AppLog.write("the account no longer has this Mac: Reach from anywhere is off")
            try? await client().delete("/api/connect/relay-config")
            reachSwitch = false
            UserDefaults.standard.set(true, forKey: reachRemovedKey)
        }
        let removed = UserDefaults.standard.bool(forKey: reachRemovedKey)
        if signedIn, reachSwitch, !removed, !linkedHere, runsHere, server != nil, list != nil,
           Date().timeIntervalSince(lastReachTry ?? .distantPast) > 300 {
            lastReachTry = Date()
            if await linkThisComputer() == nil { list = try? await refreshedList() }
        }
        reach = reachState(signedIn: signedIn, on: reachSwitch, removed: removed, linked: linkedHere,
                           listed: list?.first { $0.id == linkedConfig?.computerId })
        pushThisMac()
    }

    /// Account.leaving: this Mac leaves the account it is linked to before the Mac app's sign-in becomes another one (or
    /// none), using the old sign-in while it still has it. A Mac linked here then joins the new account by itself.
    /// It mints with the two tokens it is given, never from the cache, which it empties: the sign-in is changing.
    func leaveAccount(oldToken: String, newToken: String?) async {
        broker = BrokerCache()
        guard let id = linkedConfig?.computerId, let base = connectService, let accountServer = account.server,
              let old = try? await AccountClient(server: accountServer, key: DPoPKey.shared).relayToken(oldToken).token else { return }
        var new: String?
        if let newToken {
            new = try? await AccountClient(server: accountServer, key: DPoPKey.shared).relayToken(newToken).token
            if new == nil { return }
        }
        if await BrokerClient(base: base, key: DPoPKey.shared).leave(id, oldToken: old, newToken: new) {
            try? await client().delete("/api/connect/relay-config")
        } else if new == nil {
            AppLog.write("this Mac stays on the account it was signed in to: the connect service couldn't be reached")
        }
    }

    /// The account's computers from the connect service now, kept for the next minute's refreshes.
    private func refreshedList() async throws -> [BrokerComputer]? {
        guard let base = connectService, let accountToken = await account.token(), let token = await relayToken() else { return nil }
        do {
            let list = try await BrokerClient(base: base, key: DPoPKey.shared).computers(token: token)
            broker.keep(list: list, for: accountToken)
            return list
        } catch {
            broker.failed(error)
            throw error
        }
    }

    /// The page's connect.link / connect.unlink (Settings → Computers → Reach from anywhere). Returns the problem, or nil.
    func setReach(_ on: Bool) async -> String? {
        reachSwitch = on
        if on { UserDefaults.standard.removeObject(forKey: reachRemovedKey) }
        let problem = on ? (linkedHere ? nil : await linkThisComputer()) : await unlinkThisComputer()
        await refreshReach(force: true)
        return problem
    }

    /// "Add this Mac to the account" (Servers menu, setup's Add this computer): the same link the switch makes. Problems
    /// go to the window's notice and are returned (nil = on the account).
    @discardableResult func connectThisComputer() async -> String? {
        reachSwitch = true
        UserDefaults.standard.removeObject(forKey: reachRemovedKey)
        let problem = await linkThisComputer()
        notice = problem.map { "This Mac was not added: \($0)" } ?? "This Mac is on your account"
        await refreshReach(force: true)
        return problem
    }

    private func linkThisComputer() async -> String? {
        guard server != nil, runsHere else { return "turn on This Mac's server first" }
        guard let base = connectService else { return "this Mac has no connect service set" }
        guard account.profile != nil, let token = await relayToken() else { return Reach.signedOut.text }
        do {
            try await BrokerClient(base: base, key: DPoPKey.shared).link(token: token) { path, body in try await self.client().postData(path, body) }
            return nil
        } catch BrokerError.status(403) {
            return "your account has as many computers as it can have. Remove one first"
        } catch {
            broker.failed(error)
            AppLog.write("this Mac was not added to the account: \(error.localizedDescription)")
            return "try again"
        }
    }

    /// Off: the account drops this Mac first (so no phone is sent to it), then the server forgets the link and stops its
    /// tunnel. A broker that can't be reached leaves it on the account, and says so.
    private func unlinkThisComputer() async -> String? {
        guard let id = linkedConfig?.computerId else { return nil }
        guard let base = connectService, let token = await relayToken() else { return Reach.signedOut.text }
        do {
            try await BrokerClient(base: base, key: DPoPKey.shared).unlink(id, token: token)
        } catch {
            broker.failed(error)
            return "The connect service couldn't be reached. Try again."
        }
        try? await client().delete("/api/connect/relay-config")
        return nil
    }
}
