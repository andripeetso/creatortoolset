import BackgroundTasks
import Sentry
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
                .modifier(ConnectionDemoPresenter())
                .modifier(PairingLinkPresenter())
                .environmentObject(Servers.shared)
                .environmentObject(UploadEngine.shared)
                .environmentObject(UploadEngine.shared.store)
                .environmentObject(PhoneEdits.shared)
                .tint(Color("AccentColor"))
                .preferredColorScheme(Appearance(rawValue: appearance)?.scheme)
        }
        .onChange(of: scenePhase) { _, phase in
            UploadEngine.shared.setActive(phase == .active)
            if phase == .background {
                UploadEngine.shared.store.flush()
                BackgroundRefresh.schedule()
            }
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

/// The tabs: Chats · Projects · Media · Publish · Tools. Every tab always shows (one the account can't use says why it's
/// empty). Chats spans every workspace; Projects, Media and Publish are the picked workspace's, with the switcher top
/// left. A badge counts only what waits on the person, on the tab where it lives (`AppTab.badges`).
struct RootView: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var access = ToolsetAccess.shared
    @ObservedObject private var plugins = ServerPlugins.shared
    @ObservedObject private var nav = AppNavigator.shared
    @ObservedObject private var chats = ChatsModel.shared
    @ObservedObject private var workshop = WorkshopModel.shared
    @ObservedObject private var workspaces = Workspaces.shared
    /// Uploads that need a look (on Media's badge). Counted from the store's list, not by watching the store: a byte
    /// going up must not redraw every tab.
    @State private var failed = 0
    private static var placed = false

    var body: some View {
        if servers.list.isEmpty {
            NavigationStack { FirstRunView() }
        } else {
            let badges = AppTab.badges(rows: chats.rows, failedUploads: failed, sessions: workshop.sessions)
            // another workspace shows its own projects, media and finals: those tabs start again there; Chats stays
            let picked = workspaces.picked ?? ""
            TabView(selection: $nav.tab) {
                StackTab(path: $nav.chats) { ChatsTab().connectionHeader() }
                    .tabItem { Label("Chats", systemImage: "bubble.left.and.text.bubble.right") }
                    .badge(badges[.chats] ?? 0)
                    .tag(AppTab.chats)
                StackTab(path: $nav.projects) { ProjectsView().workspaceSwitcher() }
                    .id(picked)
                    .tabItem { Label("Projects", systemImage: "folder") }
                    .badge(badges[.projects] ?? 0)
                    .tag(AppTab.projects)
                NavigationStack { MediaView() }
                    .id(picked)
                    .tabItem { Label("Media", systemImage: "photo.on.rectangle") }
                    .badge(badges[.media] ?? 0)
                    .tag(AppTab.media)
                NavigationStack { PublishView() }
                    .id(picked)
                    .tabItem { Label("Publish", systemImage: "paperplane") }
                    .badge(badges[.publish] ?? 0)
                    .tag(AppTab.publish)
                NavigationStack { ToolsView() }
                    .tabItem { Label("Tools", systemImage: "square.grid.2x2") }
                    .tag(AppTab.tools)
            }
            // another server is another account's chats too: every tab starts again
            .id(servers.currentId ?? "")
            .overlay(alignment: .top) { WorkspaceToast() }
            .sheet(isPresented: $workspaces.choosing) { WorkspaceSwitcher() }
            // what the shared parts know is per server: the last answer at once, then the server's
            .task(id: servers.currentId) {
                access.load(for: servers.currentId)
                plugins.load(for: servers.currentId)
                ChatsModel.shared.watch()   // whichever tab it opens on: the badges and notifications need the rows
                StudioHooks.serverChanged()
                await workspaces.load()
                await access.refresh()
                // a Caption Studio video picked on this phone that hasn't all reached the server carries on
                CaptionEditor.resumeKept()
                await plugins.refresh()
                await workshop.load()
            }
            .onAppear(perform: place)
            .onReceive(UploadEngine.shared.store.$items.map { $0.filter { $0.state == .failed && $0.edit == nil }.count }.removeDuplicates()) {
                failed = $0
            }
        }
    }

    /// A helper who uploads (an account without the AI Editor on the studio) starts on Media. Once per launch, and never
    /// over a tab or screen asked for at launch.
    private func place() {
        guard !Self.placed else { return }
        Self.placed = true
        guard UserDefaults.standard.string(forKey: "startTab") == nil, debugArg("StartTab") == nil,
              debugArg("OpenPath") == nil else { return }
        if plugins.studio, let me = access.me, me.role != "admin" {
            nav.tab = .media
        }
    }
}

/// A tab with its own screens: whatever a row, a card or a notification opens on top of its first screen.
struct StackTab<Root: View>: View {
    @Binding var path: [AppRoute]
    @ViewBuilder let root: () -> Root

