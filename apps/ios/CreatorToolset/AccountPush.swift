import Foundation
import UIKit

/// What push needs from the account sign-in: the phone's account code (the connect service with this phone's own DPoP
/// key) gives it, and sets `AccountPush.relay` once at launch.
@MainActor
protocol AccountRelay: AnyObject {
    /// The phone is signed in to the account.
    var signedIn: Bool { get }
    /// One request to the connect service with the account's DPoP token and a fresh proof; the HTTP status it answered.
    func send(_ path: String, method: String, json: [String: Any]?) async throws -> Int
    /// The server id of each computer on the account.
    func computerIds() async throws -> Set<String>
    /// The server id of the server in use, when the phone knows it.
    var currentServerId: String? { get }
}

/// Notifications through the account: the phone hands its push token to the connect service, and the computers on the
/// account tell it when something starts to wait on the person (a title, one line and the page a tap opens). The phone's
/// own look in the background goes on for servers that are not on the account; for one that is, it posts nothing, so
/// nothing is told twice. A tap opens the page the push names (`AppNotifications`), on its server and workspace (the
/// push carries `server`, `serverId` and `workspace` beside `path`).
@MainActor
enum AccountPush {
    static weak var relay: AccountRelay?
    private static let defaults = UserDefaults.standard

    /// The computers on the account, as of the last registration: their pushes reach this phone. Kept on the phone, so
    /// a launch in the background still knows them and the phone's own look tells nothing twice.
    private(set) static var pushing: Set<String> {
        get { Set(defaults.stringArray(forKey: "push.pushing") ?? []) }
        set { defaults.set(newValue.sorted(), forKey: "push.pushing") }
    }

    static var signedIn: Bool { relay?.signedIn == true }

    /// The server in use pushes through the account: the phone's own look posts nothing for it.
    static var coversCurrent: Bool { covers(relay?.currentServerId, pushing: pushing) }

    nonisolated static func covers(_ serverId: String?, pushing: Set<String>) -> Bool {
        serverId.map(pushing.contains) ?? false
    }

    /// This install's id at the connect service: a reinstall is a new phone there, and its old token goes.
    static var deviceId: String {
        if let id = defaults.string(forKey: "push.deviceId") { return id }
        let id = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        defaults.set(id, forKey: "push.deviceId")
        return id
    }

    /// POST /v1/mobile/devices, as the connect service takes it (apps/relay/src/push.ts).
    nonisolated static func registration(deviceId: String, token: String, sandbox: Bool, bundleId: String) -> [String: Any] {
        ["deviceId": deviceId, "token": token, "sandbox": sandbox, "bundleId": bundleId]
    }

    /// iOS gave the phone its token (the studio plug-in's `Push` keeps it under the same name).
    static func took(_ data: Data) async {
        defaults.set(Push.hex(data), forKey: "push.token")
        await register()
    }

    /// The connect service keeps this phone's token for the account; then which computers push is known.
    static func register() async {
        guard let relay, relay.signedIn, let token = defaults.string(forKey: "push.token") else { return }
        #if DEBUG
        let sandbox = true
        #else
        let sandbox = false
        #endif
        let body = registration(deviceId: deviceId, token: token, sandbox: sandbox, bundleId: Bundle.main.bundleIdentifier ?? "")
        guard (try? await relay.send("/v1/mobile/devices", method: "POST", json: body)) == 200 else {
            pushing = []
            return
        }
        pushing = (try? await relay.computerIds()) ?? pushing
    }

    /// Before the account signs out: the connect service stops sending this phone anything.
    static func signingOut() async {
        pushing = []
        guard let relay, relay.signedIn else { return }
        _ = try? await relay.send("/v1/mobile/devices/\(deviceId)", method: "DELETE", json: nil)
    }
}
