import Combine
import SwiftUI
import UIKit
import UserNotifications

/// Tells the person when something starts to wait on them while the app is closed: a video to review, a job that
/// failed. The phone looks itself whenever iOS gives it a moment in the background, and posts a notification for what
/// is new. A server that sends its own push says so (`notify.push`, set where the push token is handed over), and the
/// phone then posts none of its own. The permission is asked once, the first time something happened while they
/// were away.
@MainActor
final class AppNotifications: NSObject, UNUserNotificationCenterDelegate {
    static let shared = AppNotifications()

    /// One thing to tell: whose it is, what happened, and the page a tap opens.
    struct Note: Equatable {
        var key: String
        var title: String
        var body: String
        var path: String
    }

    private let center = UNUserNotificationCenter.current()
    private let defaults = UserDefaults.standard
    private var bag = Set<AnyCancellable>()
    /// He left the app and has not seen the list since. Only while the app stays in memory: a
    /// fresh launch never asks for the permission.
    private var away = false
    /// A look in the background is under way: it tells what is new itself, before iOS takes the moment back.
    private var looking = false
    /// The names of everything that waited when he last saw the list, or was last told.
    private var shown: Set<String> {
        get { Set(defaults.stringArray(forKey: "notify.shown") ?? []) }
        set { defaults.set(Array(newValue), forKey: "notify.shown") }
    }

    // MARK: What is new (no iOS in it, so it can be tested)

    /// The page a notification opens (`path` in what the server sent, or what the phone put there
    /// itself), when it is a page of the app.
    nonisolated static func path(in userInfo: [AnyHashable: Any]) -> String? {
        guard let path = userInfo["path"] as? String, AppRoute.from(path: path) != nil else { return nil }
        return path
    }

    /// The rows that wait on him as things to tell. The assistant's own questions are left out:
    /// they last ten minutes, and a look in the background comes later than that.
    nonisolated static func notes(_ rows: [ChatRow]) -> [Note] {
        rows.filter { $0.status.waitsOnYou && !$0.route.isAssistant }.map { row in
            let body: String
            switch row.status {
            case .review: body = "Needs your review"
            case .failed: body = "Failed: \(row.detail)"
            default: body = sentences(row.detail)
            }
            return Note(key: (row.keys.isEmpty ? [row.id] : row.keys).joined(separator: " "), title: row.title, body: body, path: row.id)
        }
    }

    /// "First cut is ready · next: B-roll" → "First cut is ready. Next: B-roll".
    nonisolated static func sentences(_ line: String) -> String {
        line.components(separatedBy: " · ").map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined(separator: ". ")
    }

    /// What to tell now: the rows with something he has not been shown. `shown` then becomes the
    /// names of everything that waits, so each thing is told once and a thing that left is forgotten.
    nonisolated static func fresh(_ rows: [ChatRow], shown: Set<String>) -> (notes: [Note], shown: Set<String>) {
        let all = notes(rows)
        let names = { (note: Note) in note.key.components(separatedBy: " ") }
        return (all.filter { !shown.isSuperset(of: names($0)) }, Set(all.flatMap(names)))
    }

    // MARK: Running

    /// At launch: taps on notifications come here, and the list is followed from now on.
    func start() {
        center.delegate = self
        ChatsModel.shared.$rows.dropFirst().sink { [weak self] rows in
            MainActor.assumeIsolated { self?.rowsChanged(rows) }
        }.store(in: &bag)
        let events = NotificationCenter.default
        events.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.away = true
                guard ToolsetAPI.current != nil else { return }
                BackgroundRefresh.schedule()
                // one look right away, in the moment iOS leaves the app on its way out
                let moment = UIApplication.shared.beginBackgroundTask()
                Task {
                    await self.lookInBackground()
                    UIApplication.shared.endBackgroundTask(moment)
                }
            }
        }
        events.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.cameToFront() }
        }
    }

    /// iOS gave the app a moment in the background: look, and tell what is new.
    func lookInBackground() async {
        guard ToolsetAPI.current != nil else { return }
        looking = true
        await ChatsModel.shared.load()
        looking = false
        await tell(take(ChatsModel.shared.rows))
    }

    private func rowsChanged(_ rows: [ChatRow]) {
        center.setBadgeCount(rows.filter(\.status.waitsOnYou).count)
        guard !looking else { return }
        let notes = take(rows)
        guard !notes.isEmpty else { return }
        switch UIApplication.shared.applicationState {
        case .background:
            Task { await tell(notes) }
        case .active where away:
            away = false
            Task { await tell(notes, inFront: true) }
        default:
            break   // it appeared in front of him, or the app is just opening
        }
    }

    /// Marks what waits now as shown and gives back what was new.
    private func take(_ rows: [ChatRow]) -> [Note] {
        let (notes, names) = Self.fresh(rows, shown: shown)
        if names != shown { shown = names }
        return notes
    }

    private func tell(_ notes: [Note], inFront: Bool = false) async {
        guard !notes.isEmpty else { return }
        switch await center.notificationSettings().authorizationStatus {
        case .notDetermined:
            // something happened while he was away and he could not be told: that is the moment to ask
            defaults.set(true, forKey: "notify.ask")
            if inFront { await cameToFront() }
        case .denied:
            break
        default:
            // in front he sees the list itself; and a server that pushes has told him already
            guard !inFront, !defaults.bool(forKey: "notify.push") else { return }
            for note in notes {
                let content = UNMutableNotificationContent()
                content.title = note.title
                content.body = note.body
                content.sound = .default
                content.threadIdentifier = note.path
                content.userInfo = ["path": note.path]
                try? await center.add(UNNotificationRequest(identifier: note.key, content: content, trigger: nil))
            }
        }
    }

    private func cameToFront() async {
        if defaults.bool(forKey: "notify.ask") {
            defaults.set(false, forKey: "notify.ask")
            _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
        }
    }

    /// "Turn on notifications" in Settings: iOS asks once.
    func turnOn() async {
        defaults.set(false, forKey: "notify.ask")
        _ = try? await center.requestAuthorization(options: [.alert, .badge, .sound])
        await cameToFront()
    }

    // MARK: UNUserNotificationCenterDelegate

    /// A tap on a notification opens what it is about.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let path = Self.path(in: response.notification.request.content.userInfo) else { return }
        await MainActor.run { AppNavigator.shared.open(href: path) }
    }

    /// With the app in front the list shows it: no banner, only the number on the icon.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.badge]
    }
}

/// Settings → Notifications: On, Off with a way to the iPhone's Settings, or a button that turns them on. Read again
/// when the person comes back from the iPhone's Settings.
struct NotificationsRow: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var status: UNAuthorizationStatus = .notDetermined

    var body: some View {
        Group {
            switch status {
            case .authorized, .provisional, .ephemeral:
                LabeledContent("Notifications", value: "On")
            case .denied:
                LabeledContent("Notifications", value: "Off")
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                }
            default:
                Button("Turn on notifications") {
                    Task {
                        await AppNotifications.shared.turnOn()
                        await read()
                    }
                }
            }
        }
        .task { await read() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await read() } }
        }
    }

    private func read() async {
        status = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }
}
