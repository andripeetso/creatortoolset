import AVKit
import Photos
import SwiftUI

/// The Media Library side of the Upload tab. On a server whose library is a plug-in's catalog: its finished footage,
/// searched like the website, each clip playable and savable to Photos. Elsewhere: the server's own library.
struct LibraryBrowse: View {
    @Binding var segment: UploadView.Segment
    @ObservedObject private var plugins = ServerPlugins.shared
    @ObservedObject private var access = ToolsetAccess.shared

    var body: some View {
        if Self.catalog(plugins, access) {
            CatalogBrowse(segment: $segment)
        } else {
            ServerLibraryGrid(segment: $segment)
        }
    }

    /// The catalog's footage sits behind the account's kids-footage switch on the server.
    static func catalog(_ plugins: ServerPlugins, _ access: ToolsetAccess) -> Bool {
        (plugins.known.catalog || debugArg("UploadRoute") == "catalog") && access.allows("kids-footage")
    }
}

// MARK: The catalog

/// One finished clip of the catalog: censored, certified and delivered, so it can be played and saved.
struct CatalogClip: Identifiable, Hashable, Codable {
    let id: Int
    /// The certified render: a re-censored clip gets a new one, and with it a new thumbnail.
    let revision: String
    let filename: String
    let isVideo: Bool
    let duration: Double
    let shotAt: Date?
    let summary: String
    /// Width / height, or nil when the catalog does not know.
    let aspect: Double?

    /// nil for anything the phone should not offer: not processed yet, a content reel (this is for footage), or an
    /// edit or original hidden behind the version the website's grid shows.
    init?(_ json: [String: Any]) {
        guard let id = (json["id"] as? NSNumber)?.intValue,
              json["safety_status"] as? String == "Certified",
              json["delivery_ready"] as? Bool == true,
              json["category"] as? String != "content" else { return nil }
        if !(json["version_group_id"] is NSNull), json["version_group_id"] != nil, json["version_primary"] as? Bool == false { return nil }
        let type = json["media_type"] as? String ?? "video"
        guard type == "video" || type == "image" else { return nil }
        self.id = id
        revision = (json["active_generation_id"] as? CustomStringConvertible)?.description ?? ""
        isVideo = type == "video"
        filename = (json["new_filename"] as? String) ?? (json["original_filename"] as? String) ?? "clip \(id)"
        duration = (json["duration_seconds"] as? NSNumber)?.doubleValue ?? 0
        shotAt = (json["shot_at"] as? String).flatMap { ISO8601DateFormatter().date(from: $0) }
        summary = (json["action_summary"] as? String) ?? (json["description"] as? String) ?? ""
        let width = (json["video_width"] as? NSNumber)?.doubleValue ?? 0
        let height = (json["video_height"] as? NSNumber)?.doubleValue ?? 0
        aspect = width > 0 && height > 0 ? width / height : nil
    }

    /// The name without its extension, underscores as spaces.
    var title: String { (filename as NSString).deletingPathExtension.replacingOccurrences(of: "_", with: " ") }

    /// Its grid picture; the render is in the address, so a re-censored clip's new picture is fetched, not the kept one.
    var thumbnail: String { CatalogAPI.path("api/clips/\(id)/thumbnail?r=\(revision)") }
}

/// All / Videos / Photos.
enum CatalogMedia: String, CaseIterable, Identifiable {
    case all = "All"
    case videos = "Videos"
    case photos = "Photos"
    var id: String { rawValue }
    var query: String? { self == .videos ? "video" : self == .photos ? "image" : nil }
    func matches(_ clip: CatalogClip) -> Bool { self == .all || (self == .videos) == clip.isVideo }
}

/// What the Media Library side already fetched, kept on disk per server and account: the newest-first list and the
/// last searches, each shown at once and checked again once it is 10 minutes old (the server answers "unchanged" to a
/// matching ETag without resending the list). Plus recent search words.
@MainActor
final class BrowseCache {
    nonisolated static let refreshAfter: TimeInterval = 10 * 60
    nonisolated static let keepSearches = 40
    nonisolated static let keepRecent = 12
    static let latestKey = "latest"

