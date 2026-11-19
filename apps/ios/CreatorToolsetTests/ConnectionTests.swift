import CryptoKit
import XCTest
@testable import CreatorToolset

/// Routes, the supervisor's timing, pairing, DPoP proofs, the move from the old saved list, and request signing.
/// Addresses are documentation and private ranges, never a real machine's.
final class ConnectionTests: XCTestCase {
    private func url(_ s: String) -> URL { URL(string: s)! }
    private func paired(_ s: String) -> Route { .paired(url(s)) }

    // MARK: routes

    func testKindAndLabelFromTheHost() {
        XCTAssertEqual(paired("http://localhost:43190/").kind, .thisDevice)
        XCTAssertEqual(paired("http://127.0.0.1:43190/").kind, .thisDevice)
        XCTAssertEqual(paired("http://10.0.0.20:43190/").kind, .lan)
        XCTAssertEqual(paired("http://10.0.0.4/").kind, .lan)
        XCTAssertEqual(paired("http://studio.local:43190/").kind, .lan)
        XCTAssertEqual(paired("http://[fd7a:115c:a1e0::5]:43190/").kind, .tailnet)
        XCTAssertEqual(paired("http://100.101.102.103:43190/").kind, .vpn)
        var tailnet = paired("http://100.101.102.103:43190/")
        tailnet.network = "tailnet"
        XCTAssertEqual(tailnet.kind, .tailnet)
        XCTAssertEqual(paired("https://studio.example.com/").kind, .publicHost)
        XCTAssertEqual(paired("https://studio.example.com/").label, "studio.example.com")
        XCTAssertEqual(Route.account(url("https://abc.connect.example/")).kind, .account)
        XCTAssertEqual(Route.account(url("https://abc.connect.example/")).label, "Account")
        XCTAssertEqual([RouteKind.thisDevice, .lan, .tailnet, .vpn, .publicHost, .account].map(\.rank), [0, 1, 2, 2, 3, 5])
    }

    func testANewRouteGoesByRank() {
        let account = Route.account(url("https://abc.connect.example/"))
        let lan = paired("http://10.0.0.20:43190/")
        let routes = Routes.insert([account], lan)
        XCTAssertEqual(routes.map(\.id), [lan.id, account.id])
        let ts = paired("http://[fd7a:115c:a1e0::5]:43190/")
        XCTAssertEqual(Routes.insert(routes, ts).map(\.id), [lan.id, ts.id, account.id])
        // a new address of a kind goes first among its kind, so its fresh credential connects
        let lan2 = paired("http://10.0.0.21:43190/")
        XCTAssertEqual(Routes.upsert(routes, lan2).map(\.id), [lan2.id, lan.id, account.id])
        // the same route is replaced in place
        XCTAssertEqual(Routes.upsert(routes, lan).map(\.id), [lan.id, account.id])
    }

    func testAPairedTokenNeverGoesOverPlainHTTPItWasNotPairedOver() {
        let https = paired("https://studio.example.com/")
        let learnedLan = Route(id: "learned:http://10.0.0.20:43190@\(https.id)", url: url("http://10.0.0.20:43190/"), learned: true)
        XCTAssertTrue(Routes.sendsTokenInClear([https, learnedLan], learnedLan))
        XCTAssertEqual(Routes.usable([https, learnedLan]).map(\.id), [https.id])
        // paired over plain http on the LAN: its token may go to another plain http address
        let lan = paired("http://10.0.0.20:43190/")
        let learned2 = Route(id: "learned:http://10.0.0.30:43190@\(lan.id)", url: url("http://10.0.0.30:43190/"), learned: true)
        XCTAssertFalse(Routes.sendsTokenInClear([lan, learned2], learned2))
        // a tailnet address is encrypted on the wire
        var ts = learnedLan
        ts.network = "tailnet"
        XCTAssertFalse(Routes.sendsTokenInClear([https, ts], ts))
        // an account session is bound to this phone's key
        let viaAccount = Route(id: "learned:http://10.0.0.20:43190", url: url("http://10.0.0.20:43190/"), learned: true, authorization: .account)
        XCTAssertFalse(Routes.sendsTokenInClear([viaAccount], viaAccount))
        XCTAssertEqual(Routes.credentialId(learnedLan.id), https.id)
        XCTAssertEqual(Routes.credentialId(https.id), https.id)
    }

