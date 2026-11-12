import SwiftUI
import UIKit

/// A screen something can lead to: a row in Chats, a card or a link in a chat, a notification.
/// The server names things by their page on the website ("/review/<id>?v=2"); the phone opens
/// its own screen for the ones it has, and the page itself for the rest.
enum AppRoute: Hashable {
    /// The assistant's open chat.
    case assistant
    /// One of the assistant's chats by its id: the open one, or an earlier one that is opened first.
    case chat(String)
    /// An AI Editor edit: its thread.
    case edit(String)
    /// A Review video, on a version when one is named.
    case review(String, version: Int?)
    /// A Workshop session: its script.
    case session(String)
    case finals
    /// A page of the website the phone has no screen for (its path, with the query).
    case page(String)

    /// The route for a path of the website, or nil when it is not one of its pages
    /// (another site's address is opened by the phone itself).
    static func from(path raw: String) -> AppRoute? {
        guard let parts = URLComponents(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              parts.host == nil, parts.path.hasPrefix("/") else { return nil }
        let pieces = parts.path.split(separator: "/").map(String.init)
        func query(_ name: String) -> String? { parts.queryItems?.first { $0.name == name }?.value }
        switch pieces.first {
        case "editor" where pieces.count >= 2:
            return .edit(pieces[1])
        case "review" where pieces.count >= 2:
            return .review(pieces[1], version: query("v").flatMap(Int.init))
        case "workshop" where pieces.count >= 3 && pieces[1] == "sessions":
            return .session(pieces[2])
        case "library", "finals":
            return .finals
        case "assistant":
            return query("chat").map(AppRoute.chat) ?? .assistant
        case nil where query("chat")?.isEmpty == false:
            return .chat(query("chat")!)   // "/?chat=<id>": a notification about a reply in that chat
        default:
            return .page(raw)
        }
    }

    /// The assistant's open chat or one of its chats.
    var isAssistant: Bool {
        switch self {
        case .assistant, .chat: true
        default: false
        }
    }
}

/// Where the app is: the tab, and what is open on top of Chats and of Edits. One object, so a card in a
/// chat, a notification or a launch argument all open a screen the same way.
@MainActor
final class AppNavigator: ObservableObject {
    static let shared = AppNavigator()

    @Published var tab: AppTab = AppNavigator.startTab
    /// The screens pushed on Chats, first to last.
    @Published var chats: [AppRoute] = []
    /// The screens pushed on Edits, first to last.
    @Published var edits: [AppRoute] = []
    /// The account has the Edits tab (RootView says): without it an edit or a video opens on Chats.
    var hasEdits = true
    /// The assistant was opened to write: its box takes the keyboard once, then this is cleared.
    var composing = false

    init() {
        if let route = debugArg("OpenPath").flatMap(AppRoute.from(path:)) { open(route) }
    }

    /// The tab a screen opens on: an edit or a Review video on Edits, the assistant's chats on Chats, Finals on
    /// its own tab; a script or a page on the tab in front (Chats when that one has no screens of its own).
    nonisolated static func tab(for route: AppRoute, from current: AppTab, hasEdits: Bool) -> AppTab {
        let edits: AppTab = hasEdits ? .edits : .chats
        switch route {
        case .finals: return .finals
        case .edit, .review: return edits
        case .assistant, .chat: return .chats
        case .session, .page: return current == .edits ? edits : .chats
        }
    }

    func open(_ route: AppRoute) {
        tab = Self.tab(for: route, from: tab, hasEdits: hasEdits)
        switch tab {
        case .chats: if chats.last != route { chats.append(route) }
        case .edits: if edits.last != route { edits.append(route) }
        default: break
        }
    }

    /// The round button on Chats: a new chat with the assistant, keyboard up. An open chat with nothing in it yet is
    /// that new chat already. A message still on this phone (not sent yet, or not sent at all) belongs to the chat it
    /// was written in: then the open chat is shown and says why there is no new one yet.
    func newChat() {
        Task { await startNewChat() }
    }

    func startNewChat() async {
        let assistant = AssistantModel.shared
        if assistant.view == nil { await assistant.load() }
        if let view = assistant.view, !view.messages.isEmpty {
            if assistant.unsent {
                assistant.error = "A message here hasn't gone yet. A new chat can start once it has."
            } else {
                await assistant.newChat()
                // an older server refuses while a reply is being written
                if assistant.view?.messages.isEmpty == false, assistant.view?.thinking != nil {
                    assistant.error = "A reply is still being written here. A new chat can start once it's done."
                }
            }
        }
        composing = assistant.view?.messages.isEmpty ?? true
        open(.assistant)
    }

    /// A link in a chat or on a card: a page of the website becomes a screen, anything else leaves the app.
    func open(href: String) {
        if let route = AppRoute.from(path: href) {
            open(route)   // a chat of the assistant ("/?chat=<id>") is made the open one by its screen (AssistantChatRoute)
        } else if let url = URL(string: href), url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)
        }
    }

    /// A launch can open on a tab and a debug build on a screen, without taps: `-startTab 1` or `-startTab edits`
    /// (also `-StartTab`), `-OpenPath /review/<id>?v=2` (on its own tab), `-OpenPath /assistant`. `-newEdit YES` opens
    /// on Edits, where New edit then opens.
    private static var startTab: AppTab {
        let raw = UserDefaults.standard.string(forKey: "startTab") ?? debugArg("StartTab")
        return raw.flatMap { AppTab(rawValue: $0) ?? Int($0).flatMap { AppTab.allCases.indices.contains($0) ? AppTab.allCases[$0] : nil } }
            ?? (UserDefaults.standard.bool(forKey: "newEdit") ? .edits : .chats)
    }
}
