// The menu bar panel: what is working right now and what waits for you, one row each, the state on the right in
// colour. Rows come from the open server's Workshop sessions (GET /api/workshop/sessions/summary), the plug-in rows
// it adds (GET /api/activity, no Swift in a plug-in) and this app's AI runner; the rest of the old menu sits behind a gear.
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
}

/// Active (replies being written, plug-in work, this Mac's AI) and For you (new replies, plug-in items waiting), in that order.
func activityRows(sessions: [SessionRow], aiRunning: Int, plugin: [PluginRow] = []) -> (active: [ActivityRow], forYou: [ActivityRow]) {
    var active = sessions.filter(\.working).map {
        ActivityRow(id: "s:\($0.id)", title: $0.title, detail: "Workshop", state: .working, href: "/workshop/sessions/\($0.id)")
    }
    active += plugin.filter { $0.state == "working" }.map(\.row)
    if aiRunning > 0 {
        active.append(ActivityRow(id: "mac", title: "This Mac", detail: "\(aiRunning) AI request\(aiRunning == 1 ? "" : "s")",
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
                    actions: (actions ?? []).filter { LaunchAgent.verbs.contains($0.run) && LaunchAgent.isValid($0.label) })
    }
}

struct ActivityPanel: View {
    @ObservedObject var shell: Shell
    let checkForUpdates: () -> Void

    var body: some View {
        let rows = shell.rows
        VStack(alignment: .leading, spacing: 0) {
            Text(rows.active.isEmpty ? "Nothing running" : "\(rows.active.count) active")
                .font(.system(size: 13, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 14).padding(.top, 12).padding(.bottom, 6)

            // ponytail: 12 rows a section, no scrolling; the window's pages hold the rest
            ForEach(rows.active.prefix(12)) { RowView(row: $0, shell: shell) }
            if !rows.forYou.isEmpty {
                Text("For you").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 14).padding(.top, rows.active.isEmpty ? 2 : 10).padding(.bottom, 2)
                ForEach(rows.forYou.prefix(12)) { RowView(row: $0, shell: shell) }
            }
            if rows.active.isEmpty && rows.forYou.isEmpty {
                Text(shell.hasServer ? "Nothing waits for you." : "Pick a server in the window to see your work.")
                    .font(.system(size: 12)).foregroundStyle(.secondary).padding(.horizontal, 14).padding(.vertical, 6)
            }
            ForEach([shell.ai.lastError.map { "Last AI error: \($0)" }, shell.notice, shell.spaceLine].compactMap { $0 }, id: \.self) {
                Text($0).font(.system(size: 11)).foregroundStyle(.orange).padding(.horizontal, 14).padding(.top, 4)
            }

            Divider().padding(.top, 6)
            HStack {
                Button("Open Creator Toolset") { shell.showWindow() }
                if Recorder.available {
                    RecordScreenButton(recorder: shell.recorder)
                }
                Spacer()
                Menu {
                    MoreMenu(shell: shell, checkForUpdates: checkForUpdates)
                } label: {
                    Image(systemName: "gearshape")
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
            }
            .buttonStyle(.borderless)
            .padding(.horizontal, 14).padding(.vertical, 8)
        }
        .frame(width: 380)
        .onAppear { Task { await shell.refresh() } }
    }
}

private struct RowView: View {
    let row: ActivityRow
    let shell: Shell
    @State private var hover = false

    var body: some View {
        HStack(spacing: 8) {
            Button {
                if let href = row.href { shell.showWindow(href: href) } else { shell.openThisMac() }
            } label: {
                HStack(spacing: 8) {
                    Text(row.title).font(.system(size: 13, weight: .medium)).lineLimit(1)
                    Text(row.detail).font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(row.state.word).font(.system(size: 12, weight: .medium))
                        .foregroundStyle(row.state == .working ? Color(red: 0.45, green: 0.72, blue: 1) : Color(red: 0.20, green: 0.83, blue: 0.60))
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            // a plug-in's buttons (LaunchAgent.swift): run in the background, the panel says what failed
            ForEach(row.actions) { action in
                Button(action.title) { shell.runAgent(action) }
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(hover ? Color.primary.opacity(0.08) : .clear, in: RoundedRectangle(cornerRadius: 6))
        .onHover { hover = $0 }
        .padding(.horizontal, 6)
    }
}

/// The gear: this Mac's AI, the server here, servers, logs, the app.
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

    /// Once, for a copy in /Applications (never a `swift run` build): on by default; the gear's switch turns it off.
    static func setOnce() {
        guard Bundle.main.bundlePath.hasPrefix("/Applications/"), !UserDefaults.standard.bool(forKey: "loginItemSet") else { return }
        UserDefaults.standard.set(true, forKey: "loginItemSet")
        set(true)
    }
}

/// Screen recording's own settings (the menu bar's gear menu and the app's Record menu): the shortcut, the menu bar
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

/// The menu bar panel's Record screen, with the shortcut beside it.
private struct RecordScreenButton: View {
    @ObservedObject var recorder: Recorder
    @ObservedObject private var quick = RecordShortcut.shared

    var body: some View {
        Button {
            recorder.toggle()
        } label: {
            HStack(spacing: 6) {
                Text(recorder.phase == .recording || recorder.phase == .paused ? "Stop recording" : "Record screen")
                if let key = quick.shortcut?.display { Text(key).foregroundStyle(.tertiary) }
            }
        }
        .disabled(recorder.phase == .saving)
    }
}
