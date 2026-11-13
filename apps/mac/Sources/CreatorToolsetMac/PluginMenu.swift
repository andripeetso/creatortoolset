// The menu items the server's plug-ins add (GET /api/activity/menu) to the Go menu and the menu bar panel's Settings & More.
// No Swift in a plug-in: a plug-in gives a title and an app path, and the window opens it.
import SwiftUI

/// GET /api/activity/menu, one item. `href` is an app path, as for the panel's rows.
struct PluginMenuItem: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let href: String
}

/// The items a menu shows: a title, and an app path the window can open (never another host, never "//" or "/\").
func pluginMenuItems(_ items: [PluginMenuItem]) -> [PluginMenuItem] {
    items.filter { item in
        !item.title.trimmingCharacters(in: .whitespaces).isEmpty
            && item.href.hasPrefix("/") && !item.href.hasPrefix("//") && !item.href.hasPrefix("/\\")
    }
}

/// The plug-in items as menu entries, under a divider; nothing when no plug-in adds any.
struct PluginMenuItems: View {
    @ObservedObject var shell: Shell

    var body: some View {
        if !shell.pluginMenu.isEmpty {
            Divider()
            ForEach(shell.pluginMenu) { item in
                Button(item.title) { shell.showWindow(href: item.href) }
            }
        }
    }
}

/// GET /api/activity/tools, one item: an app page the Go menu lists by name (the server decides which the account sees).
struct AppToolItem: Decodable, Equatable, Identifiable {
    let id: String
    let title: String
    let href: String
}

/// The Go menu's ⌘ keys by tool id, as the first builds had them (⌘1 Home … ⌘5 Analyzer); a tool without one has none.
let appToolShortcuts: [String: Character] = ["home": "1", "workshop": "2", "editor": "3", "finals": "4", "analyzer": "5"]

/// The app's tools the Go menu shows: a title and an app path, same rule as the plug-in items.
func appToolItems(_ items: [AppToolItem]) -> [AppToolItem] {
    pluginMenuItems(items.map { PluginMenuItem(id: $0.id, title: $0.title, href: $0.href) })
        .compactMap { item in items.first { $0.id == item.id } }
}

/// The Go menu's tools, from the server's list, in its order, each with its ⌘ key when it has one.
struct AppToolItems: View {
    @ObservedObject var shell: Shell

    var body: some View {
        ForEach(shell.appTools) { item in
            if let key = appToolShortcuts[item.id] {
                Button(item.title) { shell.open(item.href) }.keyboardShortcut(KeyEquivalent(key), modifiers: .command)
            } else {
                Button(item.title) { shell.open(item.href) }
            }
        }
    }
}