    struct Entry: Codable {
        var clips: [CatalogClip]
        var etag: String?
        var checkedAt: Date
        var usedAt: Date

        func isFresh(now: Date = Date()) -> Bool { checkedAt > now.addingTimeInterval(-BrowseCache.refreshAfter) }
    }

    private struct Saved: Codable {
        var entries: [String: Entry]
        var recent: [String]
    }

    private var saved = Saved(entries: [:], recent: [])
    private let url: URL

    init(url: URL) {
        self.url = url
        if let data = try? Data(contentsOf: url), let loaded = try? JSONDecoder().decode(Saved.self, from: data) { saved = loaded }
    }

    private static var made: BrowseCache?
    /// The server in use's.
    static var shared: BrowseCache {
        let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("browse-\(API.current?.cacheKey ?? "none").json")
        if let made, made.url == url { return made }
        let fresh = BrowseCache(url: url)
        made = fresh
        return fresh
    }

    nonisolated static func searchKey(_ words: String, _ media: CatalogMedia) -> String { "\(media.rawValue)|\(words.lowercased())" }

    var recent: [String] { saved.recent }

    func entry(_ key: String) -> Entry? { saved.entries[key] }

    func store(_ key: String, clips: [CatalogClip], etag: String?, now: Date = Date()) {
        saved.entries[key] = Entry(clips: clips, etag: etag, checkedAt: now, usedAt: now)
        let searches = saved.entries.filter { $0.key != Self.latestKey }
        if searches.count > Self.keepSearches {
            for (old, _) in searches.sorted(by: { $0.value.usedAt > $1.value.usedAt }).dropFirst(Self.keepSearches) {
                saved.entries[old] = nil
            }
        }
        persist()
    }

    /// The server said nothing changed.
    func confirm(_ key: String, now: Date = Date()) {
        saved.entries[key]?.checkedAt = now
        saved.entries[key]?.usedAt = now
        persist()
    }

    func remember(search words: String) {
        let trimmed = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        saved.recent.removeAll { $0.caseInsensitiveCompare(trimmed) == .orderedSame }
        saved.recent = Array(([trimmed] + saved.recent).prefix(Self.keepRecent))
        persist()
    }

    func clearRecent() {
        saved.recent = []
        persist()
    }

    /// One queue, so saves land in order.
    private static let writer = DispatchQueue(label: "BrowseCache.writer", qos: .utility)

    private func persist() {
        let snapshot = saved
        let url = self.url
        Self.writer.async { if let data = try? JSONEncoder().encode(snapshot) { try? data.write(to: url, options: .atomic) } }
    }
}

/// The catalog's finished footage, searched like the website (keywords and meaning), newest first when the field is
/// empty.
struct CatalogBrowse: View {
    @Binding var segment: UploadView.Segment
    @EnvironmentObject private var servers: Servers
    @State private var query = ""
    @State private var submitted = ""
    @AppStorage("browse.media") private var mediaChoice = CatalogMedia.all.rawValue
    @State private var clips: [CatalogClip] = []
    @State private var recent: [String] = BrowseCache.shared.recent
    /// Only when nothing is shown yet; a check in the background keeps the grid as it is.
    @State private var loading = false
    @State private var error: String?
    @State private var loadTask: Task<Void, Never>?
    @State private var opened: CatalogClip?
    @FocusState private var searching: Bool
    /// The server and workspace this screen opened in: its list and pictures ask there.
    @State private var api: API?

