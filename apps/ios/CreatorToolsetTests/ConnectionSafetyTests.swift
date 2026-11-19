import XCTest
@testable import CreatorToolset

/// What keeps a credential with the right server: which routes are opened, what a network change forgets, how an
/// account session stays fresh, what a redirect takes along, and a server too busy to check a proof.
@MainActor
final class ConnectionSafetyTests: XCTestCase {
    private func url(_ s: String) -> URL { URL(string: s)! }

    // MARK: which routes are opened

    private func walk(_ routes: [Route], _ checks: [String: ServerSupervisor.RouteCheck]) async throws -> [String] {
        var opened: [String] = []
        let found: String? = try await ServerSupervisor.walk(routes, headStart: 0.2, check: { checks[$0.id] ?? .silent }) { route in
            opened.append(route.id)
            return nil
        }
        XCTAssertNil(found)
        return opened
    }

    func testARouteIsOpenedOnlyOnceItSaysItIsThisServer() async throws {
        let lan = Route.paired(url("http://10.0.0.20:43190/"))
        // one route alone is checked too: another machine at that address gets nothing
        let alone = try await walk([lan], [lan.id: .other])
        XCTAssertEqual(alone, [])
        // a plain-HTTP LAN address that didn't answer is never opened; an HTTPS one is, last; the account's is unchecked
        let other = Route.paired(url("http://10.0.0.21:43190/"))
        let https = Route.paired(url("https://studio.example.com/"))
        let account = Route.account(url("https://mac-1.connect.example/"))
        let opened = try await walk([lan, other, https, account], [lan.id: .other, other.id: .silent, https.id: .silent])
        XCTAssertEqual(opened, [account.id, https.id])
        let answered = try await walk([lan, account], [lan.id: .answered])
        XCTAssertEqual(answered, [lan.id, account.id])
    }

