import Foundation

// Compiled into the app and the Share extension: the workspace this phone works in, per server and account.

/// The phone's own pick of workspace on each server and account. Kept in the shared Keychain (the Share extension sends
/// it too), never written to the server: the server's stored current workspace is the desktop's, and a pick here
/// moves nothing there. Every request names it in `header`.
enum WorkspacePick {
    static let header = "X-CT-Workspace"

    static func account(server: String, username: String?) -> String { "workspace|\(server)|\(username ?? "local")" }

    static func get(server: String, username: String?) -> String? {
        Keychain.get(account(server: server, username: username))
    }

    /// nil forgets it (the server's own rule applies again until one is picked).
    static func set(_ id: String?, server: String, username: String?) {
        Keychain.set(account(server: server, username: username), id)
    }

    /// Where the phone starts on a server: its own pick while the account still has it; a pick that is gone (deleted,
    /// or a member lost it) falls to the first workspace; nothing picked yet starts where the computer is.
    static func resolve(kept: String?, ids: [String], current: String?) -> String? {
        if let kept, ids.contains(kept) { return kept }
        if kept == nil, let current, ids.contains(current) { return current }
        return ids.first
    }
}
