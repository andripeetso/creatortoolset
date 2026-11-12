import Foundation

// The phone's New edits in Chats: one row each, from Start until its first cut in Review has been opened.

extension PhoneEdits {
    /// The New edits of the server in use, each with how far it is.
    var here: [(edit: PhoneEdit, state: EditState)] {
        list.filter { $0.server == Servers.shared.currentId }.map { ($0, state($0)) }
    }
}

extension ChatList {
    /// A New edit's row. Until the server has the edit its id is the phone's own; then it is the edit's page, and
    /// once ready, its Review video's. A tap on one still starting or stopped is the Chats screen's (`ChatsView.tap`).
    static func row(_ edit: PhoneEdit, _ state: EditState) -> ChatRow {
        let target = AppRoute.edit(edit.editId ?? edit.id.uuidString)
        func make(_ detail: String, _ status: RowStatus, error: Bool = false, shelf: ChatRow.Shelf = .active,
                  route: AppRoute = target, keys: [String] = []) -> ChatRow {
            // not on the server yet: an id that is no page, so a notification about it only opens the app
            ChatRow(id: route == target && edit.editId == nil ? "phone-edit:\(edit.id)" : path(route), route: route, title: edit.name, detail: detail, detailIsError: error, status: status,
                    at: edit.made ?? .distantPast, shelf: shelf, keys: keys, phoneEdit: edit.id)
        }
        switch state {
        case .starting: return make("Starting…", .working(since: nil))
        case .uploading(let done, let of): return make("\(done) of \(of) clips uploaded", .working(since: nil))
        case .failed(let why), .stuck(let why): return make(why, .failed, error: true)
        case .editing: return make("Editing", .working(since: edit.made), shelf: .working)
        case .ready(let page):
            let route = AppRoute.from(path: page) ?? target
            // the same name the Review video's own row has, so it is told once
            guard case .review(let video, let n) = route else { return make("Ready to review", .review, route: route) }
            return make("Ready to review", .review, route: route, keys: ["\(video):v\(n ?? 1)"])
        }
    }

    /// The phone's New edits over the server's rows. While the phone still has its part to do (starting, clips going
    /// up, a Try again) its row is the one shown. Once the server has the edit, a row the server gives for it says
    /// more. A ready one shows until its Review video is opened; then Review's own row tells how it goes.
    static func phone(_ edits: [(edit: PhoneEdit, state: EditState)], over rows: [ChatRow], opened: Set<String>) -> [ChatRow] {
        var all = rows
        for (edit, state) in edits {
            let row = Self.row(edit, state)
            let same = all.firstIndex { $0.id == row.id }
            switch state {
            case .editing, .stuck: if same != nil { continue }
            case .ready: if opened.contains(row.id) { continue }
            case .starting, .uploading, .failed: break
            }
            if let same { all[same] = row } else { all.append(row) }
        }
        return all
    }
}
