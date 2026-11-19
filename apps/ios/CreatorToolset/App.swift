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
                .modifier(AccountSetupPresenter())
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

/// The tabs, the desktop's stages: Chats · Plan · Make · Distribute · Tools. Every tab always shows (one the account
/// can't use says why it's empty), and each starts with the workspace switcher top left. A badge counts only what waits
/// on the person.
struct RootView: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var access = ToolsetAccess.shared
    @ObservedObject private var plugins = ServerPlugins.shared
    @ObservedObject private var nav = AppNavigator.shared
    @ObservedObject private var chats = ChatsModel.shared
    @ObservedObject private var workshop = WorkshopModel.shared
    @ObservedObject private var workspaces = Workspaces.shared
    /// Uploads that need a look (on Make's badge). Counted from the store's list, not by watching the store: a byte
    /// going up must not redraw every tab.
    @State private var failed = 0
    private static var placed = false

    var body: some View {
        if servers.list.isEmpty {
            NavigationStack { FirstRunView() }
        } else {
            TabView(selection: $nav.tab) {
                StackTab(path: $nav.chats) { ChatsTab() }
                    .tabItem { Label("Chats", systemImage: "bubble.left.and.text.bubble.right") }
                    .badge(ChatList.waiting(chats.rows, chats: true))
                    .tag(AppTab.chats)
                StackTab(path: $nav.plan) { PlanView() }
                    .tabItem { Label("Plan", systemImage: "lightbulb") }
                    .tag(AppTab.plan)
                StackTab(path: $nav.make) { MakeView() }
                    .tabItem { Label("Make", systemImage: "film.stack") }
                    .badge(ChatList.waiting(chats.rows, chats: false) + failed)
                    .tag(AppTab.make)
                NavigationStack { DistributeView() }
                    .tabItem { Label("Distribute", systemImage: "paperplane") }
                    .badge(workshop.sessions.filter(\.toPost).count)
                    .tag(AppTab.distribute)
                NavigationStack { ToolsView() }
                    .tabItem { Label("Tools", systemImage: "square.grid.2x2") }
                    .tag(AppTab.tools)
            }
            // another server or workspace shows its own content: every tab starts again
            .id("\(servers.currentId ?? "")|\(workspaces.picked ?? "")")
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

    /// A helper who uploads (an account without the AI Editor on the studio) starts on Make's Media Library. Once per
    /// launch, and never over a tab or screen asked for at launch.
    private func place() {
        guard !Self.placed else { return }
        Self.placed = true
        guard UserDefaults.standard.string(forKey: "startTab") == nil, debugArg("StartTab") == nil,
              debugArg("OpenPath") == nil else { return }
        if plugins.studio, let me = access.me, me.role != "admin" {
            nav.tab = .make
            nav.makeSide = .media
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
                .workspaceSwitcher()
                .navigationDestination(for: AppRoute.self) { RouteView(route: $0) }
        }
    }
}

/// Chats: the workspace's chats, the round New chat button over them.
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
        Keychain.moveToSharedGroup()
        #if DEBUG
        PhoneDemo.install()
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
