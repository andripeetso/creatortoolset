import Combine
import UIKit

/// Push from a server with the studio plug-in: the phone hands it its device token, and the server tells the phone
/// when something starts waiting (a cut that needs the go, a video to review, a failed job, an assistant reply). A
/// tap opens the path the push names (`AppNotifications`' delegate, `AppNavigator.open(href:)`).
///
/// While the server says it pushes (`notify.push`), the phone's own look in the background posts nothing, so nothing
/// is told twice. A server without push answers 404 (an older plug-in) or `push: false` (no Apple key on it yet).
@MainActor
enum Push {
    private static let defaults = UserDefaults.standard
    private static var bag = Set<AnyCancellable>()

    /// A device token as the server takes it: lower-case hex.
    nonisolated static func hex(_ token: Data) -> String {
        token.map { String(format: "%02x", $0) }.joined()
    }

    /// The phone's token, once iOS has given it.
    private static var token: String? { defaults.string(forKey: "push.token") }

    /// The servers that have this phone's token: only those are asked to forget it.
    private static var servers: Set<String> {
        get { Set(defaults.stringArray(forKey: "push.servers") ?? []) }
        set { defaults.set(Array(newValue), forKey: "push.servers") }
    }

    /// At launch: a server with the plug-in (known now, or once the list comes) gets the token. iOS hands it over
    /// again on every `registerForRemoteNotifications`, and Apple is only asked on such a server.
    static func start() {
        ServerPlugins.shared.$known.map { $0.plugins.contains(Studio.plugin) }.removeDuplicates()
            .filter { $0 }
            .sink { _ in UIApplication.shared.registerForRemoteNotifications() }
            .store(in: &bag)
    }

    /// Another server is in use: whether it pushes is not known until it has the token.
    static func serverChanged() {
        let id = API.current?.server.absoluteString
        // the app calls this on every launch too: only a real change forgets what the last server said
        guard defaults.string(forKey: "push.current") != id else { return }
        defaults.set(id, forKey: "push.current")
        defaults.set(false, forKey: "notify.push")
        Task { await register() }
    }

    /// iOS gave the phone its token.
    static func took(_ data: Data) async {
        defaults.set(hex(data), forKey: "push.token")
        await register()
    }

    /// The server in use keeps the token for the signed-in account, when it has the plug-in.
    static func register() async {
        guard ServerPlugins.shared.studio, let api = API.current, let token else { return }
        #if DEBUG
        let sandbox = true
        #else
        let sandbox = false
        #endif
        struct Answer: Decodable { var push: Bool? }
        guard let data = try? await api.send(Studio.path("/push/register"), json: ["token": token, "sandbox": sandbox])
        else { return }
        servers.insert(api.server.absoluteString)
        // still the server in use: it tells from now on, or the phone keeps looking itself
        if API.current?.server == api.server {
            defaults.set((try? JSONDecoder().decode(Answer.self, from: data))?.push == true, forKey: "notify.push")
        }
    }

    /// A server leaves the phone: it stops sending this phone anything.
    static func forget(on api: API) async {
        let id = api.server.absoluteString
        guard servers.contains(id) else { return }
        servers.remove(id)
        if let token { _ = try? await api.send(Studio.path("/push/register"), method: "DELETE", json: ["token": token]) }
    }
}