    func testLearnedRoutesMerge() throws {
        let account = Route.account(url("https://abc.connect.example/"))
        let reported = [ReportedEndpoint(kind: "lan", httpBaseUrl: "http://10.0.0.20:43190"),
                        ReportedEndpoint(kind: "tailnet", httpBaseUrl: "http://100.101.102.103:43190"),
                        ReportedEndpoint(kind: "lan", httpBaseUrl: "http://127.0.0.1:43190")]
        let merged = try XCTUnwrap(Routes.mergeLearned([account], active: account, reported: reported))
        // loopback is never learned; the LAN goes first, tailnet next, the account last
        XCTAssertEqual(merged.map(\.kind), [.lan, .tailnet, .account])
        XCTAssertTrue(merged[0].learned && merged[0].authorization == .account)
        XCTAssertEqual(merged[1].network, "tailnet")
        // the same report again changes nothing
        XCTAssertNil(Routes.mergeLearned(merged, active: account, reported: reported))
        // an address no longer reported goes (a new DHCP address follows the server)
        let moved = try XCTUnwrap(Routes.mergeLearned(merged, active: account, reported: [ReportedEndpoint(kind: "lan", httpBaseUrl: "http://10.0.0.44:43190")]))
        XCTAssertEqual(moved.map(\.url.absoluteString), ["http://10.0.0.44:43190/", "https://abc.connect.example/"])
        // removing the account route takes what was learned through it
        XCTAssertTrue(Routes.removing(merged, Route.accountId).isEmpty)

        // over a token paired on https, a plain LAN address is not learned; the tailnet one is
        let https = paired("https://studio.example.com/")
        let fromPaired = try XCTUnwrap(Routes.mergeLearned([https], active: https, reported: reported))
        XCTAssertEqual(fromPaired.map(\.kind), [.tailnet, .publicHost])
        XCTAssertTrue(fromPaired[0].id.hasSuffix("@" + https.id))
        // a saved route is never touched, only marked tailnet when the server says so
        let saved = paired("http://100.101.102.103:43190/")
        let marked = try XCTUnwrap(Routes.mergeLearned([saved], active: saved, reported: [reported[1]]))
        XCTAssertEqual(marked.map(\.id), [saved.id])
        XCTAssertEqual(marked[0].kind, .tailnet)
        // removing the paired route removes the routes that borrow its token
        XCTAssertEqual(Routes.removing(fromPaired, https.id), [])
    }

    // MARK: supervisor timing

    func testTheRetryLadder() {
        XCTAssertEqual(SupervisorCore.retryDelay(failureCount: 0, random: 0), 1)
        XCTAssertEqual(SupervisorCore.retryDelay(failureCount: 0, random: 1), 2)
        XCTAssertEqual(SupervisorCore.retryDelay(failureCount: 3, random: 1), 16)
        XCTAssertEqual(SupervisorCore.retryDelay(failureCount: 20, random: 0), 150)
        XCTAssertEqual(SupervisorCore.retryDelay(failureCount: 20, random: 1), 300)

        let network = ConnectionFailure(reason: .network, detail: "no route")
        var core = SupervisorCore()
        XCTAssertEqual(core.failed(network, connectedFor: nil, offline: false, random: 1), .retry(after: 2))
        XCTAssertEqual(core.failed(network, connectedFor: nil, offline: false, random: 1), .retry(after: 4))
        XCTAssertEqual(core.failed(network, connectedFor: nil, offline: false, random: 1), .retry(after: 8))
        // a line that was up 30 s starts again; its first loss retries after 125–250 ms
        XCTAssertEqual(core.failed(network, connectedFor: 30, offline: false, random: 1), .retry(after: 0.25))
        XCTAssertEqual(core.failed(network, connectedFor: nil, offline: false, random: 0), .retry(after: 2))
        // up only 10 s: the ladder goes on
        XCTAssertEqual(core.failed(network, connectedFor: 10, offline: false, random: 1), .retry(after: 8))
        // blocked and offline wait for a wakeup
        XCTAssertEqual(core.failed(ConnectionFailure(reason: .authentication, detail: "x"), connectedFor: nil, offline: false, random: 0), .wait)
        XCTAssertEqual(core.failed(network, connectedFor: nil, offline: true, random: 0), .wait)
        core.resetLadder()
        XCTAssertEqual(core.failed(network, connectedFor: nil, offline: false, random: 0), .retry(after: 1))
    }