    private var media: CatalogMedia { CatalogMedia(rawValue: mediaChoice) ?? .all }
    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                UploadSegments(segment: $segment, shown: true)
                searchField
                if searching && query.isEmpty && !recent.isEmpty {
                    recentSearches
                } else {
                    HStack(spacing: 6) {
                        ForEach(CatalogMedia.allCases) { choice in
                            FilterChip(title: choice.rawValue, on: media == choice) { mediaChoice = choice.rawValue }
                        }
                    }
                }
                if let error {
                    HStack {
                        Label(error, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
                        Spacer()
                        Button("Try again") { load(force: true) }.font(.footnote.weight(.semibold)).frame(minHeight: 44)
                    }
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 6)
            if loading && clips.isEmpty {
                ProgressView().padding(.top, 60)
            } else if clips.isEmpty && error == nil && !loading {
                Text(submitted.isEmpty ? "Nothing here yet" : "Nothing for “\(submitted)”")
                    .font(.subheadline).foregroundStyle(.secondary).padding(.top, 60)
            }
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(clips) { clip in
                    Button { opened = clip } label: { CatalogCell(clip: clip, api: api) }.buttonStyle(.plain)
                }
            }
            .opacity(loading && !clips.isEmpty ? 0.4 : 1)
            .padding(.bottom, 20)
        }
        .scrollDismissesKeyboard(.immediately)
        .onChange(of: query) { _, new in if new.isEmpty && !submitted.isEmpty { load() } }
        .onChange(of: mediaChoice) { _, _ in load() }
        .refreshable {
            load(force: true)
            await loadTask?.value
        }
        .navigationDestination(item: $opened) { CatalogDetailView(clip: $0, api: api) }
        .task {
            // a debug build searches by itself and can show the recent searches: -UploadSearch words, -UploadShow recents
            if let words = debugArg("UploadSearch") { query = words }
            if clips.isEmpty { load() }
            if debugArg("UploadShow") == "recents" {
                try? await Task.sleep(for: .seconds(2))
                query = ""
                searching = true
            }
        }
        .onChange(of: clips.count) { _, _ in
            // and opens a clip: -Open <clip id>
            if opened == nil, let id = debugArg("Open").flatMap(Int.init) { opened = clips.first { $0.id == id } }
        }
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("Search the library", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused($searching)
                .onSubmit { load() }
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear the search")
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 44)
        .background(Color(.secondarySystemBackground), in: Capsule())
    }

    private var recentSearches: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(recent, id: \.self) { words in
                Button {
                    query = words
                    searching = false
                    load()
                } label: {
                    Label(words, systemImage: "clock.arrow.circlepath")
                        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            Button("Clear recent searches", role: .destructive) {
                BrowseCache.shared.clearRecent()
                recent = []
            }
            .font(.footnote)
            .frame(minHeight: 44)
        }
    }

    /// Shows what the phone has at once, then asks the server again only when that is 10+ minutes old (or on pull).
    private func load(force: Bool = false) {
        loadTask?.cancel()
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let media = self.media
        submitted = words
        if !words.isEmpty {
            BrowseCache.shared.remember(search: words)
            recent = BrowseCache.shared.recent
        }
        loadTask = Task { await fetch(words, media: media, force: force) }
    }

    private func fetch(_ words: String, media: CatalogMedia, force: Bool) async {
        if api == nil { api = servers.api }
        guard let api else { return }
        let cache = BrowseCache.shared
        // the newest-first list is one list for all three chips, filtered here
        let key = words.isEmpty ? BrowseCache.latestKey : BrowseCache.searchKey(words, media)
        let shown: ([CatalogClip]) -> [CatalogClip] = { words.isEmpty ? $0.filter(media.matches) : $0 }
        let cached = cache.entry(key)
        error = nil
        if let cached {
            clips = shown(cached.clips)
            if cached.isFresh() && !force { return }
        } else {
            loading = true
        }
        defer { if !Task.isCancelled { loading = false } }
        do {
            let answer = try await CatalogAPI(api: api).clips(search: words, media: words.isEmpty ? .all : media, etag: cached?.etag)
            guard !Task.isCancelled else { return }
            if let answer {
                cache.store(key, clips: answer.clips, etag: answer.etag)
                clips = shown(answer.clips)
            } else {
                cache.confirm(key)
            }
        } catch {
            guard !Task.isCancelled else { return }
            // offline with something on screen: it stays
            if cached == nil || (error as? APIError) == .signedOut { self.error = error.localizedDescription }
        }
    }
}

