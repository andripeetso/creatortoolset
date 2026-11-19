import Foundation
import XCTest
@testable import CreatorToolsetMac

final class ConnectTests: XCTestCase {
    private func computer(_ id: String, _ name: String, _ host: String, _ status: String = "healthy") -> BrokerComputer {
        BrokerComputer(id: id, name: name, hostname: host, status: status)
    }

    func testThereIsNoConnectServiceUntilOneIsSet() {
        // none until one is set: the menu item that needs it is hidden, and nothing calls a service that isn't there
        XCTAssertEqual(connectBrokerURL(nil), defaultConnectService)
        XCTAssertNil(connectBrokerURL(""))
        XCTAssertNil(connectBrokerURL("  "))
        XCTAssertEqual(connectBrokerURL("https://broker.example.com/"), URL(string: "https://broker.example.com"))
        // a plain http address is refused unless it is this machine
        XCTAssertNil(connectBrokerURL("http://broker.example.com"))
    }

    func testTheAccountsOtherComputersAreListedOnTheirTunnelHostnames() {
        let list = [
            computer("aaaa", "Studio Mac", "aaaa.tunnels.example.com"),
            computer("bbbb", "This Mac", "bbbb.tunnels.example.com"),
            computer("cccc", "Old Mac", "cccc.tunnels.example.com", "gone"),
            computer("dddd", "", "dddd.tunnels.example.com"),
        ]
        let servers = accountServers(list, thisComputer: "bbbb")
        XCTAssertEqual(servers, [
            ServerEntry(id: "computer-aaaa", name: "Studio Mac", url: "https://aaaa.tunnels.example.com"),
            ServerEntry(id: "computer-dddd", name: "dddd.tunnels.example.com", url: "https://dddd.tunnels.example.com"),
        ])
    }

    func testAHostnameThatIsNotPlainIsNeverListed() {
        XCTAssertFalse(isPlainHostname("evil.example.com/path"))
        XCTAssertFalse(isPlainHostname("Upper.example.com"))
        XCTAssertFalse(isPlainHostname("a b.example.com"))
        XCTAssertFalse(isPlainHostname(""))
        XCTAssertTrue(isPlainHostname("aaaa.tunnels.example.com"))
        let servers = accountServers([computer("aaaa", "X", "user@evil.example.com")], thisComputer: nil)
        XCTAssertEqual(servers, [])
    }