    func testProbeTimeouts() {
        XCTAssertEqual(SupervisorCore.probeTimeout(.lan, longResume: false), 3)
        XCTAssertEqual(SupervisorCore.probeTimeout(.thisDevice, longResume: false), 3)
        XCTAssertEqual(SupervisorCore.probeTimeout(.account, longResume: false), 15)
        XCTAssertEqual(SupervisorCore.probeTimeout(.tailnet, longResume: false), 15)
        XCTAssertEqual(SupervisorCore.probeTimeout(.account, longResume: true), 1.5)
    }

    func testBetterRoutesAreHeldBackAndDeadOnesCheckedLessOften() {
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        let lan = paired("http://10.0.0.20:43190/")
        let ts = paired("http://[fd7a:115c:a1e0::5]:43190/")
        let account = Route.account(url("https://abc.connect.example/"))
        let routes = [lan, ts, account]
        var health = RouteHealth()
        XCTAssertEqual(health.candidates(routes, before: 2, now: t0).map(\.id), [lan.id, ts.id])
        XCTAssertEqual(health.candidates(routes, before: 0, now: t0), [])
        // answered but failed to connect: not tried again for 5 min
        health.coolDown(lan.id, now: t0)
        XCTAssertEqual(health.candidates(routes, before: 2, now: t0.addingTimeInterval(299)).map(\.id), [ts.id])
        XCTAssertEqual(health.candidates(routes, before: 2, now: t0.addingTimeInterval(300)).map(\.id), [lan.id, ts.id])
        // silent: 2 min, 4, 8, 16, then 30 at most
        var waits: [TimeInterval] = []
        for _ in 0..<6 {
            health.record(ts.id, .silent, now: t0)
            waits.append(health.silent[ts.id]!.until.timeIntervalSince(t0))
        }
        XCTAssertEqual(waits, [120, 240, 480, 960, 1800, 1800])
        health.record(ts.id, .ready, now: t0)
        XCTAssertNil(health.silent[ts.id])
        health.record(ts.id, .silent, now: t0)
        health.forgetSilent()
        XCTAssertTrue(health.silent.isEmpty)
    }

    func testTheHeaderWaits800ms() {
        let mac = ServerEntry(serverId: "m", label: "Sam's Mac", routes: [paired("http://10.0.0.20:43190/")], home: url("http://10.0.0.20:43190/"))
        let t0 = Date(timeIntervalSince1970: 1_000_000)
        let states = ["m": ConnectionState(phase: .backoff, attempt: 2, since: t0)]
        XCTAssertNil(ConnectionWords.header([mac], states: states, offline: false, now: t0.addingTimeInterval(0.5)))
        XCTAssertEqual(ConnectionWords.header([mac], states: states, offline: false, now: t0.addingTimeInterval(0.81)), "Reconnecting to Sam's Mac")
        XCTAssertEqual(ConnectionWords.header([mac], states: [:], offline: true), "You are offline")
        XCTAssertNil(ConnectionWords.header([mac], states: ["m": ConnectionState(phase: .connected, since: t0)], offline: false, now: t0.addingTimeInterval(5)))
        XCTAssertEqual(ConnectionWords.text(ConnectionState(phase: .backoff, lastFailure: ConnectionFailure(reason: .timeout, detail: "Late."))),
                       "Failed to connect. Reconnecting… Reason: Late.")
    }

    // MARK: diagnosis