struct CatalogCell: View {
    let clip: CatalogClip
    let api: API?

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay(ToolsetImage(path: clip.thumbnail, api: api))
            .clipped()
            .overlay(alignment: .bottomLeading) {
                if clip.isVideo {
                    Text(clock(clip.duration))
                        .font(.caption2.monospacedDigit().bold())
                        .foregroundStyle(.white)
                        .shadow(radius: 2)
                        .padding(4)
                }
            }
            .contentShape(Rectangle())
            .accessibilityLabel(clip.title)
    }
}

/// Saving shows a live percentage; the download reports from a background queue.
@MainActor
final class SaveProgress: ObservableObject {
    @Published var fraction: Double?
}

struct CatalogDetailView: View {
    let clip: CatalogClip
    /// The browse screen's server and workspace: its pictures, player and saving ask there.
    let api: API?
    @EnvironmentObject private var servers: Servers
    @StateObject private var progress = SaveProgress()
    @State private var player: AVPlayer?
    @State private var playError: String?
    @State private var saved = false
    @State private var saveError: String?
    @State private var sharp: UIImage?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                preview
                    .frame(maxWidth: .infinity)
                    .aspectRatio(clip.aspect ?? 1, contentMode: .fit)
                    .frame(maxHeight: 560)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                if let shotAt = clip.shotAt {
                    Text(shotAt.formatted(date: .long, time: .shortened)).font(.subheadline).foregroundStyle(.secondary)
                }
                if !clip.summary.isEmpty { Text(clip.summary).font(.subheadline) }
                saveButton
                if let saveError {
                    Label(saveError, systemImage: "exclamationmark.triangle.fill").font(.footnote).foregroundStyle(.red)
                }
            }
            .padding()
        }
        // the clip's own name; one the catalog never named is just a video or a photo
        .navigationTitle(clip.filename == "clip \(clip.id)" ? (clip.isVideo ? "Video" : "Photo") : clip.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .task { await preparePlayer() }
        .onDisappear { player?.pause() }
    }

    @ViewBuilder private var preview: some View {
        if clip.isVideo {
            if let player {
                NativePlayer(player: player)
            } else if let playError {
                ZStack {
                    Rectangle().fill(Color(.secondarySystemBackground))
                    Label(playError, systemImage: "exclamationmark.triangle").font(.footnote).padding()
                }
            } else {
                ToolsetImage(path: clip.thumbnail, contentMode: .fit, api: api).overlay { ProgressView() }
            }
        } else {
            // the kept grid picture at once, the sharp preview over it
            ZStack {
                ToolsetImage(path: clip.thumbnail, contentMode: .fit, api: api)
                if let sharp { Image(uiImage: sharp).resizable().scaledToFit() }
            }
            .task { sharp = await ToolsetImages.shared.image(CatalogAPI.path("api/clips/\(clip.id)/image-preview"), maxPixels: 2400, api: api) }
        }
    }

    private var saveButton: some View {
        Button {
            Task { await save() }
        } label: {
            Group {
                if let fraction = progress.fraction {
                    HStack(spacing: 10) {
                        ProgressView(value: fraction).tint(.white)
                        Text("\(Int(fraction * 100))%").monospacedDigit()
                    }
                } else if saved {
                    Label("Saved to Photos", systemImage: "checkmark.circle.fill")
                } else {
                    Label("Save to Photos", systemImage: "square.and.arrow.down")
                }
            }
            .font(.headline)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
        }
        .buttonStyle(.borderedProminent)
        .disabled(progress.fraction != nil || saved)
    }

    private func preparePlayer() async {
        guard clip.isVideo, player == nil, let api else { return }
        do {
            // a short-lived signed link straight to the video edge; no sign-in goes with it
            let player = AVPlayer(url: try await CatalogAPI(api: api).videoURL(clip.id))
            self.player = player
            player.play()
        } catch {
            playError = error.localizedDescription
        }
    }

    private func save() async {
        guard let api else { return }
        saveError = nil
        progress.fraction = 0
        let progress = self.progress
        do {
            let assetId = try await CatalogAPI(api: api).saveToPhotos(clip) { fraction in
                Task { @MainActor in if progress.fraction != nil { progress.fraction = fraction } }
            }
            // the camera roll shows it as uploaded and never offers it back
            LibraryIndex.shared.markInLibrary([assetId], server: servers.currentId)
            saved = true
        } catch {
            saveError = error.localizedDescription
        }
        progress.fraction = nil
    }
}

