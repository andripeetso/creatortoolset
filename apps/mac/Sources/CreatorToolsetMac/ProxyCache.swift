import Foundation

// The proxy cache this Mac's worker keeps for a server elsewhere (api/work/cache.ts): <the server's relay folder>/work/
// proxies/<account>/<version>.mp4, one folder per account signed in to that server; kept until emptied. The page plays
// from it (Available offline: it plays without internet) through ctlocal://media, without a grant, as it is this app's
// own data. Only from the folder of the account the window is signed in to on that server, as that server said
// (GET /api/auth/check with the window's cookies, never anything from the page), and only for a page of that server.
// Remembered per server while the app runs, so it still plays when the server doesn't answer.

/// The Download location (UNIFIED-PRD M15): the folder a worker keeps its download cache in, passed as CT_PROXY_DIR
/// (api/work/cache.ts). Nil = the default folder under the server's data.
enum DownloadLocation {
    static let key = "downloadLocation"

    static func path(_ defaults: UserDefaults = .standard) -> String? {
        guard let p = defaults.string(forKey: key), !p.isEmpty else { return nil }
        return p
    }
}

enum ProxyCacheMoveError: Error, Equatable {
    case noSpace(needed: Int64, free: Int64)
}

/// A Download location change (UNIFIED-PRD M15): the cache's files move to the new folder, kept ones too (a kept proxy
/// may be the only copy). Nothing is moved unless the new disk has room for all of them.
enum ProxyCacheMove {
    static func freeSpace(_ folder: URL) -> Int64? {
        (try? folder.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey]))?.volumeAvailableCapacityForImportantUsage
    }

    static func move(from: URL, to: URL, free: (URL) -> Int64? = freeSpace) throws {
        guard from.standardizedFileURL.path != to.standardizedFileURL.path else { return }
        let fm = FileManager.default
        // the enumerator returns real paths (/var → /private/var), so the base is resolved too, or the relative paths come out wrong
        let root = from.resolvingSymlinksInPath()
        let files = (fm.enumerator(at: root, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey])?.allObjects as? [URL] ?? [])
            .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true }
        let needed = files.reduce(Int64(0)) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
        try fm.createDirectory(at: to, withIntermediateDirectories: true)
        let have = free(to) ?? 0
        guard needed == 0 || have >= needed else { throw ProxyCacheMoveError.noSpace(needed: needed, free: have) }
        for file in files {
            let rel = String(file.resolvingSymlinksInPath().path.dropFirst(root.path.count)).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            let target = to.appendingPathComponent(rel)
            try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            // a file already at the target is that folder's own: never overwritten
            if !fm.fileExists(atPath: target.path) { try fm.moveItem(at: file, to: target) }
        }
    }
}

enum ProxyCache {
    /// Where this server's cache is when no Download location is chosen (api/work/cache.ts: DATA_DIR/proxies).
    static func defaultRoot(server: URL, localData: URL?) -> URL {
        relayFolder(for: server, localData: localData).appendingPathComponent("work/proxies", isDirectory: true)
    }

    /// A server's relay folder (ClaudeRequest.swift relayFolder); the tests give their own.
    static var relay: (URL) -> URL = { relayFolder(for: $0, localData: nil) }

    private static let lock = NSLock()
    /// per server (its relay folder's path): the account the window was last signed in to there
    private static var accounts: [String: String] = [:]

    private static func key(_ server: URL) -> String { relay(server).path }

    /// What GET /api/auth/check says: the account signed in; none while an admin views as another account.
    struct Check: Decodable {
        let authed: Bool
        let user: User?
        let viewedBy: String?
        struct User: Decodable { let username: String }
        var account: String? { authed && viewedBy == nil ? user?.username : nil }
    }

    static func remember(_ account: String?, for server: URL) {
        lock.withLock { accounts[key(server)] = account }
    }

    /// The window's account on `site`'s server, asked of the server and remembered; when the server doesn't answer
    /// (`offline`), the one remembered. Nil when signed out or the answer is not one.
    static func account(_ site: Site) async -> (name: String?, offline: Bool) {
        do {
            let check: Check = try await site.get("/api/auth/check", timeout: 4)
            remember(check.account, for: site.base)
            return (check.account, false)
        } catch is URLError {
            return (lock.withLock { accounts[key(site.base)] }, true)
        } catch {
            remember(nil, for: site.base)
            return (nil, false)
        }
    }

    /// An account's cache folder on a server; nil for a name that isn't a plain account name (api/users.ts USERNAME_RE,
    /// which its folder name, encodeURIComponent of it, leaves as it is).
    static func folder(server: URL, account: String) -> URL? {
        guard !account.isEmpty, account.count <= 100,
              account.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }) else { return nil }
        return relay(server).appendingPathComponent("work/proxies/\(account)", isDirectory: true)
    }

    /// The cache folder a page at `page` may play from: its server's, of the account last said signed in there.
    static func allowed(page: URL?) -> String? {
        guard let page, page.scheme == "http" || page.scheme == "https" else { return nil }
        guard let account = lock.withLock({ accounts[key(page)] }) else { return nil }
        return folder(server: page, account: account)?.path
    }

    /// The ctlocal://media address of a version's proxy in `folder`, only when the media gate serves it from there (its
    /// real path inside the folder); nil when it isn't there (a download still going is a .part).
    static func url(_ version: String, in folder: URL) -> String? {
        guard !version.isEmpty, !version.contains("/"), !version.hasPrefix(".") else { return nil }
        let file = folder.appendingPathComponent("\(version).mp4").path
        guard case .file = MediaFiles.gate(file, granted: [], roots: [], cache: folder.path) else { return nil }
        return MediaFiles.url(path: file).absoluteString
    }
}