    func testDiagnosisNamesTheHopThatFailed() throws {
        let tunnel = ConnectionState(phase: .backoff, attempt: 3,
                                     lastFailure: ConnectionFailure(reason: .remoteUnavailable, detail: "down", hop: .tunnel, via: .account, cause: "tunnel_down", traceId: "t1"))
        let d = try XCTUnwrap(ConnectionDiagnosis.make(.init(host: "Sam's Mac", state: tunnel, via: .account)))
        XCTAssertEqual(d.headline, "Sam's Mac's tunnel is offline")
        XCTAssertEqual(d.hops.map(\.label), ["This device", "Account", "Sam's Mac tunnel", "Creator Toolset on Sam's Mac"])
        XCTAssertEqual(d.hops.map(\.result), [.ok, .ok, .failed, .unchecked])
        XCTAssertEqual(d.facts.first { $0.0 == "Trace ID" }?.1, "t1")
        XCTAssertTrue(d.steps[0].contains("awake"))
        // a direct route that timed out names no hop: guessed, so nothing before it is called OK
        let direct = ConnectionState(phase: .backoff, attempt: 1, lastFailure: ConnectionFailure(reason: .timeout, detail: "late"))
        let g = try XCTUnwrap(ConnectionDiagnosis.make(.init(host: "Edit box", state: direct, via: .direct)))
        XCTAssertEqual(g.hops.map(\.result), [.unchecked, .failed])
        XCTAssertNil(ConnectionDiagnosis.make(.init(host: "x", state: ConnectionState(phase: .connected), via: .direct)))
    }

    // MARK: pairing

    func testPairingLinksAndTypedAddresses() {
        XCTAssertEqual(PairingTarget.parse("http://[fd7a:115c:a1e0::5]:43190/#token=abcdefghjklm"),
                       PairingTarget(origin: url("http://[fd7a:115c:a1e0::5]:43190/"), code: "ABCDEFGHJKLM"))
        XCTAssertEqual(PairingTarget.parse("http://10.0.0.20:43190/?token=ABC")?.code, "ABC")
        XCTAssertEqual(PairingTarget.parse("creatortoolset://pair?url=https%3A%2F%2Fstudio.example.com%2F%23token%3DXYZ"),
                       PairingTarget(origin: url("https://studio.example.com/"), code: "XYZ"))
        XCTAssertEqual(PairingTarget.parse("10.0.0.20:43190", code: " abc ")?.origin, url("http://10.0.0.20:43190/"))
        XCTAssertEqual(PairingTarget.parse("10.0.0.20:43190", code: " abc ")?.code, "ABC")
        XCTAssertEqual(PairingTarget.parse("studio.local:43190")?.origin, url("http://studio.local:43190/"))
        XCTAssertEqual(PairingTarget.parse("studio.example.com")?.origin, url("https://studio.example.com/"))
        XCTAssertNil(PairingTarget.parse("studio.example.com")?.code)
        XCTAssertNil(PairingTarget.parse("not an address"))
        XCTAssertNil(PairingTarget.parse("ftp://x.example/"))
        XCTAssertNil(PairingTarget.parse(""))
    }

    func testChecksBeforeTheCodeIsSpent() throws {
        let saved = [ServerEntry(serverId: "mac-1", label: "Sam's Mac", routes: [paired("http://10.0.0.20:43190/")], home: url("http://10.0.0.20:43190/")),
                     ServerEntry(serverId: "url:http://10.0.0.40:43190", label: "Old", routes: [paired("http://10.0.0.40:43190/")], home: url("http://10.0.0.40:43190/"))]
        let other = ServerDescriptor(serverId: "mac-2", label: "Office Mac")
        XCTAssertThrowsError(try Pairing.check(other, expected: "mac-1", saved: saved)) {
            XCTAssertEqual($0 as? PairingError, .differentServer("Office Mac"))
            XCTAssertEqual($0.localizedDescription, "That address reaches Office Mac, a different computer. Add it as its own computer instead.")
        }
        XCTAssertThrowsError(try Pairing.check(ServerDescriptor(serverId: "mac-1", label: "Sam's Mac"), expected: nil, saved: saved)) {
            XCTAssertEqual($0 as? PairingError, .alreadySaved("Sam's Mac"))
        }
        XCTAssertThrowsError(try Pairing.check(ServerDescriptor(serverId: "new", label: "New", protocolVersion: 2), expected: nil, saved: saved)) {
            XCTAssertEqual($0 as? PairingError, .unsupported)
        }
        // an older server is still saved, to be updated from the phone
        XCTAssertTrue(try Pairing.check(ServerDescriptor(serverId: "new", label: "New", protocolVersion: 0), expected: nil, saved: saved).updateRequired)
        XCTAssertFalse(try Pairing.check(ServerDescriptor(serverId: "mac-1", label: "Sam's Mac"), expected: "mac-1", saved: saved).updateRequired)
        // a server saved by address before ids existed takes its id from the first answer
        XCTAssertEqual(try Pairing.check(other, expected: "url:http://10.0.0.40:43190", saved: saved).provisional?.label, "Old")
    }