// MARK: The server's own library

/// A Media Library item (`GET /api/library/:id/assets`).
struct Asset: Decodable, Identifiable, Hashable {
    let id: String
    let kind: String
    let title: String
    let versionId: String
    let thumbUrl: String?
    let state: String
}

/// A Media Library folder (`GET /api/library/:id/collections`): a plain one holds clips, a saved search (`smart`) runs its
/// query when opened. Only what this screen reads.
struct LibraryFolder: Decodable, Identifiable, Hashable {
    struct Query: Decodable, Hashable {
        let q: String?
        let kind: [String]?
        let roll: String?
    }
    let id: String
    let name: String
    let parentId: String?
    let kind: String
    let query: Query?
    let count: Int?
}

/// What the server's Media Library page reads (`apps/captions/src/pages/LibraryPage.tsx`), for the phone's grid: the
/// workspace's library, its folders, and a page of clips in a folder or the search's answer. Every request goes with
/// the API it is given, so with that API's workspace.
enum LibraryListing {
    struct Page: Decodable {
        let items: [Asset]
        let next: String?
    }
    private struct Libraries: Decodable {
        struct Library: Decodable {
            let id: String
            let name: String
        }
        let libraries: [Library]
    }
    private struct Folders: Decodable { let collections: [LibraryFolder] }
    private struct Hit: Decodable { let asset: Asset }

    /// The workspace's library (the first, as the page opens), with its name for the trail.
    static func library(_ api: API, session: URLSession = API.session) async throws -> (id: String, name: String)? {
        let answer = try JSONDecoder().decode(Libraries.self, from: try await api.data(api.request("/api/library"), session: session))
        return answer.libraries.first.map { ($0.id, $0.name) }
    }

    /// Its folders, flat; Finals is its own tool and is left out, as on the page (lib/library.ts isFinals).
    static func folders(_ api: API, library: String, session: URLSession = API.session) async throws -> [LibraryFolder] {
        let path = "/api/library/\(escaped(library))/collections"
        return try JSONDecoder().decode(Folders.self, from: try await api.data(api.request(path), session: session)).collections
            .filter { !($0.kind == "manual" && $0.parentId == nil && $0.name == "Finals") }
    }

    /// The folders shown in `open` (nil: the top): the ones in it, or while searching every one below it whose name
    /// matches. Folders first, then saved searches, each A to Z (pages/library/folders.ts foldersAt).
    static func foldersAt(_ all: [LibraryFolder], open: String?, search: String) -> [LibraryFolder] {
        let ids = Set(all.map(\.id))
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let words = search.trimmingCharacters(in: .whitespaces).lowercased()
        let here = words.isEmpty
            ? all.filter { ($0.parentId.flatMap { ids.contains($0) ? $0 : nil }) == open }
            : all.filter { f in f.id != open && f.name.lowercased().contains(words) && (open == nil || trail(byId, to: f.id).contains { $0.id == open }) }
        return here.sorted { a, b in
            if (a.kind == "smart") != (b.kind == "smart") { return b.kind == "smart" }
            return a.name.localizedStandardCompare(b.name) == .orderedAscending
        }
    }

