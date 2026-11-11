// Connect on this Mac: the account's other computers (from the broker, apps/relay), and this Mac's own tunnel. The
// server does the linking (api/connect/routes.ts: the device grant and the link, signed with the computer's key); the
// app asks the server to start it, shows the code, and once the server says linked it runs cloudflared with the
// tunnel token the server saved (connect.json, mode 0600). The token goes in cloudflared's environment, never in its
// arguments, so `ps` does not show it. Pure functions first, so the tests can check them.
import AppKit
import Foundation

/// The connect service's address (the broker, apps/relay), as saved in UserDefaults `connectBroker`. None until one is
/// set: no hosted one answers yet, so by default the app offers nothing that needs it ("Add this Mac to my account…")
/// and asks nothing of it.
func connectBrokerURL(_ saved: String?) -> URL? {
    guard let saved, !saved.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
    return siteURL(from: saved)
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

/// cloudflared runs as `cloudflared tunnel run`, with the token in TUNNEL_TOKEN: the arguments never carry it.
func tunnelArguments() -> [String] { ["tunnel", "--no-autoupdate", "run"] }

func tunnelEnvironment(_ token: String, base: [String: String]) -> [String: String] {
    var env = base.filter { ["HOME", "TMPDIR", "PATH", "LANG"].contains($0.key) }
    env["TUNNEL_TOKEN"] = token
    return env
}

/// The cloudflared the release bundles beside the server's runtime (runtime/cloudflared, like ffmpeg). Nil when this build
/// has none: no tunnel, and the Mac says so.
func cloudflaredBinary(server: URL?) -> URL? {
    guard let bin = server?.appendingPathComponent("runtime/cloudflared"), FileManager.default.isExecutableFile(atPath: bin.path) else { return nil }
    return bin
}

/// Runs this Mac's tunnel while the server runs, and brings it back after a crash or a relaunch (the same backoff as
/// the server). It stops with the app.
@MainActor
final class TunnelRunner: ObservableObject {
    enum State: Equatable {
        case off, running
        case failed(String)
    }

    @Published private(set) var state = State.off
    private var process: Process?
    private var crashes: [Date] = []
    private var stopping = false

    init() {
        NotificationCenter.default.addObserver(forName: NSApplication.willTerminateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.stop() }
        }
    }

    /// Starts the tunnel if this computer is linked. Not linked = off, with no error; no binary = failed, said once.
    func start(server: URL?, dataDir: URL) {
        guard process == nil else { return }
        stopping = false
        guard let config = tunnelConfig(data: try? Data(contentsOf: dataDir.appendingPathComponent("connect.json"))) else {
            state = .off
            return
        }
        guard let bin = cloudflaredBinary(server: server) else {
            state = .failed("This build has no cloudflared")
            return
        }
        let p = Process()
        p.executableURL = bin
        p.arguments = tunnelArguments()
        p.environment = tunnelEnvironment(config.tunnelToken, base: ProcessInfo.processInfo.environment)
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.terminationHandler = { [weak self] ended in
            Task { @MainActor in self?.ended(ended, server: server, dataDir: dataDir) }
        }
        do {
            try p.run()
        } catch {
            state = .failed("cloudflared could not start")
            return
        }
        process = p
        state = .running
    }

    func stop() {
        stopping = true
        process?.terminate()
        process = nil
        state = .off
    }

    private func ended(_ p: Process, server: URL?, dataDir: URL) {
        guard p === process else { return }   // stop() already handled it
        process = nil
        if stopping { return }
        let now = Date()
        crashes.append(now)
        guard let delay = restartDelay(crashes: crashes, now: now) else {
            state = .failed("The tunnel stopped. Restart the app")
            return
        }
        Task {
            try? await Task.sleep(for: .seconds(delay))
            if !self.stopping { self.start(server: server, dataDir: dataDir) }
        }
    }
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
    /// server links this computer; then this Mac's tunnel starts. Problems go to the window's notice.
    func connectThisComputer() async {
        guard let server, runsHere else { notice = "Turn on This Mac's server first"; return }
        do {
            let start = try JSONDecoder().decode(ConnectStart.self, from: try await client().postData("/api/connect/start", [:]))
            notice = "Check that the page in your browser shows \(start.user_code), then add this Mac"
            if let url = URL(string: start.verification_uri_complete ?? start.verification_uri) { NSWorkspace.shared.open(url) }
            let deadline = Date().addingTimeInterval(TimeInterval(start.expires_in))
            while Date() < deadline {
                try await Task.sleep(for: .seconds(Double(max(start.interval, 2))))
                let poll = try JSONDecoder().decode(ConnectPoll.self, from: try await client().postData("/api/connect/poll", [:]))
                if poll.status == "pending" { continue }
                guard poll.status == "linked" else { notice = "This Mac was not added: \(poll.error ?? "try again")"; return }
                notice = "This Mac is on your account"
                tunnel.start(server: LocalServer.folder, dataDir: server.dataDir)
                accountComputers = await brokerComputers()
                return
            }
            notice = "The code ran out. Start again."
        } catch {
            notice = "This Mac was not added: \(error.localizedDescription)"
        }
    }
}
