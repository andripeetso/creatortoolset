import Foundation

// Where each thing sits among the tabs: Chats · Plan · Make · Distribute · Tools, the desktop's stages.

extension WorkshopStatus {
    /// The tab a Workshop piece shows on at this stage: ideas and scripts on Plan (Shelved folded at its bottom), pieces
    /// being filmed or edited on Make, what is ready to post and what was posted on Distribute.
    var tab: AppTab {
        switch self {
        case .draft, .writing, .ready, .shelved, .unknown: .plan
        case .production, .editing: .make
        case .toPost, .published: .distribute
        }
    }
}

extension ChatList {
    /// Each chat's workspace from the list of chats, by chat id (a chat that keeps none is left out).
    static func spaces(_ chats: [ChatSummary]) -> [String: String] {
        Dictionary(chats.compactMap { c in c.workspace.map { (c.id, $0) } }, uniquingKeysWith: { first, _ in first })
    }

    /// The chat rows of `workspace`: a chat in another workspace is left out; one whose workspace is not known (an
    /// older server, a new chat before its first message) shows. No workspace picked: all of them.
    static func inWorkspace(_ rows: [ChatRow], _ workspace: String?, of spaces: [String: String], open: AssistantView?) -> [ChatRow] {
        guard let workspace else { return rows }
        return rows.filter { row in
            guard case .chat(let id) = row.route else { return true }
            let ws = spaces[id] ?? (open?.id == id ? open?.workspace : nil)
            return ws == nil || ws == workspace
        }
    }

    /// The Workshop pieces being filmed or edited, a row each on Make: their stage in words, never waiting on the
    /// person (only Review, a go and a failure do), so they sit under what waits and above Working.
    static func sessions(_ sessions: [WorkshopSession]) -> [ChatRow] {
        sessions.filter { $0.status.tab == .make }.map { session in
            let route = AppRoute.session(session.id)
            let at = session.updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) } ?? .distantPast
            return ChatRow(id: path(route), route: route, title: session.title,
                           detail: [session.status.label, session.kindLabel].compactMap { $0 }.joined(separator: " · "),
                           status: .time(at), at: at)
        }
    }
}
