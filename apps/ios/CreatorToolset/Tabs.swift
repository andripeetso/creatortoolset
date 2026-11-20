import Foundation

// Where each thing sits among the tabs: Chats · Projects · Media · Publish · Tools.

/// The groups of Projects, as the computer's Content Workshop lists them.
enum ProjectGroup: CaseIterable {
    case ideas, making, published, shelved

    var title: String {
        switch self {
        case .ideas: "Ideas & writing"
        case .making: "Ready & in production"
        case .published: "Published"
        case .shelved: "Shelved"
        }
    }
}

extension WorkshopStatus {
    /// The group a project is listed in on Projects.
    var group: ProjectGroup {
        switch self {
        case .draft, .writing, .unknown: .ideas
        case .ready, .production, .editing, .toPost: .making
        case .published: .published
        case .shelved: .shelved
        }
    }
}

extension AppTab {
    /// What waits on the person, on the tab where it lives: chats that ask on Chats; edits and Review videos that wait
    /// (Review, your go, failed) on Projects; failed uploads on Media; what is ready to post on Publish.
    static func badges(rows: [ChatRow], failedUploads: Int, sessions: [WorkshopSession]) -> [AppTab: Int] {
        [.chats: ChatList.waiting(rows, chats: true), .projects: ChatList.waiting(rows, chats: false),
         .media: failedUploads, .publish: sessions.filter(\.toPost).count]
    }
}

extension ChatList {
    /// Each chat's workspace from the list of chats, by chat id (a chat that keeps none is left out).
    static func spaces(_ chats: [ChatSummary]) -> [String: String] {
        Dictionary(chats.compactMap { c in c.workspace.map { (c.id, $0) } }, uniquingKeysWith: { first, _ in first })
    }

    /// The chats settled or snoozed on any device, by chat id. The server leaves the mark off once one asks or works again.
    static func folds(_ chats: [ChatSummary]) -> [String: ChatRow.Fold] {
        Dictionary(chats.compactMap { c in
            c.settled == true ? (c.id, .settled) : c.snoozed != nil ? (c.id, .snoozed) : nil
        }, uniquingKeysWith: { first, _ in first })
    }

    /// Every chat row, each marked with its own workspace (from the list of chats, or the open chat's own); none is
    /// left out, whatever workspace the app is in.
    static func placed(_ rows: [ChatRow], spaces: [String: String], folds: [String: ChatRow.Fold] = [:], open: AssistantView?) -> [ChatRow] {
        rows.map { row in
            guard case .chat(let id) = row.route else { return row }
            var row = row
            row.workspace = spaces[id] ?? (open?.id == id ? open?.workspace : nil)
            row.fold = folds[id]
            return row
        }
    }

    /// Whether an edit or a Review video is a project's: the AI Editor names an edit after the project it is made for,
    /// and a cut after its edit ("Handstand basics, cut 2"). The assistant's chats belong to no project.
    static func belongs(_ row: ChatRow, to session: WorkshopSession) -> Bool {
        guard !row.route.isAssistant else { return false }
        let name = FinalsSessions.nameKey(session.title)
        let before = row.title.split(separator: ",", maxSplits: 1).first.map(String.init) ?? row.title
        return !name.isEmpty && [row.title, before].contains { FinalsSessions.nameKey($0) == name }
    }

    /// The edits and Review videos that are no project's: Projects lists them last, under Other edits.
    static func others(_ rows: [ChatRow], sessions: [WorkshopSession]) -> [ChatRow] {
        rows.filter { row in !row.route.isAssistant && !sessions.contains { belongs(row, to: $0) } }
    }
}

extension WorkshopSession {
    /// It matches the type filter (nil: All) and the words searched for (its title or its workspace's name).
    func shows(kind: String?, words: String) -> Bool {
        (kind == nil || (kinds ?? []).contains(kind!))
            && (words.isEmpty || [title, projectName ?? ""].contains { $0.lowercased().contains(words) })
    }

    /// Projects in their groups, newest first in each; an empty group is left out.
    static func grouped(_ sessions: [WorkshopSession]) -> [(group: ProjectGroup, sessions: [WorkshopSession])] {
        let newest = sessions.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
        return ProjectGroup.allCases.compactMap { group in
            let its = newest.filter { $0.status.group == group }
            return its.isEmpty ? nil : (group, its)
        }
    }
}
