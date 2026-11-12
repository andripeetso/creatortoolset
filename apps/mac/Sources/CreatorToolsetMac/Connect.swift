// Connect on this Mac: the account's other computers (from the broker, apps/relay), and adding this Mac. The server
// does the linking and runs the tunnel (api/connect/routes.ts and connector.ts: a pinned cloudflared it starts once
// linked and at each start, and stops with itself); the app asks the server to start a link, opens the page and waits.
// Pure functions first, so the tests can check them.
import AppKit
import Foundation

/// The hosted connect service (apps/relay), the same one the iPhone app and `creatortoolset connect` use.
let defaultConnectService = URL(string: "https://connect.creatortoolset.com")!

/// The connect service's address, as saved in UserDefaults `connectBroker`: never set = defaultConnectService;
/// "" = none (forks, own setups). Having one sends nothing by itself: the service is asked only once "Add this Mac to
/// my account…" is pressed, or for the account's computers while signed in to an account (Shell.brokerComputers).
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

/// The device grant's start, as the server passes it on (api/connect/routes.ts POST /start).
struct ConnectStart: Decodable, Equatable {
    let user_code: String
    let verification_uri: String
    /// The same page with the code filled in, when the broker gives one: nothing to type.
    let verification_uri_complete: String?
    let expires_in: Int
    let interval: Int
}

/// The server's answer to POST /poll: pending, linked (with the tunnel's hostname), or failed with the broker's word.
struct ConnectPoll: Decodable, Equatable {
    let status: String
    let hostname: String?
    let error: String?
}

/// The broker's HTTP calls from this Mac: the account's computers (with a relay token from AccountClient.relayToken).
struct BrokerClient {
    let base: URL
    var session: URLSession = .shared

    func computers(token: String) async throws -> [BrokerComputer] {
        var request = URLRequest(url: URL(string: "/v1/computers", relativeTo: base)!)
        request.timeoutInterval = 15
        request.httpShouldHandleCookies = false
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw BrokerError.status((response as? HTTPURLResponse)?.statusCode ?? 0) }
        struct Reply: Decodable { let computers: [BrokerComputer] }
        return try JSONDecoder().decode(Reply.self, from: data).computers
    }
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
    /// The account's other computers, from the broker, with a short token the account server mints from this Mac's sign-in.
    /// Signed out, or the broker does not answer: none (the list just stays empty).
    func brokerComputers() async -> [ServerEntry] {
        guard let accountServer = account.server, let host = accountServer.host,
              let token = DeviceVault.token(for: host, service: Account.vault), let base = connectService else { return [] }
        let mine = server.flatMap { try? Data(contentsOf: $0.dataDir.appendingPathComponent("connect.json")) }
        guard let relay = try? await AccountClient(server: accountServer).relayToken(token),
              let list = try? await BrokerClient(base: base).computers(token: relay) else { return [] }
        return accountServers(list, thisComputer: tunnelConfig(data: mine)?.computerId)
    }

    /// "Add this Mac to my account": the server asks the broker for a code, the person approves it on the site, and the
    /// server links this computer; then this Mac's tunnel starts. Problems go to the window's notice and are returned
    /// (nil = on the account), for setup's Add this computer (the page's "connect" ask).
    @discardableResult func connectThisComputer() async -> String? {
        let problem = await linkThisComputer()
        notice = problem.map { "This Mac was not added: \($0)" } ?? "This Mac is on your account"
        return problem
    }

    /// Whether this Mac is on an account already (its server's connect.json, written once a link finishes).
    var linkedHere: Bool {
        guard let server else { return false }
        return tunnelConfig(data: try? Data(contentsOf: server.dataDir.appendingPathComponent("connect.json"))) != nil
    }

    private func linkThisComputer() async -> String? {
        guard server != nil, runsHere else { return "turn on This Mac's server first" }
        do {
            let start = try JSONDecoder().decode(ConnectStart.self, from: try await client().postData("/api/connect/start", [:]))
            notice = "Check that the page in your browser shows \(start.user_code), then add this Mac"
            if let url = URL(string: start.verification_uri_complete ?? start.verification_uri) { NSWorkspace.shared.open(url) }
            let deadline = Date().addingTimeInterval(TimeInterval(start.expires_in))
            while Date() < deadline {
                try await Task.sleep(for: .seconds(Double(max(start.interval, 2))))
                let poll = try JSONDecoder().decode(ConnectPoll.self, from: try await client().postData("/api/connect/poll", [:]))
                if poll.status == "pending" { continue }
                guard poll.status == "linked" else { return poll.error ?? "try again" }
                accountComputers = await brokerComputers()
                return nil
            }
            return "the code ran out, start again"
        } catch {
            return error.localizedDescription
        }
    }
}
