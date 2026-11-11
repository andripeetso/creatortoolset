import Foundation

/// Tells the person when something starts waiting on them while the app is closed. The app already calls it at
/// launch and from background refresh; it does nothing until it is built (this whole file is then replaced).
@MainActor
final class AppNotifications {
    static let shared = AppNotifications()

    func start() {}
    func lookInBackground() async {}
}
