// The menu bar panel: what is running right now and what waits on you, one row each, the state on the right in
// colour. Rows come from the open server's Workshop sessions (GET /api/workshop/sessions/summary), its own background
// work and its plug-ins' rows (GET /api/activity: the Media Library, edits, exports; no Swift in a plug-in) and this app's
// AI runner. Under them, menu rows: open the window, record the screen, and the rest of the old menu behind Settings & More.
import ServiceManagement
import SwiftUI

/// GET /api/workshop/sessions/summary, one row.
struct SessionRow: Decodable {
    let id: String
    let title: String
    let working: Bool
    let ready: Bool
}

enum RowState: Equatable {
    case working, ready

    var word: String { self == .working ? "Working" : "Ready" }
}

/// GET /api/activity, one row a plug-in (or the core app) adds. `state` is "working" or "ready"; `href` an app path.
struct PluginRow: Decodable, Equatable {
    let id: String
    let title: String
    let detail: String
    let state: String
    let href: String
    /// buttons on the row: start, stop or restart a LaunchAgent on this Mac (LaunchAgent.swift)
    var actions: [PluginAction]? = nil
    /// how far it is, 0 to 1
    var progress: Double? = nil
    /// why the work waits and when it carries on by itself (an AI plan's limit)
    var reason: String? = nil
}

/// One button of a plug-in row. `run` is "start", "stop" or "restart"; `label` the LaunchAgent it runs.
struct PluginAction: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let run: String
    let label: String
}

struct ActivityRow: Identifiable, Equatable {
    let id: String
    let title: String
    let detail: String
    let state: RowState
    /// the page it opens in the window; nil = This Mac
    let href: String?
    var actions: [PluginAction] = []
    var progress: Double? = nil
    var reason: String? = nil

    /// The word on the right: work held back says Waiting, not Working.
    var word: String { reason != nil ? "Waiting" : state.word }
}

/// The panel's own line for this Mac's last AI answer when it was a plan's limit, unless a row already gives that as its
/// reason (said once). Nil when the last answer was no limit.
func panelLimitLine(lastError: String?, rows: [ActivityRow]) -> String? {
    rows.contains { $0.reason != nil } ? nil : lastError.flatMap(plainLimitLine)
}

/// Active (replies being written, plug-in work, this Mac's AI and the cards it draws) and For you (new replies, plug-in
/// items waiting), in that order.
func activityRows(sessions: [SessionRow], aiRunning: Int, plugin: [PluginRow] = [], drawing: Bool = false) -> (active: [ActivityRow], forYou: [ActivityRow]) {
    var active = sessions.filter(\.working).map {
        ActivityRow(id: "s:\($0.id)", title: $0.title, detail: "Workshop", state: .working, href: "/workshop/sessions/\($0.id)")
    }
    active += plugin.filter { $0.state == "working" }.map(\.row)
    if aiRunning > 0 || drawing {
        let doing = [aiRunning > 0 ? "\(aiRunning) AI request\(aiRunning == 1 ? "" : "s")" : nil, drawing ? "Drawing cards" : nil]
        active.append(ActivityRow(id: "mac", title: "This Mac", detail: doing.compactMap { $0 }.joined(separator: " · "),
                                  state: .working, href: nil))
    }
    var forYou = sessions.filter { $0.ready && !$0.working }.map {
        ActivityRow(id: "r:\($0.id)", title: $0.title, detail: "Workshop · new reply", state: .ready, href: "/workshop/sessions/\($0.id)")
    }
    forYou += plugin.filter { $0.state == "ready" }.map(\.row)
    return (active, forYou)
}

extension PluginRow {
    /// The panel's row; the id is prefixed so a plug-in's row never shares an id with a session's.
    var row: ActivityRow {
        ActivityRow(id: "p:\(id)", title: title, detail: detail, state: state == "working" ? .working : .ready, href: href,
                    actions: (actions ?? []).filter { LaunchAgent.verbs.contains($0.run) && LaunchAgent.isValid($0.label) },
                    progress: progress.map { min(1, max(0, $0)) }, reason: reason)
    }
}

struct ActivityPanel: View {
    @ObservedObject var shell: Shell
    @ObservedObject private var recorder: Recorder
    @ObservedObject private var quick = RecordShortcut.shared
    let checkForUpdates: () -> Void

    init(shell: Shell, checkForUpdates: @escaping () -> Void) {
        self.shell = shell
        self.recorder = shell.recorder
        self.checkForUpdates = checkForUpdates
    }

