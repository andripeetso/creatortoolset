import BackgroundTasks
import SwiftUI

@main
struct CreatorToolsetApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(Servers.shared)
                .environmentObject(UploadEngine.shared)
                .environmentObject(UploadEngine.shared.store)
                .preferredColorScheme(.dark)
        }
        .onChange(of: scenePhase) { _, phase in
            UploadEngine.shared.setActive(phase == .active)
            if phase == .background { BackgroundRefresh.schedule() }
        }
    }
}

/// The tabs: the phone is for talking to the AI, getting footage in, the finished pieces and reading scripts.
struct RootView: View {
    @EnvironmentObject private var servers: Servers
    /// `-startTab 2` at launch opens that tab, for screenshots in the simulator.
    @State private var tab = UserDefaults.standard.integer(forKey: "startTab")

    var body: some View {
        if servers.list.isEmpty {
            NavigationStack { AddServerView(first: true) }
        } else {
            TabView(selection: $tab) {
                NavigationStack { ChatView() }
                    .tabItem { Label("Chats", systemImage: "bubble.left.and.bubble.right") }.tag(0)
                NavigationStack { UploadView() }
                    .tabItem { Label("Upload", systemImage: "arrow.up.circle") }.tag(1)
                NavigationStack { FinalsView() }
                    .tabItem { Label("Finals", systemImage: "film.stack") }.tag(2)
                NavigationStack { ScriptsView() }
                    .tabItem { Label("Scripts", systemImage: "doc.text") }.tag(3)
                NavigationStack { MoreView() }
                    .tabItem { Label("More", systemImage: "ellipsis.circle") }.tag(4)
            }
            // another server shows its own content: every tab starts again
            .id(servers.currentId)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // created at launch, a background relaunch included, so the background session reconnects
        _ = UploadEngine.shared
        BackgroundRefresh.register()
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == Transfers.identifier else { return completionHandler() }
        Transfers.shared.backgroundCompletion = completionHandler
    }
}

/// Now and then iOS gives the app a moment in the background to resume an upload that was waiting.
enum BackgroundRefresh {
    /// Matches BGTaskSchedulerPermittedIdentifiers in Info.plist.
    static let identifier = (Bundle.main.bundleIdentifier ?? "com.creatortoolset.ios") + ".refresh"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            MainActor.assumeIsolated {
                schedule()
                let work = Task {
                    await UploadEngine.shared.reconcile()
                    task.setTaskCompleted(success: true)
                }
                task.expirationHandler = { work.cancel() }
            }
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}

/// A problem, in one line.
struct Problem: View {
    let text: String
    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