    /// The address answers as another computer: the token exchange is never asked, so the code stays good.
    @MainActor func testAWrongComputerKeepsTheCode() async throws {
        StubServer.reset()
        StubServer.answers["/.well-known/creator-toolset/server"] = (200, #"{"serverId":"mac-2","label":"Office Mac","platform":"mac","version":"0.15.63","protocol":1,"capabilities":{}}"#)
        StubServer.answers["/oauth/token"] = (200, #"{"access_token":"cts_x","token_type":"Bearer","expires_in":2592000,"scope":"read write access"}"#)
        let connections = Connections(saved: ServerRegistry.Saved(servers: [
            ServerEntry(serverId: "mac-1", label: "Sam's Mac", routes: [paired("http://10.0.0.20:43190/")], home: url("http://10.0.0.20:43190/"))]), live: false)
        let target = try XCTUnwrap(PairingTarget.parse("http://10.0.0.21:43190/#token=ABCDEFGHJKLM"))
        do {
            try await Pairing.pair(target, expected: "mac-1", connections: connections, session: StubServer.session)
            XCTFail("paired with the wrong computer")
        } catch {
            XCTAssertEqual(error as? PairingError, .differentServer("Office Mac"))
        }
        XCTAssertEqual(StubServer.asked, ["/.well-known/creator-toolset/server"])

        // the right one: the code is exchanged with the phone's name, and the route is saved with its token
        StubServer.reset()
        StubServer.answers["/.well-known/creator-toolset/server"] = (200, #"{"serverId":"mac-1","label":"Sam's Mac","protocol":1}"#)
        StubServer.answers["/oauth/token"] = (200, #"{"access_token":"cts_x","token_type":"Bearer","expires_in":2592000,"scope":"read write access"}"#)
        StubServer.answers["/api/auth/session"] = (200, #"{"authenticated":true,"scopes":["read","write","access"],"user":{"username":"sam"}}"#)
        try await Pairing.pair(target, expected: "mac-1", connections: connections, session: StubServer.session)
        defer { ServerRegistry.forgetCredentials(connections.entry("mac-1")!) }
        XCTAssertEqual(StubServer.asked, ["/.well-known/creator-toolset/server", "/oauth/token", "/api/auth/session"])
        let form = try XCTUnwrap(StubServer.bodies["/oauth/token"])
        XCTAssertTrue(form.contains("subject_token=ABCDEFGHJKLM"))
        XCTAssertTrue(form.contains("subject_token_type=urn%3Acreatortoolset%3Aparams%3Aoauth%3Atoken-type%3Aserver-bootstrap"))
        XCTAssertTrue(form.contains("client_device_type=mobile") || form.contains("client_device_type=tablet"))
        XCTAssertTrue(form.contains("client_os=iOS%20"))
        let entry = try XCTUnwrap(connections.entry("mac-1"))
        XCTAssertEqual(entry.routes.map(\.url.absoluteString), ["http://10.0.0.21:43190/", "http://10.0.0.20:43190/"])
        XCTAssertEqual(ServerRegistry.credential("mac-1", route: entry.routes[0]), Credential(kind: .bearer, token: "cts_x",
            expiresAt: ServerRegistry.credential("mac-1", route: entry.routes[0])?.expiresAt, scopes: ["read", "write", "access"]))
    }

    // MARK: DPoP

    func testAProofIsAnES256JWTForOneRequest() throws {
        let key = DPoPKey.software(P256.Signing.PrivateKey())
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let proof = try DPoP.proof(method: "post", url: url("http://[FD7A:115C:A1E0::5]:43190/api/x?y=1#z"), accessToken: "tok", key: key, now: now, jti: "j1")
        let parts = proof.split(separator: ".").map(String.init)
        XCTAssertEqual(parts.count, 3)
        let header = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(DPoP.unb64(parts[0]))) as? [String: Any])
        XCTAssertEqual(header["typ"] as? String, "dpop+jwt")
        XCTAssertEqual(header["alg"] as? String, "ES256")
        XCTAssertEqual(header["jwk"] as? [String: String], key.jwk)
        XCTAssertNil((header["jwk"] as? [String: String])?["d"])
        let claims = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(DPoP.unb64(parts[1]))) as? [String: Any])
        XCTAssertEqual(claims["htm"] as? String, "POST")
        XCTAssertEqual(claims["htu"] as? String, "http://[fd7a:115c:a1e0::5]:43190/api/x")
        XCTAssertEqual(claims["iat"] as? Int, 1_800_000_000)
        XCTAssertEqual(claims["jti"] as? String, "j1")
        XCTAssertEqual(claims["ath"] as? String, DPoP.b64(Data(SHA256.hash(data: Data("tok".utf8)))))
        let signature = try P256.Signing.ECDSASignature(rawRepresentation: XCTUnwrap(DPoP.unb64(parts[2])))
        XCTAssertTrue(key.publicKey.isValidSignature(signature, for: Data((parts[0] + "." + parts[1]).utf8)))
        // two proofs never share a jti
        XCTAssertNotEqual(try DPoP.proof(method: "GET", url: url("https://a.example/"), key: key), try DPoP.proof(method: "GET", url: url("https://a.example/"), key: key))
    }

    func testTheThumbprintFollowsRFC7638() {
        let key = DPoPKey.software(P256.Signing.PrivateKey())
        let raw = key.publicKey.rawRepresentation
        let canonical = "{\"crv\":\"P-256\",\"kty\":\"EC\",\"x\":\"\(DPoP.b64(raw.prefix(32)))\",\"y\":\"\(DPoP.b64(raw.suffix(32)))\"}"
        XCTAssertEqual(key.thumbprint, DPoP.b64(Data(SHA256.hash(data: Data(canonical.utf8)))))
        XCTAssertEqual(key.thumbprint.count, 43)
    }

    // MARK: request signing

    func testRequestsSendAuthorizationFromTheRouteInUse() throws {
        var bearer = API(server: url("http://10.0.0.20:43190/"), cookie: nil)
        bearer.credential = Credential(kind: .bearer, token: "cts_1")
        let r1 = bearer.request("/api/x?y=1", method: "POST", json: ["a": 1])
        XCTAssertEqual(r1.value(forHTTPHeaderField: "Authorization"), "Bearer cts_1")
        XCTAssertNil(r1.value(forHTTPHeaderField: "Cookie"))
        XCTAssertNil(r1.value(forHTTPHeaderField: "DPoP"))

        var dpop = API(server: url("https://abc.connect.example/"), cookie: nil)
        dpop.credential = Credential(kind: .dpop, token: "cts_2")
        let r2 = dpop.request("/api/library?page=2", method: "DELETE")
        XCTAssertEqual(r2.value(forHTTPHeaderField: "Authorization"), "DPoP cts_2")
        let proof = try XCTUnwrap(r2.value(forHTTPHeaderField: "DPoP"))
        let claims = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(DPoP.unb64(String(proof.split(separator: ".")[1])))) as? [String: Any])
        XCTAssertEqual(claims["htm"] as? String, "DELETE")
        XCTAssertEqual(claims["htu"] as? String, "https://abc.connect.example/api/library")
        XCTAssertNotNil(claims["ath"])

