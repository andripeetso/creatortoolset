import SwiftUI
import UIKit

/// A screen something can lead to: a row in Chats, a card or a link in a chat, a notification.
/// The server names things by their page on the website ("/review/<id>?v=2"); the phone opens
/// its own screen for the ones it has, and the page itself for the rest.
enum AppRoute: Hashable {
    case assistant
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
            return .assistant
        default:
            return .page(raw)
        }
    }
}

/// Where the app is: the tab, and what is open on top of Chats. One object, so a card in a
/// chat, a notification or a launch argument all open a screen the same way.
@MainActor
final class AppNavigator: ObservableObject {
    static let shared = AppNavigator()

    @Published var tab: AppTab = AppNavigator.startTab
    /// The screens pushed on Chats, first to last.
    @Published var chats: [AppRoute] = AppNavigator.startRoutes
    /// The assistant was opened to write: its box takes the keyboard once, then this is cleared.
    var composing = false

    func open(_ route: AppRoute) {
        switch route {
        case .finals:
            tab = .finals
        default:
            tab = .chats
            if chats.last != route { chats.append(route) }
        }
    }

    /// A link in a chat or on a card: a page of the website becomes a screen, anything else leaves the app.
    func open(href: String) {
        if let chat = Self.chat(in: href) {
            Task { await open(chat: chat) }
        } else if let route = AppRoute.from(path: href) {
            open(route)
        } else if let url = URL(string: href), url.scheme == "http" || url.scheme == "https" {
            UIApplication.shared.open(url)
        }
    }

    /// An assistant chat by its id, as the website names it (`/?chat=<id>`, e.g. a push about a reply).
    nonisolated static func chat(in href: String) -> String? {
        guard let parts = URLComponents(string: href), parts.host == nil, parts.path == "/" || parts.path.isEmpty else { return nil }
        return parts.queryItems?.first { $0.name == "chat" }?.value.flatMap { $0.isEmpty ? nil : $0 }
    }

    /// Opens the assistant on that chat: an earlier one is made the open chat first, as the website does. Not while a
    /// reply is being written (the server refuses then): the assistant opens on the chat it has.
    func open(chat id: String) async {
        let assistant = AssistantModel.shared
        if assistant.view == nil { await assistant.load() }
        if let view = assistant.view, view.id != id, view.thinking == nil, view.past.contains(where: { $0.id == id }) {
            await assistant.open(past: id)
        }
        open(.assistant)
    }

    /// A launch can open on a tab and a debug build on a screen, without taps: `-startTab 2` or `-startTab finals`
    /// (also `-StartTab`), `-OpenPath /review/<id>?v=2`, `-OpenPath /assistant`.
    private static var startTab: AppTab {
        let raw = UserDefaults.standard.string(forKey: "startTab") ?? debugArg("StartTab")
        return raw.flatMap { AppTab(rawValue: $0) ?? Int($0).flatMap { AppTab.allCases.indices.contains($0) ? AppTab.allCases[$0] : nil } } ?? .chats
    }

    /// `-newEdit YES` opens the assistant, where New edit then opens.
    private static var startRoutes: [AppRoute] {
        debugArg("OpenPath").flatMap(AppRoute.from(path:)).map { [$0] }
            ?? (UserDefaults.standard.bool(forKey: "newEdit") ? [.assistant] : [])
    }
}