    func testTheTunnelNeedsALinkedComputerWithAToken() {
        let linked = Data(#"{"computerId":"bbbb","hostname":"bbbb.tunnels.example.com","tunnelToken":"tok","relayPublicKey":"x","owner":"o"}"#.utf8)
        XCTAssertEqual(tunnelConfig(data: linked)?.hostname, "bbbb.tunnels.example.com")
        // not linked, unreadable, or linked without a token: no tunnel
        XCTAssertNil(tunnelConfig(data: nil))
        XCTAssertNil(tunnelConfig(data: Data("not json".utf8)))
        XCTAssertNil(tunnelConfig(data: Data(#"{"computerId":"bbbb","hostname":"h","tunnelToken":""}"#.utf8)))
    }

    func testTheAccountSignInAcceptsGitHubFromThePage() {
        XCTAssertEqual(accountAsk("github" as Any, mainFrame: true), "github")
        XCTAssertNil(accountAsk("github" as Any, mainFrame: false))
        XCTAssertNil(accountAsk("microsoft" as Any, mainFrame: true))
    }

    func testReachFromAnywhereSaysWhereThisMacStands() {
        let up = computer("bbbb", "This Mac", "bbbb.tunnels.example.com")
        XCTAssertEqual(reachState(signedIn: false, on: true, removed: false, linked: true, listed: up), .signedOut)
        XCTAssertEqual(reachState(signedIn: true, on: false, removed: true, linked: false, listed: nil), .removed)
        XCTAssertEqual(reachState(signedIn: true, on: false, removed: false, linked: false, listed: nil), .off)
        XCTAssertEqual(reachState(signedIn: true, on: true, removed: false, linked: true, listed: up), .available)
        XCTAssertEqual(reachState(signedIn: true, on: true, removed: false, linked: true, listed: computer("bbbb", "M", "h", "degraded")), .available)
        // on, but not linked yet, its tunnel down, or the list did not come
        XCTAssertEqual(reachState(signedIn: true, on: true, removed: false, linked: false, listed: nil), .unreachable)
        XCTAssertEqual(reachState(signedIn: true, on: true, removed: false, linked: true, listed: computer("bbbb", "M", "h", "down")), .unreachable)
        XCTAssertEqual(reachState(signedIn: true, on: true, removed: false, linked: true, listed: nil), .unreachable)
        XCTAssertEqual(Reach.removed.text, "This Mac was removed from your account. Turn it on to add it again.")
        XCTAssertEqual(Reach.signedOut.rawValue, "signed-out")
    }

    func testOnlyAListThatCameAndLacksThisMacMeansTheAccountDroppedIt() {
        let list = [computer("aaaa", "Studio Mac", "aaaa.tunnels.example.com")]
        XCTAssertTrue(droppedFromAccount(linkedId: "bbbb", list: list))
        XCTAssertFalse(droppedFromAccount(linkedId: "aaaa", list: list))
        XCTAssertFalse(droppedFromAccount(linkedId: "bbbb", list: nil))   // the broker did not answer: nothing is concluded
        XCTAssertFalse(droppedFromAccount(linkedId: nil, list: list))     // not linked here
    }

    func testTheLinkPassesTheServersProofAsItIsAndHandsTheServerTheBrokersAnswer() async throws {
        let broker = FakeSite()
        broker.answer = { r in
            switch r.path {
            case "/v1/computers/link-challenges": return (200, #"{"challenge":"ch-1","expiresAt":"2026-11-18T12:00:00Z"}"#)
            case "/v1/computers/link": return (200, #"{"computerId":"bbbb","owner":"acct-1","hostname":"bbbb.tunnels.example.com","endpoint":"https://bbbb.tunnels.example.com","tunnelToken":"tok","brokerKey":"key","brokerKid":"k1","computer_id":"bbbb"}"#)
            default: return (404, "{}")
            }
        }
        let proof = Data(#"{"proof":"a.b.c","computerId":"bbbb","publicKey":"pk","origin":"http://127.0.0.1:43128","name":"Studio Mac"}"#.utf8)
        var local: [(String, [String: Any])] = []
        try await BrokerClient(base: broker.url).link(token: "relay-tok") { path, body in
            local.append((path, body))
            return path == "/api/connect/link-proof" ? proof : Data("{}".utf8)
        }
        XCTAssertEqual(broker.requests.map(\.path), ["/v1/computers/link-challenges", "/v1/computers/link"])
        XCTAssertTrue(broker.requests.allSatisfy { $0.headers.first { $0.key.lowercased() == "authorization" }?.value == "Bearer relay-tok" })
        XCTAssertEqual(broker.requests[1].body, proof)   // byte for byte: the server's signature covers it
        XCTAssertEqual(local.map(\.0), ["/api/connect/link-proof", "/api/connect/relay-config"])
        XCTAssertEqual(local[0].1["challenge"] as? String, "ch-1")
        XCTAssertEqual(local[0].1["relayUrl"] as? String, broker.url.absoluteString)
        // exactly what the server's relay-config takes: the broker's answer, less its older names, and the broker's address
        XCTAssertEqual(Set(local[1].1.keys), ["owner", "computerId", "hostname", "tunnelToken", "brokerKey", "brokerKid", "brokerUrl"])
        XCTAssertEqual(local[1].1["owner"] as? String, "acct-1")
        XCTAssertEqual(local[1].1["brokerUrl"] as? String, broker.url.absoluteString)
    }

    func testALinkTheBrokerRefusesNeverReachesTheServersConfig() async {
        let broker = FakeSite()
        broker.answer = { r in r.path == "/v1/computers/link-challenges" ? (403, #"{"error":"limit_reached"}"#) : (200, "{}") }
        var local: [String] = []
        do {
            try await BrokerClient(base: broker.url).link(token: "t") { path, _ in local.append(path); return Data("{}".utf8) }
            XCTFail("the link went through")
        } catch {
            XCTAssertEqual(error as? BrokerError, .status(403))
        }
        XCTAssertEqual(local, [])
    }

    func testUnlinkTakesTheMacOffTheAccountAndAlreadyGoneIsFine() async throws {
        let broker = FakeSite()
        broker.answer = { _ in (204, "") }
        try await BrokerClient(base: broker.url).unlink("bbbb", token: "t")
        XCTAssertEqual(broker.requests.first?.method, "DELETE")
        XCTAssertEqual(broker.requests.first?.path, "/v1/computers/bbbb")
        broker.answer = { _ in (404, #"{"error":"not_found"}"#) }
        try await BrokerClient(base: broker.url).unlink("bbbb", token: "t")
        broker.answer = { _ in (502, "{}") }
        do {
            try await BrokerClient(base: broker.url).unlink("bbbb", token: "t")
            XCTFail("a broker error was taken as unlinked")
        } catch {}
    }
}
