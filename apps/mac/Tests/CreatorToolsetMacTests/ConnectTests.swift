import Foundation
import XCTest
@testable import CreatorToolsetMac

final class ConnectTests: XCTestCase {
    private func computer(_ id: String, _ name: String, _ host: String, _ status: String = "healthy") -> BrokerComputer {
        BrokerComputer(id: id, name: name, hostname: host, status: status)
    }

    func testTheBrokerDefaultsToTheHostedOneAndNoneWhenEmptied() {
        XCTAssertEqual(connectBrokerURL(nil), defaultConnectBroker)
        XCTAssertNil(connectBrokerURL(""))
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

    func testTheTokenGoesInTheEnvironmentNeverInTheArguments() {
        XCTAssertFalse(tunnelArguments().contains { $0.contains("tok") })
        let env = tunnelEnvironment("secret-token", base: ["PATH": "/usr/bin", "HOME": "/Users/x", "APP_SECRET": "leak"])
        XCTAssertEqual(env["TUNNEL_TOKEN"], "secret-token")
        // only the basics come from the app's own environment, never the server's secret
        XCTAssertNil(env["APP_SECRET"])
        XCTAssertEqual(env["PATH"], "/usr/bin")
    }

    func testNoBundledCloudflaredMeansNoTunnel() {
        XCTAssertNil(cloudflaredBinary(server: nil))
        XCTAssertNil(cloudflaredBinary(server: FileManager.default.temporaryDirectory.appendingPathComponent("no-such-server-\(UUID().uuidString)")))
    }

    func testTheAccountSignInAcceptsGitHubFromThePage() {
        XCTAssertEqual(accountAsk("github" as Any, mainFrame: true), "github")
        XCTAssertNil(accountAsk("github" as Any, mainFrame: false))
        XCTAssertNil(accountAsk("microsoft" as Any, mainFrame: true))
    }
}