    var body: some View {
        NavigationStack(path: $path) {
            root()
                .navigationDestination(for: AppRoute.self) { RouteView(route: $0) }
        }
    }
}

/// Chats: every workspace's chats, the round New chat button over them.
struct ChatsTab: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var nav = AppNavigator.shared

    var body: some View {
        ChatsView()
            .overlay(alignment: .bottomTrailing) {
                if servers.current != nil, !servers.signedOut {
                    ComposeButton { nav.newChat() }
                        .padding(.trailing, 16)
                        .padding(.bottom, 12)
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
        case .chat(let id): AssistantChatRoute(id: id)
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

/// A wide Sign in button for a screen whose list needs the sign-in: opens `SignInAgainView`, then the screen reads
/// its list again.
struct SignInAgainButton: View {
    let done: () async -> Void
    @State private var open = false

    var body: some View {
        WideButton(title: "Sign in", systemImage: "person.crop.circle") { open = true }
            .sheet(isPresented: $open, onDismiss: { Task { await done() } }) { SignInAgainView() }
    }
}

/// A new chat with the assistant: the round button at the bottom of Chats, in the app's colour.
struct ComposeButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "square.and.pencil")
                .font(.system(size: 21, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 56, height: 56)
                .background(Color("AccentColor"), in: Circle())
                .contentShape(Circle())   // the whole circle takes the tap, not only the pencil
                .shadow(color: .black.opacity(0.18), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New chat")
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Crash reports go to the Sentry project in Info.plist (SentryDSN); a fork sets its own or leaves it empty to send none.
        if let dsn = Bundle.main.object(forInfoDictionaryKey: "SentryDSN") as? String, !dsn.isEmpty {
            SentrySDK.start { options in
                options.dsn = dsn
                #if DEBUG
                options.environment = "debug"
                #endif
            }
        }
        Keychain.moveToSharedGroup()
        #if DEBUG
        PhoneDemo.install()
        // screenshots with no screen capture: -SnapshotAfter 6 draws the window into Documents/snapshot.png after 6 s
        if let after = debugArg("SnapshotAfter").flatMap(Double.init) {
            DispatchQueue.main.asyncAfter(deadline: .now() + after) {
                guard let window = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first else { return }
                let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
                let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appending(path: "snapshot.png")
                try? image.pngData()?.write(to: url)
            }
        }
        // what an opened pairing link does, for a run with no taps: -OpenLink '<link>' (the same path as onOpenURL)
        if let raw = debugArg("OpenLink"), let url = URL(string: raw) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { PairingLinks.shared.open(url) }
        }
        // an end-to-end run pairs the simulator with no taps: -PairNow '<pairing link>' (a launch argument, never a link)
        if let raw = debugArg("PairNow"), let target = PairingTarget.parse(raw) {
            Task { @MainActor in
                do { try await Pairing.pair(target) } catch { NSLog("PairNow: %@", error.localizedDescription) }
            }
        }
        #endif
        _ = Servers.shared   // first, so `API.current` reads what it saved (a debug -localServer too)
        AccountPush.relay = AccountServers.shared   // push through the account signs with the account's relay token
        // created at launch, a background relaunch included, so the background session reconnects
        _ = UploadEngine.shared
        BackgroundRefresh.register()
        AppNotifications.shared.start()
        StudioHooks.launched()
        return true
    }

    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        // the assistant's videos have their own session
        if identifier == AssistantTransfers.identifier {
            AssistantTransfers.shared.finished = completionHandler
            return
        }
        guard identifier == Transfers.identifier else { return completionHandler() }
        Transfers.shared.backgroundCompletion = completionHandler
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task {
            await StudioHooks.pushToken(deviceToken)
            await AccountPush.took(deviceToken)
        }
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
                task.expirationHandler = run(done: task.setTaskCompleted(success:)) {
                    await UploadEngine.shared.reconcile()
                    await AppNotifications.shared.lookInBackground()
                }
            }
        }
    }

    /// Runs `work` and reports it done once: true when it finished, false when iOS took the time back first (the
    /// handler this returns; iOS ends the app if a task is never reported done).
    static func run(done: @escaping (Bool) -> Void, _ work: @escaping () async -> Void) -> () -> Void {
        let once = Once(done)
        let task = Task { @MainActor in
            await work()
            once.report(true)
        }
        return {
            task.cancel()
            once.report(false)
        }
    }

    /// The expiration handler may come on any thread.
    private final class Once: @unchecked Sendable {
        private let lock = NSLock()
        private var done: ((Bool) -> Void)?

        init(_ done: @escaping (Bool) -> Void) { self.done = done }

        func report(_ success: Bool) {
            lock.lock()
            let done = self.done
            self.done = nil
            lock.unlock()
            done?(success)
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
