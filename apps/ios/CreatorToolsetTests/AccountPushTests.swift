import XCTest
@testable import CreatorToolset

/// Push through the account: the phone registers its token with the connect service (apps/relay/src/push.ts), the
/// server in use stops its own look once it pushes, and a tap on what the connect service sent opens its page.
@MainActor
final class AccountPushTests: XCTestCase {
    final class FakeRelay: AccountRelay {
        var signedIn = true
        var currentServerId: String?
        var status = 200
        var ids: Set<String> = []
        var calls: [(path: String, method: String, json: [String: Any]?)] = []

        func send(_ path: String, method: String, json: [String: Any]?) async throws -> Int {
            calls.append((path, method, json))
            return status
        }

        func computerIds() async throws -> Set<String> { ids }
    }

    private let mac = "0123456789abcdef0123456789abcdef"
    private var relay: FakeRelay!

    override func setUp() async throws {
        relay = FakeRelay()
        AccountPush.relay = relay
        UserDefaults.standard.set(String(repeating: "ab", count: 32), forKey: "push.token")
    }

    override func tearDown() async throws {
        await AccountPush.signingOut()
        AccountPush.relay = nil
        UserDefaults.standard.removeObject(forKey: "push.token")
    }

    func testRegistrationBodyIsWhatTheConnectServiceTakes() {
        let body = AccountPush.registration(deviceId: "D-1", token: "ab12", sandbox: true, bundleId: "com.example.toolset")
        XCTAssertEqual(body["deviceId"] as? String, "D-1")
        XCTAssertEqual(body["token"] as? String, "ab12")
        XCTAssertEqual(body["sandbox"] as? Bool, true)
        XCTAssertEqual(body["bundleId"] as? String, "com.example.toolset")
        XCTAssertEqual(Set(body.keys), ["deviceId", "token", "sandbox", "bundleId"])
    }

    func testRegisteringTurnsTheLookOffOnlyForComputersOnTheAccount() async {
        relay.ids = [mac]
        relay.currentServerId = mac
        await AccountPush.register()
        XCTAssertEqual(relay.calls.map(\.path), ["/v1/mobile/devices"])
        XCTAssertEqual(relay.calls.first?.method, "POST")
        XCTAssertEqual(relay.calls.first?.json?["token"] as? String, String(repeating: "ab", count: 32))
        XCTAssertEqual(relay.calls.first?.json?["deviceId"] as? String, AccountPush.deviceId)
        XCTAssertTrue(AccountPush.coversCurrent)
        // another server in use (one not on the account): the phone keeps looking itself
        relay.currentServerId = "fedcba9876543210fedcba9876543210"
        XCTAssertFalse(AccountPush.coversCurrent)
        relay.currentServerId = nil
        XCTAssertFalse(AccountPush.coversCurrent)
    }

    func testARefusedRegistrationKeepsTheLookOn() async {
        relay.ids = [mac]
        relay.currentServerId = mac
        relay.status = 401
        await AccountPush.register()
        XCTAssertFalse(AccountPush.coversCurrent)
    }

    func testNotSignedInNothingIsSent() async {
        relay.signedIn = false
        relay.ids = [mac]
        relay.currentServerId = mac
        await AccountPush.register()
        XCTAssertTrue(relay.calls.isEmpty)
        XCTAssertFalse(AccountPush.coversCurrent)
        XCTAssertFalse(AccountPush.signedIn)
    }

    func testSigningOutTellsTheConnectServiceToForgetThisPhone() async {
        relay.ids = [mac]
        relay.currentServerId = mac
        await AccountPush.register()
        await AccountPush.signingOut()
        XCTAssertEqual(relay.calls.last?.method, "DELETE")
        XCTAssertEqual(relay.calls.last?.path, "/v1/mobile/devices/\(AccountPush.deviceId)")
        XCTAssertFalse(AccountPush.coversCurrent)
    }

    /// What the connect service sends (push.ts `payload`): a tap opens its path; anything that is not a page of the app opens nothing.
    func testATapOpensThePageThePushNames() {
        let sent: [AnyHashable: Any] = [
            "aps": ["alert": ["title": "Gym day", "body": "Ready for review"]],
            "kind": "review", "path": "/editor/1b4e28ba-2fa1-11d2-883f-0016d3cca427",
            "serverId": mac, "server": "https://\(mac).tunnels.example", "workspace": "ws_1",
        ]
        XCTAssertEqual(AppNotifications.path(in: sent), "/editor/1b4e28ba-2fa1-11d2-883f-0016d3cca427")
        XCTAssertEqual(AppNotifications.path(in: ["path": "/review/r1"]), "/review/r1")
        XCTAssertNil(AppNotifications.path(in: ["path": "https://elsewhere.example/review/r1"]))
        XCTAssertNil(AppNotifications.path(in: ["serverId": mac]))
    }

    // MARK: wired to the connection code

    func testTheAccountsConnectServiceCallsAreTheRelay() {
        let real: AccountRelay = AccountServers.shared
        XCTAssertEqual(real.signedIn, Account.shared.profile != nil)
        XCTAssertEqual(real.currentServerId, Connections.shared.current?.serverId)
    }

    func testSignInRegistersAndSignOutUnregistersFirst() async {
        await AccountServers.shared.afterSignIn()
        XCTAssertEqual(relay.calls.first?.path, "/v1/mobile/devices")
        XCTAssertEqual(relay.calls.first?.method, "POST")
        relay.calls = []
        await Account.shared.signOutNow()
        XCTAssertEqual(relay.calls.map(\.method), ["DELETE"])
        XCTAssertEqual(relay.calls.first?.path, "/v1/mobile/devices/\(AccountPush.deviceId)")
    }

    func testATapFindsTheComputerByItsIdFirst() {
        let lan = URL(string: "http://10.0.0.20:43190/")!
        let tunnel = URL(string: "https://mac-1.connect.example/")!
        let mac = ServerEntry(serverId: self.mac, label: "Mac", routes: [.paired(lan), .account(tunnel)], home: lan)
        let other = ServerEntry(serverId: "other-id", label: "Other", routes: [.paired(URL(string: "https://other.example/")!)],
                                home: URL(string: "https://other.example/")!)
        // the push names the tunnel; the phone saved the Mac by its LAN address
        XCTAssertEqual(Workspaces.serverKey(serverId: self.mac, server: tunnel.absoluteString, in: [other, mac]), mac.key)
        // no id (the phone's own notification): by any of its addresses
        XCTAssertEqual(Workspaces.serverKey(serverId: nil, server: "https://mac-1.connect.example", in: [other, mac]), mac.key)
        XCTAssertEqual(Workspaces.serverKey(serverId: nil, server: other.key, in: [other, mac]), other.key)
        // an unknown id falls back to the address
        XCTAssertEqual(Workspaces.serverKey(serverId: "nope", server: other.key, in: [mac, other]), other.key)
    }
}