    var body: some View {
        let rows = shell.rows
        let lastError = shell.ai.lastError
        let live = recorder.phase == .recording || recorder.phase == .paused
        PanelBody(
            active: rows.active, forYou: rows.forYou,
            // the plan's usage limit is a state, not an error: said on its own line, or by the row whose work it holds back
            limit: panelLimitLine(lastError: lastError, rows: rows.active),
            empty: shell.hasServer ? "Nothing running or waiting" : "Pick a server in the window to see your work",
            warnings: [lastError.flatMap(plainLimitLine) == nil ? lastError.map { "Last AI error: \($0)" } : nil,
                       shell.notice, shell.spaceLine].compactMap { $0 },
            open: { row in if let href = row.href { shell.showWindow(href: href) } else { shell.openThisMac() } },
            run: { shell.runAgent($0) }
        ) {
            PanelMenuRow(title: "Open Creator Toolset") { shell.showWindow() }
            if Recorder.available {
                PanelMenuRow(title: live ? "Stop Recording" : "Record Screen", shortcut: quick.shortcut?.display) { recorder.toggle() }
                    .disabled(recorder.phase == .saving)
            }
            PanelMoreRow { MoreMenu(shell: shell, checkForUpdates: checkForUpdates) }
        }
        .onAppear { Task { await shell.refresh() } }
    }
}

/// The panel's look from plain values (the screenshot test renders it with fixture rows): the rows under Running and
/// Waiting on you (a label only for a part with rows), one quiet line when both are empty, then the menu rows.
struct PanelBody<Rows: View>: View {
    let active: [ActivityRow]
    let forYou: [ActivityRow]
    var limit: String? = nil
    var empty = "Nothing running or waiting"
    var warnings: [String] = []
    var open: (ActivityRow) -> Void = { _ in }
    var run: (PluginAction) -> Void = { _ in }
    @ViewBuilder let menu: () -> Rows

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // ponytail: 12 rows a part, no scrolling; the window's pages hold the rest
            part("Running", active, top: 4)
            part("Waiting on you", forYou, top: active.isEmpty ? 4 : 10)
            if let limit {
                Text(limit).font(.system(size: 12, weight: .medium)).foregroundStyle(.orange)
                    .padding(.horizontal, 14).padding(.vertical, 6)
            } else if active.isEmpty && forYou.isEmpty {
                Text(empty).font(.system(size: 13)).foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.vertical, 6)
            }
            ForEach(warnings, id: \.self) {
                Text($0).font(.system(size: 11)).foregroundStyle(.orange).padding(.horizontal, 14).padding(.vertical, 2)
            }
            Divider().padding(.horizontal, 14).padding(.vertical, 5)
            menu()
        }
        .padding(.vertical, 5)
        .frame(width: 380)
    }

    @ViewBuilder private func part(_ label: String, _ rows: [ActivityRow], top: CGFloat) -> some View {
        if !rows.isEmpty {
            Text(label).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                .padding(.horizontal, 14).padding(.top, top).padding(.bottom, 2)
            ForEach(rows.prefix(12)) { RowView(row: $0, open: open, run: run) }
        }
    }
}

private struct RowView: View {
    let row: ActivityRow
    let open: (ActivityRow) -> Void
    let run: (PluginAction) -> Void
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            Button { open(row) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(row.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                        Text(row.detail).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                        Spacer(minLength: 8)
                        // a row with a button says what to do with it; a state word beside it would be one word too many
                        if row.actions.isEmpty {
                            Text(row.word).font(.system(size: 12, weight: .medium))
                                .foregroundStyle(row.reason != nil ? .secondary : row.state == .working ? Color(red: 0.45, green: 0.72, blue: 1) : Color(red: 0.20, green: 0.83, blue: 0.60))
                        }
                    }
                    if let reason = row.reason {
                        Text(reason).font(.system(size: 11)).foregroundStyle(.orange).fixedSize(horizontal: false, vertical: true)
                    } else if let progress = row.progress {
                        ProgressView(value: progress).progressViewStyle(.linear).controlSize(.mini)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // a plug-in's buttons (LaunchAgent.swift): run in the background, the panel says what failed
            ForEach(row.actions) { action in
                Button(action.title) { run(action) }
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 9).padding(.vertical, 4)
        .background(hover ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 4))
        .onHover { hover = $0 }
        .padding(.horizontal, 5)
    }
}

/// One menu-style row at the bottom of the panel: a title on the left, its key in grey on the right, the accent highlight
/// under the pointer, as a menu item has. Another action (a key it answers to on the right) is one more of these.
struct PanelMenuRow: View {
    let title: String
    var shortcut: String? = nil
    /// shown highlighted from the start (the screenshot test)
    var highlighted = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            PanelMenuLabel(title: title, trailing: shortcut.map { Text($0) }, highlighted: highlighted)
        }
        .buttonStyle(.plain)
    }
}