    /// The folders from the top down to `id` (the page's trail back up).
    static func trail(_ all: [LibraryFolder], to id: String?) -> [LibraryFolder] {
        trail(Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a }), to: id)
    }

    private static func trail(_ byId: [String: LibraryFolder], to id: String?) -> [LibraryFolder] {
        var out: [LibraryFolder] = []
        var at = id.flatMap { byId[$0] }
        while let f = at, !out.contains(f) {
            out.insert(f, at: 0)
            at = f.parentId.flatMap { byId[$0] }
        }
        return out
    }

    /// A page of clips: with words (a saved search's own with the ones typed) the search's answer, best first, in one
    /// page; else 60 at a time, newest first, of the open folder, or at the top the clips in no folder.
    static func page(_ api: API, library: String, open: LibraryFolder?, search: String, cursor: String? = nil,
                     session: URLSession = API.session) async throws -> Page {
        let smart = open?.kind == "smart" ? open?.query : nil
        let words = [smart?.q, search.trimmingCharacters(in: .whitespaces)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
        var parts = URLComponents()
        if words.isEmpty {
            parts.percentEncodedPath = "/api/library/\(escaped(library))/assets"
            parts.queryItems = [URLQueryItem(name: "limit", value: "60"),
                                open.map { URLQueryItem(name: "collectionId", value: $0.id) } ?? URLQueryItem(name: "unfiled", value: "1")]
            if let cursor { parts.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
        } else {
            parts.percentEncodedPath = "/api/library/\(escaped(library))/search"
            parts.queryItems = [URLQueryItem(name: "q", value: words)]
            if let kind = smart?.kind?.first { parts.queryItems?.append(URLQueryItem(name: "kind", value: kind)) }
            if let roll = smart?.roll { parts.queryItems?.append(URLQueryItem(name: "roll", value: roll)) }
            if let open, smart == nil { parts.queryItems?.append(URLQueryItem(name: "collectionId", value: open.id)) }
        }
        // a "+" in the words is a plus, not a space, on the server
        let path = (parts.string ?? "").replacingOccurrences(of: "+", with: "%2B")
        let data = try await api.data(api.request(path), session: session)
        if words.isEmpty { return try JSONDecoder().decode(Page.self, from: data) }
        var seen = Set<String>()
        let hits = try JSONDecoder().decode([Hit].self, from: data).map(\.asset).filter { seen.insert($0.id).inserted }
        return Page(items: hits, next: nil)
    }

    private static func escaped(_ id: String) -> String { id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? id }
}

/// The server's own Media Library: its folders (open one, back up the trail) and its clips, newest first, 60 at a
/// time; the search box asks the server's search, as the website's page does.
struct ServerLibraryGrid: View {
    @Binding var segment: UploadView.Segment
    @EnvironmentObject private var servers: Servers
    @State private var library: (id: String, name: String)?
    /// nil until read (an empty list is a library with no folders)
    @State private var folders: [LibraryFolder]?
    @State private var openId: String?
    @State private var assets: [Asset] = []
    @State private var next: String?
    @State private var loaded = false
    @State private var error: String?
    @State private var open: Asset?
    /// The server and workspace this screen opened in: its list and pictures ask there.
    @State private var api: API?
    @Environment(\.libraryQuery) private var query

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]
    private var openFolder: LibraryFolder? { folders?.first { $0.id == openId } }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty || openFolder?.query?.q?.isEmpty == false }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                UploadSegments(segment: $segment, shown: true)
                if let error { Problem(text: error) }
                if openId != nil { trail }
                ForEach(LibraryListing.foldersAt(folders ?? [], open: openId, search: query)) { folder in
                    Button { openId = folder.id } label: {
                        HStack {
                            Image(systemName: folder.kind == "smart" ? "magnifyingglass" : "folder").foregroundStyle(.tint).frame(width: 24)
                            Text(folder.name).foregroundStyle(.primary).lineLimit(1)
                            Spacer()
                            if let count = folder.count { Text("\(count)").foregroundStyle(.secondary) }
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                        .padding(.vertical, 8)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Divider()
                }
            }
            .padding(.horizontal)
            .padding(.bottom, 6)
            if loaded && assets.isEmpty && error == nil {
                // the website's own lines (LibraryPage.tsx)
                Text(searching ? "No clips found" : openId != nil ? "No clips in this folder" : "No clips")
                    .font(.subheadline).foregroundStyle(.secondary).padding(.top, 60)
            } else if !loaded {
                ProgressView().padding(.top, 60)
            }
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(assets) { asset in
                    Button { open = asset } label: {
                        Color.clear
                            .aspectRatio(1, contentMode: .fit)
                            .overlay(ToolsetImage(path: asset.thumbUrl, api: api))
                            .clipped()
                            .overlay(alignment: .bottomTrailing) {
                                if asset.state == "processing" {
                                    ProgressView().padding(4)
                                } else if asset.kind == "video" {
                                    Image(systemName: "play.fill").font(.caption).foregroundStyle(.white).padding(4).shadow(radius: 2)
                                }
                            }
                    }
                    .buttonStyle(.plain)
                    .onAppear { if asset == assets.last, next != nil { Task { await load(more: true) } } }
                }
            }
        }
        .task(id: "\(query)|\(openId ?? "")") {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(300)) }   // one read when typing stops
            guard !Task.isCancelled else { return }
            await load(more: false)
        }
        .refreshable { await load(more: false, folders: true) }
        .sheet(item: $open) { AssetView(asset: $0, api: api) }
    }

    /// Back up: the library, then each folder above the open one (the page's FolderTrail).
    private var trail: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                Button(library?.name ?? "Library") { openId = nil }
                ForEach(LibraryListing.trail(folders ?? [], to: openId)) { f in
                    Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary)
                    if f.id == openId { Text(f.name).fontWeight(.semibold) } else { Button(f.name) { openId = f.id } }
                }
            }
            .font(.subheadline)
        }
    }

    private func load(more: Bool, folders reread: Bool = false) async {
        if api == nil { api = servers.api }
        guard let api else { return }
        defer { loaded = true }
        #if DEBUG
        if PhoneDemo.on { return assets = PhoneDemo.assets(query) }
        #endif
        do {
            if library == nil { library = try await LibraryListing.library(api) }
            guard let library else { return }
            if reread || folders == nil { folders = try await LibraryListing.folders(api, library: library.id) }
            let page = try await LibraryListing.page(api, library: library.id, open: openFolder, search: query, cursor: more ? next : nil)
            assets = more ? assets + page.items : page.items
            next = page.next
            error = nil
        } catch let e as URLError where e.code == .cancelled {   // the search changed while it was asked
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// One item of the server's library: it plays, or shows its picture, and saves to Photos.
private struct AssetView: View {
    let asset: Asset
    /// The library screen's server and workspace.
    let api: API?
    @State private var player: AVPlayer?
    @State private var saving = false
    @State private var saved = false
    @State private var problem: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 14) {
                Group {
                    if asset.kind == "video" || asset.kind == "audio", let player {
                        NativePlayer(player: player)
                    } else {
                        RemoteImage(path: "/api/library/media/\(asset.versionId)/source", api: api).scaledToFit()
                    }
                }
                .frame(maxHeight: .infinity)
                if asset.kind == "video" || asset.kind == "image" {
                    WideButton(title: saved ? "Saved to Photos" : saving ? "Saving…" : "Save to Photos",
                               systemImage: saved ? "checkmark.circle.fill" : "square.and.arrow.down") { Task { await save() } }
                        .disabled(saving || saved)
                        .padding(.horizontal)
                }
                if let problem { Problem(text: problem).padding(.horizontal) }
            }
            .navigationTitle(asset.title)
            .navigationBarTitleDisplayMode(.inline)
        }
        .onAppear {
            player = api?.player("/api/library/media/\(asset.versionId)/play")
            player?.play()
        }
        .onDisappear { player?.pause() }
    }

    private func save() async {
        guard let api else { return }
        saving = true
        defer { saving = false }
        let name = (asset.title as NSString).pathExtension.isEmpty ? asset.title + (asset.kind == "video" ? ".mp4" : ".jpg") : asset.title
        do {
            try await api.saveToPhotos("/api/library/media/\(asset.versionId)/source", filename: name)
            saved = true
            problem = nil
        } catch {
            problem = error.localizedDescription
        }
    }
}