    func testANetworkChangeForgetsTheRouteInUseUntilItIsCheckedAgain() throws {
        let lan = Route.paired(url("http://10.0.0.20:43190/"))
        let id = "test-path-\(UUID().uuidString)"
        let entry = ServerEntry(serverId: id, label: "Mac", routes: [lan], activeRouteId: lan.id, home: lan.url)
        ServerRegistry.setCredential(id, routeId: lan.id, Credential(kind: .bearer, token: "cts_lan"))
        defer { ServerRegistry.forgetCredentials(entry) }
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "path-\(UUID().uuidString)"))
        let connections = Connections(saved: .init(servers: [entry], currentKey: entry.key), live: false)
        connections.pathChanged(online: true, shape: "wifi en0 gw 10.0.0.1", defaults: defaults)
        connections.pathChanged(online: true, shape: "wifi en0 gw 10.0.0.1", defaults: defaults)
        XCTAssertEqual(connections.entry(id)?.activeRouteId, lan.id)
        connections.pathChanged(online: true, shape: "cell pdp_ip0", defaults: defaults)
        let moved = try XCTUnwrap(connections.entry(id))
        XCTAssertNil(moved.activeRouteId)
        // nothing checked on this network: no request leaves the phone, the token least of all
        let api = API.connected(moved)
        XCTAssertTrue(api.unrouted)
        XCTAssertEqual(api.request("/api/library").url, API.nowhere)
        XCTAssertEqual(api.request("/api/library").value(forHTTPHeaderField: "Authorization"), nil)
        XCTAssertEqual(api.key, entry.key)
    }

    func testALaunchInTheBackgroundOpensNoLine() async throws {
        let route = Route.paired(url("https://bg-launch.invalid/"))
        let id = "test-bg-\(UUID().uuidString)"
        let entry = ServerEntry(serverId: id, label: "Mac", routes: [route], home: route.url)
        ServerRegistry.setCredential(id, routeId: route.id, Credential(kind: .bearer, token: "cts_bg"))
        defer { ServerRegistry.forgetCredentials(entry) }
        let connections = Connections(saved: .init(servers: [entry], currentKey: entry.key), live: true, background: true)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(connections.state(id).attempt, 0)
        XCTAssertNotEqual(connections.state(id).phase, .connecting)
    }

    // MARK: account sessions

    private final class Mint {
        var count = 0
        var lifetime: TimeInterval = 1
        func session(_ id: String) async throws -> (URL, Credential) {
            count += 1
            return (URL(string: "https://mac-1.connect.example/")!,
                    Credential(kind: .dpop, token: "s\(count)", expiresAt: Date().addingTimeInterval(lifetime)))
        }
    }

    private func accountServer() -> (ServerEntry, Connections, Mint) {
        let account = Route.account(url("https://mac-1.connect.example/"))
        let entry = ServerEntry(serverId: "test-renew-\(UUID().uuidString)", label: "Mac", routes: [account],
                                activeRouteId: account.id, home: account.url)
        let connections = Connections(saved: .init(servers: [entry], currentKey: entry.key), live: false)
        let mint = Mint()
        connections.mint = mint.session
        addTeardownBlock { ServerRegistry.forgetCredentials(entry) }
        return (entry, connections, mint)
    }

    func testTheRenewalTimeLeavesAMinuteOrHalfAShortSession() {
        let now = Date()
        let hour = Credential(kind: .dpop, token: "a", expiresAt: now.addingTimeInterval(3600))
        XCTAssertEqual(Connections.renewAt(hour, now: now)!.timeIntervalSince(now), 3540, accuracy: 0.01)
        let short = Credential(kind: .dpop, token: "a", expiresAt: now.addingTimeInterval(30))
        XCTAssertEqual(Connections.renewAt(short, now: now)!.timeIntervalSince(now), 15, accuracy: 0.01)
        XCTAssertNil(Connections.renewAt(Credential(kind: .bearer, token: "a", expiresAt: now.addingTimeInterval(30)), now: now))
    }

    func testAnAccountSessionKeepsRenewingWhileConnected() async throws {
        let (entry, connections, mint) = accountServer()
        connections.stateChanged(entry.serverId, ConnectionState(phase: .connected))
        _ = try await connections.renew(entry)
        for _ in 0..<40 where mint.count < 3 { try await Task.sleep(for: .milliseconds(100)) }
        connections.stateChanged(entry.serverId, ConnectionState(phase: .offline))
        XCTAssertGreaterThanOrEqual(mint.count, 3, "renewed once, then never again")
        XCTAssertEqual(ServerRegistry.credential(entry.serverId, route: entry.routes[0])?.token.hasPrefix("s"), true)
        XCTAssertNotEqual(ServerRegistry.credential(entry.serverId, route: entry.routes[0])?.token, "s1")
    }

    func testARefusedAccountSessionIsMintedAgain() async throws {
        let (entry, connections, mint) = accountServer()
        mint.lifetime = 3600
        ServerRegistry.setCredential(entry.serverId, routeId: Route.accountId, Credential(kind: .dpop, token: "old", expiresAt: Date().addingTimeInterval(3600)))
        connections.refused(entry)
        for _ in 0..<20 where mint.count == 0 { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertEqual(mint.count, 1)
        XCTAssertEqual(ServerRegistry.credential(entry.serverId, route: entry.routes[0])?.token, "s1")
    }

    func testAnUploadStepRenewsASessionInItsLastMinute() async throws {
        let (entry, connections, mint) = accountServer()
        mint.lifetime = 3600
        ServerRegistry.setCredential(entry.serverId, routeId: Route.accountId, Credential(kind: .dpop, token: "ending", expiresAt: Date().addingTimeInterval(30)))
        let renewed = await connections.renewedIfEnding(API.connected(entry))
        XCTAssertEqual(renewed.credential?.token, "s1")
        let again = await connections.renewedIfEnding(renewed)
        XCTAssertEqual(again.credential?.token, "s1")
        XCTAssertEqual(mint.count, 1)
    }

    // MARK: busy

    func testABusyServerIsAskedAgainLaterNotSignedOut() async throws {
        // the server's own code is BUSY (contract.md); older answers said "busy"
        Sequenced.reset([(503, #"{"error":"This computer is busy. Try again in a minute.","code":"BUSY"}"#), (200, #"{"ok":true}"#)])
        var api = API(server: url("https://mac.example/"), cookie: nil)
        api.credential = Credential(kind: .dpop, token: "cts_d")
        let data = try await api.data(api.request("/api/library"), session: Sequenced.session)
        XCTAssertEqual(String(data: data, encoding: .utf8), #"{"ok":true}"#)
        XCTAssertEqual(Sequenced.proofs.count, 2)
        XCTAssertNotEqual(Sequenced.proofs[0], Sequenced.proofs[1], "each try its own proof")

        Sequenced.reset(Array(repeating: (503, #"{"error":"busy"}"#), count: 5))
        do {
            _ = try await api.data(api.request("/api/library"), session: Sequenced.session)
            XCTFail("a server busy every time answers in the end")
        } catch APIError.server(let status, _) {
            XCTAssertEqual(status, 503)
        }
        XCTAssertEqual(Sequenced.proofs.count, 4)
    }

    func testABusyTokenEndpointIsARetryNotARefusal() async throws {
        StubServer.reset()
        StubServer.answers["/oauth/token"] = (503, #"{"error":"temporarily_unavailable"}"#)
        do {
            _ = try await Pairing.exchange(url("https://mac.example/"), credential: "x", dpop: true, metadata: [:], session: StubServer.session)
            XCTFail("a 503 made a session")
        } catch let failure as ConnectionFailure {
            XCTAssertFalse(failure.blocked)
            XCTAssertEqual(failure.httpStatus, 503)
        }
    }

    // MARK: redirects

    func testARedirectToAnotherHostTakesNoSignIn() async throws {
        let session = API.making({
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [Redirecting.self]
            return config
        }())
        var request = URLRequest(url: url("https://mac.example/api/media/1"))
        for name in SameHostRedirects.signIn { request.setValue("secret", forHTTPHeaderField: name) }
        Redirecting.seen = [:]
        _ = try await session.data(for: request)
        let bucket = try XCTUnwrap(Redirecting.seen["bucket.example"])
        for name in SameHostRedirects.signIn { XCTAssertNil(bucket[name], name) }
        // the same host keeps them
        request.url = url("https://mac.example/api/move")
        _ = try await session.data(for: request)
        let same = try XCTUnwrap(Redirecting.seen["mac.example/api/moved"])
        for name in SameHostRedirects.signIn { XCTAssertEqual(same[name], "secret", name) }
        // the app's own sessions strip them
        XCTAssertTrue(API.session.delegate is SameHostRedirects)
        XCTAssertTrue(API.slow.delegate is SameHostRedirects)
    }

    // MARK: the saved list

    func testARegistryThisBuildCantReadIsNeverReplacedByTheOldList() throws {
        let (registry, old) = (Keychain.get(ServerRegistry.account), Keychain.get(SavedServers.account))
        defer {
            Keychain.set(ServerRegistry.account, registry)
            Keychain.set(SavedServers.account, old)
        }
        let list = SavedServers(list: [Server(url: url("https://studio.example.test/"), username: "sam")], currentId: nil)
        Keychain.set(SavedServers.account, String(data: try JSONEncoder().encode(list), encoding: .utf8))
        Keychain.set(ServerRegistry.account, #"{"servers":"from a newer build"}"#)
        XCTAssertEqual(ServerRegistry.read(), ServerRegistry.Saved())
        XCTAssertEqual(Keychain.get(ServerRegistry.account), #"{"servers":"from a newer build"}"#)

        // no registry yet: the old list moves in, and is gone after
        Keychain.set(ServerRegistry.account, nil)
        let moved = ServerRegistry.read()
        defer { moved.servers.forEach(ServerRegistry.forgetCredentials) }
        XCTAssertEqual(moved.servers.map(\.key), ["https://studio.example.test/"])
        XCTAssertNil(SavedServers.read())
        XCTAssertNotNil(Keychain.get(ServerRegistry.account))
    }

    // MARK: background refresh

    func testABackgroundRefreshIsReportedDoneOnceEvenWhenItsTimeRunsOut() async throws {
        var reports: [Bool] = []
        let expire = BackgroundRefresh.run(done: { reports.append($0) }) { try? await Task.sleep(for: .seconds(5)) }
        expire()
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(reports, [false])

        var finished: [Bool] = []
        let late = BackgroundRefresh.run(done: { finished.append($0) }) {}
        try await Task.sleep(for: .milliseconds(100))
        late()
        XCTAssertEqual(finished, [true])
    }
}

/// Answers in turn, and keeps each request's DPoP proof.
final class Sequenced: URLProtocol {
    nonisolated(unsafe) static var answers: [(Int, String)] = []
    nonisolated(unsafe) static var proofs: [String] = []

    static func reset(_ next: [(Int, String)]) {
        answers = next
        proofs = []
    }

    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [Sequenced.self]
        return URLSession(configuration: config)
    }()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.proofs.append(request.value(forHTTPHeaderField: "DPoP") ?? "")
        let (status, body) = Self.answers.isEmpty ? (404, "{}") : Self.answers.removeFirst()
        let headers = ["Content-Type": "application/json", "Retry-After": "0"]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: headers)!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

/// `/api/media/1` redirects to a bucket on another host, `/api/move` to `/api/moved` on the same one; what reaches the
/// end is kept by host (and path for the same host).
final class Redirecting: URLProtocol {
    nonisolated(unsafe) static var seen: [String: [String: String]] = [:]

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let url = request.url!
        let target: String? = switch url.path {
        case "/api/media/1": "https://bucket.example/object"
        case "/api/move": "https://mac.example/api/moved"
        default: nil
        }
        if let target {
            var next = request
            next.url = URL(string: target)
            let response = HTTPURLResponse(url: url, statusCode: 302, httpVersion: nil, headerFields: ["Location": target])!
            client?.urlProtocol(self, wasRedirectedTo: next, redirectResponse: response)
            return
        }
        let key = url.host() == "mac.example" ? "mac.example" + url.path : url.host() ?? ""
        Self.seen[key] = request.allHTTPHeaderFields ?? [:]
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data())
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