/// The last row: the old gear menu (this Mac's AI, servers, settings, logs, Quit) behind one row.
struct PanelMoreRow<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        Menu(content: content) {
            PanelMenuLabel(title: "Settings & More", trailing: Text(Image(systemName: "chevron.right")).font(.system(size: 11, weight: .semibold)))
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
    }
}

private struct PanelMenuLabel: View {
    let title: String
    let trailing: Text?
    @Environment(\.isEnabled) private var enabled
    @State private var hover: Bool

    init(title: String, trailing: Text?, highlighted: Bool = false) {
        self.title = title
        self.trailing = trailing
        _hover = State(initialValue: highlighted)
    }

    var body: some View {
        let lit = hover && enabled
        HStack {
            Text(title)
            Spacer(minLength: 12)
            trailing?.foregroundStyle(lit ? AnyShapeStyle(.white.opacity(0.75)) : AnyShapeStyle(.tertiary))
        }
        .font(.system(size: 13))
        .foregroundStyle(lit ? AnyShapeStyle(.white) : enabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
        .padding(.horizontal, 9).frame(height: 22)
        .background(lit ? Color.accentColor : .clear, in: RoundedRectangle(cornerRadius: 4))
        .contentShape(Rectangle())
        .onHover { hover = $0 }
        .padding(.horizontal, 5)
    }
}

/// Settings & More: this Mac's AI, the server here, servers, logs, the app.
private struct MoreMenu: View {
    @ObservedObject var shell: Shell
    let checkForUpdates: () -> Void

    var body: some View {
        Text(shell.aiLine)
        if shell.runsHere, let line = shell.serverLine {
            Text(line)
        }
        Toggle("Use this Mac for my AI", isOn: Binding(get: { shell.aiOn }, set: { shell.setAI($0) }))
        if Recorder.available { Menu("Screen Recordings") { RecordingMenu(recorder: shell.recorder) } }
        Divider()
        Menu("Servers") { ServersMenu(shell: shell) }
        Button("This Mac…") { shell.openThisMac() }
        PluginMenuItems(shell: shell)
        Button("Settings…") { shell.openSettings() }
        Toggle("Open at login", isOn: Binding(get: { LoginItem.isOn }, set: { LoginItem.set($0) }))
        Divider()
        Button("Open app log") { shell.openAppLog() }
        if shell.runsHere {
            Button("Open server log") { shell.openServerLog() }
        }
        Button("Check for Updates…") { checkForUpdates() }
        Divider()
        Button("Quit Creator Toolset") { NSApp.terminate(nil) }
    }
}

/// Open at login (the app's own login item, System Settings → General → Login Items).
enum LoginItem {
    static var isOn: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ on: Bool) {
        do { try on ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister() }
        catch { AppLog.write("login item: \(error.localizedDescription)") }
    }

    /// Once, for a copy in /Applications (never a `swift run` build): on by default. True when it just switched on,
    /// so the caller says so once (explainOnce).
    static func setOnce() -> Bool {
        guard Bundle.main.bundlePath.hasPrefix("/Applications/"), !UserDefaults.standard.bool(forKey: "loginItemSet") else { return false }
        UserDefaults.standard.set(true, forKey: "loginItemSet")
        set(true)
        return isOn
    }

    /// The one line about it, after the window's first open: it is on, and how to switch it off.
    @MainActor static func explainOnce() {
        let a = NSAlert()
        a.messageText = "Creator Toolset opens when you log in"
        a.informativeText = "It waits in the menu bar, so your AI and recordings are ready. Turn this off any time in This Mac."
        a.addButton(withTitle: "OK")
        a.addButton(withTitle: "Turn Off")
        if a.runModal() == .alertSecondButtonReturn { set(false) }
    }
}

/// Screen recording's own settings (the menu bar panel's Settings & More and the app's Record menu): the shortcut, the menu bar
/// button, the folder. What a recording hears is chosen on the recording toolbar (RecordToolbar.swift).
struct RecordingMenu: View {
    let recorder: Recorder
    @ObservedObject private var quick = RecordShortcut.shared

    init(recorder: Recorder) { self.recorder = recorder }

    var body: some View {
        Button("Recording Shortcut: \(quick.shortcut?.display ?? "None")…") { quick.choose() }
        Toggle("Record Button in Menu Bar", isOn: $quick.showsButton)
        Divider()
        Button("Recordings Folder…") { recorder.pickFolder() }
        Button("Show Recordings") { recorder.showFolder() }
    }
}