        // a server saved before pairing keeps its cookie until it is turned away
        let cookie = API(server: url("https://studio.example.com/"), cookie: "c1")
        XCTAssertEqual(cookie.request("/api/x").value(forHTTPHeaderField: "Cookie"), "cap_auth=c1")
        XCTAssertNil(cookie.request("/api/x").value(forHTTPHeaderField: "Authorization"))
    }

    func testTheClientUsesTheRouteLastConnectedOver() {
        let lan = paired("http://10.0.0.20:43190/")
        let https = paired("https://studio.example.com/")
        var entry = ServerEntry(serverId: "test-signing-\(UUID().uuidString)", label: "S", routes: [lan, https], username: "sam", home: https.url)
        ServerRegistry.setCredential(entry.serverId, routeId: lan.id, Credential(kind: .bearer, token: "lan-token"))
        ServerRegistry.setCredential(entry.serverId, routeId: https.id, Credential(kind: .cookie, token: "old-cookie"))
        defer { ServerRegistry.forgetCredentials(entry) }
        var api = API.connected(entry)
        XCTAssertEqual(api.server, lan.url)
        XCTAssertEqual(api.credential?.token, "lan-token")
        XCTAssertEqual(api.key, https.url.absoluteString)
        entry.activeRouteId = https.id
        api = API.connected(entry)
        XCTAssertEqual(api.server, https.url)
        XCTAssertEqual(api.cookie, "old-cookie")
        XCTAssertNil(api.credential)
    }

    // MARK: migration

    func testServersSavedByAddressMoveToTheRegistry() throws {
        let before = Keychain.get(ServerRegistry.account)
        defer { Keychain.set(ServerRegistry.account, before) }
        let a = Server(url: url("http://10.0.0.20:43190/"), username: "sam", label: "Sam's Mac")
        let b = Server(url: url("https://studio.example.com/"), username: "jo")
        XCTAssertTrue(Keychain.set(a.id, "cookie-a"))
        defer { Keychain.set(a.id, nil) }
        let saved = ServerRegistry.migrate(from: SavedServers(list: [a, b], currentId: b.id))
        defer { saved.servers.forEach(ServerRegistry.forgetCredentials) }
        XCTAssertEqual(saved.servers.map(\.serverId), ["url:http://10.0.0.20:43190", "url:https://studio.example.com"])
        XCTAssertTrue(saved.servers.allSatisfy(\.provisional))
        XCTAssertEqual(saved.servers.map(\.label), ["Sam's Mac", "studio.example.com"])
        XCTAssertEqual(saved.servers.map(\.key), [a.id, b.id])
        XCTAssertEqual(saved.current?.key, b.id)
        XCTAssertEqual(saved.servers[0].routes, [Route.paired(a.url)])
        XCTAssertEqual(ServerRegistry.credential(saved.servers[0].serverId, route: saved.servers[0].routes[0]), Credential(kind: .cookie, token: "cookie-a"))
        XCTAssertNil(ServerRegistry.credential(saved.servers[1].serverId, route: saved.servers[1].routes[0]))
        // the cookie moved: the old item is gone, the registry is written
        XCTAssertNil(Keychain.get(a.id))
        XCTAssertEqual(ServerRegistry.read(), saved)
        // the id the server gives itself takes the credential along
        let moved = ServerRegistry.rekey(saved.servers[0], to: "mac-1")
        defer { ServerRegistry.forgetCredentials(moved) }
        XCTAssertEqual(ServerRegistry.credential("mac-1", route: moved.routes[0])?.token, "cookie-a")
        XCTAssertNil(ServerRegistry.credential(saved.servers[0].serverId, route: saved.servers[0].routes[0]))
        XCTAssertEqual(moved.key, a.id)
    }
}

/// Answers by path, and records what was asked.
final class StubServer: URLProtocol {
    nonisolated(unsafe) static var answers: [String: (Int, String)] = [:]
    nonisolated(unsafe) static var asked: [String] = []
    nonisolated(unsafe) static var bodies: [String: String] = [:]

    static func reset() {
        answers = [:]
        asked = []
        bodies = [:]
    }

    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubServer.self]
        return URLSession(configuration: config)
    }()

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let path = request.url?.path ?? ""
        Self.asked.append(path)
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let n = stream.read(&buffer, maxLength: buffer.count)
                if n <= 0 { break }
                data.append(buffer, count: n)
            }
            stream.close()
            Self.bodies[path] = String(data: data, encoding: .utf8)
        } else if let body = request.httpBody {
            Self.bodies[path] = String(data: body, encoding: .utf8)
        }
        let (status, body) = Self.answers[path] ?? (404, "{}")
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
