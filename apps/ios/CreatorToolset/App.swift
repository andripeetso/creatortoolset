import BackgroundTasks
import SwiftUI

@main
struct CreatorToolsetApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @Environment(\.scenePhase) private var scenePhase
    /// As the phone is set, or always light or dark (Settings → Appearance).
    @AppStorage(Appearance.key) private var appearance = Appearance.system.rawValue

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(Servers.shared)
                .environmentObject(UploadEngine.shared)
                .environmentObject(UploadEngine.shared.store)
                .environmentObject(PhoneEdits.shared)
                .tint(Color("AccentColor"))
                .preferredColorScheme(Appearance(rawValue: appearance)?.scheme)
        }
        .onChange(of: scenePhase) { _, phase in
            UploadEngine.shared.setActive(phase == .active)
            if phase == .background { BackgroundRefresh.schedule() }
            if phase == .active {
                Task {
                    await ToolsetAccess.shared.refresh()
                    await ServerPlugins.shared.refresh()
                }
            }
        }
    }
}

/// Automatic follows the phone; Light and Dark stay.
enum Appearance: String, CaseIterable, Identifiable {
    case system, light, dark

    /// Where the choice is kept; the app's window reads the same key.
    static let key = "appearance"

    var id: String { rawValue }
    var title: String {
        switch self {
        case .system: "Automatic"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var scheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

/// The Appearance choice, as a row for Settings.
struct AppearancePicker: View {
    @AppStorage(Appearance.key) private var appearance = Appearance.system.rawValue

    var body: some View {
        Picker("Appearance", selection: $appearance) {
            ForEach(Appearance.allCases) { Text($0.title).tag($0.rawValue) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }
}

/// The tabs: Chats (talking to the AI and what waits on the person), Upload, Finals, Scripts and More. A tab the
/// account may not use is gone; each tab's badge counts what waits there.
struct RootView: View {
    @EnvironmentObject private var servers: Servers
    @EnvironmentObject private var store: UploadStore
    @ObservedObject private var access = ToolsetAccess.shared
    @ObservedObject private var plugins = ServerPlugins.shared
    @ObservedObject private var nav = AppNavigator.shared
    @ObservedObject private var chats = ChatsModel.shared
    @ObservedObject private var workshop = WorkshopModel.shared
    private static var placed = false

    var body: some View {
        if servers.list.isEmpty {
            NavigationStack { AddServerView(first: true) }
        } else {
            TabView(selection: $nav.tab) {
                ChatsTab()
                    .tabItem { Label("Chats", systemImage: "bubble.left.and.text.bubble.right") }
                    .badge(chats.waiting)
                    .tag(AppTab.chats)
                NavigationStack { UploadView() }
                    .tabItem { Label("Upload", systemImage: "arrow.up.circle") }
                    .badge(store.items.filter { $0.state == .failed }.count)
                    .tag(AppTab.upload)
                if access.shows(.finals) {
                    NavigationStack { FinalsView() }
                        .tabItem { Label("Finals", systemImage: "checkmark.seal") }
                        .badge(workshop.sessions.filter(\.toPost).count)
                        .tag(AppTab.finals)
                }
                if access.shows(.scripts) {
                    NavigationStack { ScriptsView() }
                        .tabItem { Label("Scripts", systemImage: "doc.text") }
                        .tag(AppTab.scripts)
                }
                NavigationStack { MoreView() }
                    .tabItem { Label("More", systemImage: "square.grid.2x2") }
                    .tag(AppTab.more)
            }
            // another server shows its own content: every tab starts again
            .id(servers.currentId)
            // access taken away while its tab was open
            .onChange(of: access.me) { _, _ in
                if !access.shows(nav.tab) { nav.tab = .chats }
            }
            // what the shared parts know is per server: the last answer at once, then the server's
            .task(id: servers.currentId) {
                access.load(for: servers.currentId)
                plugins.load(for: servers.currentId)
                StudioHooks.serverChanged()
                await access.refresh()
                await plugins.refresh()
                await workshop.load()
            }
            .onAppear(perform: place)
        }
    }

    /// A helper who uploads (an account without the AI Editor on the studio) starts on Upload. Once per launch, and
    /// never over a tab or screen asked for at launch.
    private func place() {
        guard !Self.placed else { return }
        Self.placed = true
        guard UserDefaults.standard.string(forKey: "startTab") == nil, debugArg("StartTab") == nil,
              debugArg("OpenPath") == nil else { return }
        if plugins.studio, let me = access.me, me.role != "admin" { nav.tab = .upload }
    }
}

/// Chats, and whatever a row, a card or a notification opens on top of it.
struct ChatsTab: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var nav = AppNavigator.shared

    var body: some View {
        NavigationStack(path: $nav.chats) {
            ChatsView()
                .navigationDestination(for: AppRoute.self) { RouteView(route: $0) }
                .overlay(alignment: .bottomTrailing) {
                    if servers.current != nil, !servers.signedOut {
                        ComposeButton { nav.compose() }
                            .padding(.trailing, 16)
                            .padding(.bottom, 12)
                    }
                }
        }
    }
}

/// The screen a route leads to.
struct RouteView: View {
    let route: AppRoute
    @ObservedObject private var plugins = ServerPlugins.shared

    var body: some View {
        // a pushed screen takes the whole height: the tab bar belongs to the first screen of a tab
        screen.toolbar(.hidden, for: .tabBar)
    }

    @ViewBuilder private var screen: some View {
        switch route {
        case .assistant: AssistantChatView()
        case .edit(let id):
            if plugins.studio { EditThreadView(id: id) } else { PageView(path: "/editor/\(id)") }
        case .review(let id, let version): ReviewRouteView(id: id, version: version)
        case .session(let id): SessionRouteView(id: id)
        case .finals: EmptyView()   // a tab, never pushed (AppNavigator.open)
        case .page(let path): PageView(path: path)
        }
    }
}

/// Sign in again to the server in use (or add one): the add-a-computer screen with its address filled in. Show it in
/// a sheet and read again in the sheet's onDismiss.
struct SignInAgainView: View {
    @EnvironmentObject private var servers: Servers

    var body: some View {
        NavigationStack { AddServerView(prefill: servers.current?.url.absoluteString) }
    }
}

/// New message to the assistant: the round button at the bottom of Chats.
struct ComposeButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(.primary)
                .frame(width: 54, height: 54)
                .chatSurface(cornerRadius: 27)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Message the assistant")
    }
}

extension AppNavigator {
    /// Opens the assistant with the keyboard up.
    func compose() {
        composing = true
        open(.assistant)
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        Keychain.moveToSharedGroup()
        _ = Servers.shared   // first, so `API.current` reads what it saved (a debug -localServer too)
        // created at launch, a background relaunch included, so the background session reconnects
        _ = UploadEngine.shared
        BackgroundRefresh.register()
        AppNotifications.shared.start()
        StudioHooks.launched()
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        guard identifier == Transfers.identifier else { return completionHandler() }
        Transfers.shared.backgroundCompletion = completionHandler
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { await StudioHooks.pushToken(deviceToken) }
    }
}

/// Now and then iOS gives the app a moment in the background: to resume an upload that was waiting, and to look for
/// what started waiting on the person.
enum BackgroundRefresh {
    /// Matches BGTaskSchedulerPermittedIdentifiers in Info.plist.
    static let identifier = (Bundle.main.bundleIdentifier ?? "com.creatortoolset.ios") + ".refresh"

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            MainActor.assumeIsolated {
                schedule()
                let work = Task {
                    await UploadEngine.shared.reconcile()
                    await AppNotifications.shared.lookInBackground()
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
