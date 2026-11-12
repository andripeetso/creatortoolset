import AVKit
import SwiftUI
import UIKit

// MARK: The core library's Finals

struct LibrarySummary: Decodable {
    let id: String
    let name: String
}

/// A piece of the Media Library (`apps/captions/contracts/library.ts` `Piece`): versions grouped with one winner.
struct Piece: Decodable, Identifiable, Hashable {
    struct Item: Decodable, Hashable, Identifiable {
        let id: String
        let label: String?
        let winner: Bool
        let versionId: String?
        let position: Int?
    }

    let id: String
    let label: String
    let items: [Item]
    let coverUrl: String?

    /// The winner, else the first version the library holds.
    var main: Item? { items.first { $0.winner && $0.versionId != nil } ?? items.first { $0.versionId != nil } }
    var cover: String? { coverUrl ?? main?.versionId.map { "/api/library/media/\($0)/thumb" } }
}

extension API {
    func firstLibrary() async throws -> LibrarySummary? {
        struct Answer: Decodable { let libraries: [LibrarySummary] }
        let answer: Answer = try await get("/api/library")
        return answer.libraries.first
    }

    /// The pieces in the library's Finals collection (`apps/captions/api/library/finals.ts`); none before one is sent.
    func finals() async throws -> [Piece] {
        struct Collections: Decodable {
            struct Collection: Decodable { let id: String; let name: String }
            let collections: [Collection]
        }
        struct Pieces: Decodable { let pieces: [Piece] }
        guard let library = try await firstLibrary() else { return [] }
        let all: Collections = try await get("/api/library/\(library.id)/collections")
        guard let finals = all.collections.first(where: { $0.name == "Finals" }) else { return [] }
        let answer: Pieces = try await get("/api/library/\(library.id)/pieces?collectionId=\(finals.id)")
        return answer.pieces.reversed()
    }
}

// MARK: One list for both kinds of server

/// The Finals list the screen shows. A plug-in's server sends it in this shape (snake case, whole-number ids:
/// `Studio/FinalsStudio.swift`); the core library's Finals collection is turned into it (`init(core:)`).
struct FinalsData: Codable, Equatable {
    @Lossy var folders: [Folder]
    @Lossy var stacks: [Piece]

    struct Folder: Codable, Hashable, Identifiable {
        @FlexID var id: String
        let name: String
    }

    struct Piece: Codable, Hashable, Identifiable {
        @FlexID var id: String
        let title: String
        let kind: String?
        let folderId: FlexID?
        let winnerClipId: FlexID?
        let hasCover: FlexBool?
        /// The picture picked for the piece, when the server names it.
        var coverUrl: String?
        let createdAt: String?
        let updatedAt: String?
        /// A version still being processed has no clip yet and is left out.
        @Lossy var versions: [Version]
        let posts: Posts?
    }

    struct Version: Codable, Hashable, Identifiable {
        /// The id its picture and file are asked for by (`/api/library/media/<clipId>/…`).
        @FlexID var clipId: String
        let label: String?
        let position: Int?
        let filename: String?
        let duration: Double?
        let mediaType: String?
        let captions: Bool?
        let madeAt: String?
        let name: String?
        let note: String?
        let width: Int?
        let height: Int?
        /// The piece item it is (the core library keys its post descriptions by it).
        var itemId: String?
        var id: String { clipId }
        /// What the version's own post description is filed under.
        var key: String { itemId ?? clipId }
        /// The file name (a clip without one gets its id).
        var file: String { filename ?? "clip-\(clipId).mp4" }
        var isImage: Bool { mediaType == "image" }

        /// What the version is called: the name it was given, else its letter, else its file.
        var title: String {
            let given = [name, label].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
            return withoutMediaExtension(given ?? file)
        }

        /// "Captions · 0:38 · his note": what tells two versions apart.
        var facts: String {
            [captions == true ? "Captions" : captions == false ? "No captions" : nil,
             duration.flatMap { $0 > 0 ? clock($0) : nil },
             note.flatMap { $0.isEmpty ? nil : $0 }].compactMap { $0 }.joined(separator: " · ")
        }
    }

    struct Posts: Codable, Hashable {
        let published: Int?
        let trial: Int?
        let firstPostedAt: String?
        let maxViews: Int?
    }
}

extension FinalsData {
    /// Only what can be shown: a final sent a moment ago has no version with a clip yet.
    var showable: FinalsData {
        var copy = self
        copy.stacks.removeAll { $0.versions.isEmpty }
        return copy
    }

    /// The core library's Finals collection: no folders, and the versions the library holds.
    init(core pieces: [ToolsetFinalsPiece]) {
        folders = []
        stacks = pieces.map { piece in
            Piece(id: piece.id, title: piece.label, kind: nil, folderId: nil,
                  winnerClipId: piece.main?.versionId.map(FlexID.init(wrappedValue:)), hasCover: nil,
                  coverUrl: piece.coverUrl, createdAt: nil, updatedAt: nil,
                  versions: piece.items.compactMap { item in
                      item.versionId.map {
                          Version(clipId: $0, label: item.label, position: item.position, filename: nil, duration: nil,
                                  mediaType: nil, captions: nil, madeAt: nil, name: nil, note: nil, width: nil,
                                  height: nil, itemId: item.id)
                      }
                  },
                  posts: nil)
        }
    }
}

/// The core library's piece, under a name the Finals list can use beside its own `Piece`.
typealias ToolsetFinalsPiece = Piece

/// An id the server sends as a whole number or as text.
@propertyWrapper
struct FlexID: Codable, Hashable {
    var wrappedValue: String

    init(wrappedValue: String) { self.wrappedValue = wrappedValue }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let text = try? c.decode(String.self) { wrappedValue = text } else { wrappedValue = String(try c.decode(Int.self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(wrappedValue)
    }
}

/// "V1A-2.mp4" reads "V1A-2"; a name that isn't a media file stays as it is.
func withoutMediaExtension(_ name: String) -> String {
    let ext = (name as NSString).pathExtension.lowercased()
    return SaveToPhotos.videos.contains(ext) || SaveToPhotos.photos.contains(ext) ? (name as NSString).deletingPathExtension : name
}

/// Some servers send flags as 0/1.
struct FlexBool: Codable, Hashable {
    let value: Bool
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let flag = try? c.decode(Bool.self) { value = flag } else { value = ((try? c.decode(Int.self)) ?? 0) != 0 }
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(value)
    }
}

extension FinalsData.Piece {
    enum Kind: String, CaseIterable, Identifiable {
        case reel, carousel, story
        var id: String { rawValue }
        var label: String { rawValue.capitalized }
        var plural: String { rawValue == "story" ? "Stories" : rawValue.capitalized + "s" }
    }

    var type: Kind? { kind.flatMap(Kind.init(rawValue:)) }
    var folder: String? { folderId?.wrappedValue }

    /// A carousel starts with its first slide; else the chosen version, else the newest.
    var cover: FinalsData.Version? {
        if type == .carousel { return slides.first }
        return versions.first { $0.clipId == winnerClipId?.wrappedValue } ?? versions.last
    }

    var slides: [FinalsData.Version] {
        versions.sorted {
            ($0.position ?? .max, slideNumber($0.file)) < ($1.position ?? .max, slideNumber($1.file))
        }
    }

    var coverPath: String? { coverUrl ?? cover.map { "/api/library/media/\($0.clipId)/thumb" } }

    /// When it happened: first posted, else its newest export (the web's `dateOf`); `.distantPast` when the server
    /// sends no dates.
    var when: (date: Date, posted: Bool) {
        if let posted = posts?.firstPostedAt.flatMap(parseCatalogDate) { return (posted, true) }
        let made = versions.compactMap { $0.madeAt }.max().flatMap(parseCatalogDate)
        return (made ?? createdAt.flatMap(parseCatalogDate) ?? .distantPast, false)
    }

    var postedLine: String {
        let (date, posted) = when
        guard date != .distantPast else { return "" }
        let day = date.formatted(.dateTime.day().month(.abbreviated))
        if posted {
            let views = posts?.maxViews.map { $0 > 0 ? " · \($0.formatted(.number.notation(.compactName))) views" : "" } ?? ""
            return "Posted \(day)\(views)"
        }
        return (posts?.trial ?? 0) > 0 ? "Trial · \(day)" : "Not posted · \(day)"
    }

    /// "Reel · 0:38", "Carousel · 7 slides".
    var summary: String {
        let name = (type ?? .reel).label
        if type == .carousel { return "\(name) · \(versions.count) \(versions.count == 1 ? "slide" : "slides")" }
        if let d = cover?.duration, d > 0 { return "\(name) · \(clock(d))" }
        return name
    }
}

private func slideNumber(_ filename: String) -> Int {
    Int(filename.split(whereSeparator: { !$0.isNumber }).first ?? "") ?? .max
}

/// "2026-09-20" (that local day), "2026-09-20 18:04:00" (UTC) or ISO 8601.
func parseCatalogDate(_ text: String) -> Date? {
    if text.count == 10 { return CatalogDates.day.date(from: text)?.addingTimeInterval(12 * 3600) }
    if let d = CatalogDates.isoFraction.date(from: text) ?? CatalogDates.iso.date(from: text) { return d }
    for f in CatalogDates.plain { if let d = f.date(from: text) { return d } }
    return nil
}

private enum CatalogDates {
    static let day: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
    static let iso = ISO8601DateFormatter()
    static let isoFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let plain: [DateFormatter] = ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss.SSSSSS"].map {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = $0
        return f
    }
}

/// Which Workshop session each final was made for, and the words that go with it (`GET /api/library/workshop`: the
/// pieces by their id).
struct FinalsLinks: Codable, Equatable {
    var pieces: [String: Link] = [:]

    struct Link: Codable, Hashable {
        let sessionId: String
        /// The session's post description ("" when it has none).
        let description: String?
        /// A version's own post description, by its key (`FinalsData.Version.key`).
        let versions: [String: Words]?

        struct Words: Codable, Hashable { let text: String }
    }

    func link(of piece: String) -> Link? { pieces[piece] }
}

/// The post description to copy with a version: that version's own when the session wrote one for it, else the
/// session's.
func postDescription(for version: String?, link: FinalsLinks.Link?, docs: [WorkshopDoc]) -> String? {
    let own = version.flatMap { link?.versions?[$0]?.text }
    return [own, link?.description, docs.compactMap { $0.caption?.text }.first]
        .compactMap { $0.map(scriptText) }
        .first { !$0.isEmpty }
}

/// An AI Editor edit, as far as Finals needs it (`GET /api/editor`): a cut it sends to Finals lands in a piece named
/// after the edit, and the edit knows the session it is the video of.
struct FinalsEdit: Codable, Hashable {
    let name: String
    let session: String?
}

/// Which Workshop session each final was made for. The server's link comes first. A piece nobody linked belongs to
/// the session an edit of its name was made for, else to the session of the same name: the rule the server's AI
/// Editor matches an edit to its session by.
struct FinalsSessions {
    private var byPiece: [String: WorkshopSession] = [:]
    /// Pieces whose session was found by the same title alone. Good enough to show its post description; not to
    /// change the session (Mark published, Send to team).
    private var byTitleOnly: Set<String> = []

    init(pieces: [FinalsData.Piece], sessions: [WorkshopSession], links: FinalsLinks, edits: [FinalsEdit]) {
        let byId = Dictionary(sessions.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let byName = Dictionary(sessions.map { (Self.nameKey($0.title), $0) }, uniquingKeysWith: { first, _ in first })
        var byEdit: [String: WorkshopSession] = [:]
        for edit in edits {
            if let id = edit.session, let session = byId[id] { byEdit[Self.nameKey(edit.name)] = session }
        }
        for piece in pieces {
            if let link = links.link(of: piece.id) {
                byPiece[piece.id] = byId[link.sessionId]
            } else {
                let key = Self.nameKey(piece.title)
                guard !key.isEmpty else { continue }
                if let session = byEdit[key] {
                    byPiece[piece.id] = session
                } else if let session = byName[key] {
                    byPiece[piece.id] = session
                    byTitleOnly.insert(piece.id)
                }
            }
        }
    }

    func session(of piece: FinalsData.Piece) -> WorkshopSession? { byPiece[piece.id] }

    /// Whether the piece's session is known for sure (the server's link, or its edit's session).
    func sure(of piece: FinalsData.Piece) -> Bool { byPiece[piece.id] != nil && !byTitleOnly.contains(piece.id) }

    /// Letters and digits only, lower case (the server's `nameKey`).
    static func nameKey(_ name: String) -> String {
        String(name.lowercased().filter { $0.isASCII && ($0.isLetter || $0.isNumber) })
    }
}

/// A session that is ready to post, with the final made for it when there is one.
struct ReadyToPost: Identifiable, Hashable {
    let session: WorkshopSession
    let piece: FinalsData.Piece?
    var id: String { session.id }

    /// "Reel · 0:38", "Carousel · 7 slides"; only the kind while there is no final.
    var line: String { piece?.summary ?? session.kindLabel ?? "" }

    /// Every session with that status, in the server's order, each with its newest final.
    static func list(sessions: [WorkshopSession], pieces: [FinalsData.Piece], made: FinalsSessions) -> [ReadyToPost] {
        sessions.filter(\.toPost).map { session in
            let its = pieces.filter { made.session(of: $0)?.id == session.id }
            return ReadyToPost(session: session, piece: its.max { $0.when.date < $1.when.date })
        }
    }
}

@MainActor
final class FinalsModel: ObservableObject {
    @Published private(set) var data: FinalsData?
    @Published private(set) var links = FinalsLinks()
    @Published private(set) var edits: [FinalsEdit] = []
    @Published private(set) var error: String?
    @Published private(set) var needsSignIn = false
    @Published private(set) var loading = false
    private var checkedAt: Date?
    /// The server, account and kind of list shown.
    private var key: String?

    /// The plug-in's list (its stacks and the library's Finals in one) when the server has it and the account has
    /// it on; else the core library's Finals collection.
    static func usesStudio(_ plugins: ServerPlugins, _ access: ToolsetAccess) -> Bool {
        plugins.studio && access.allows("finals-catalog")
    }

    /// Shows the saved list at once; asks again when it's a minute old, on pull, or when the kind of list changed.
    func load(studio: Bool, force: Bool = false) async {
        guard let api = API.current else {
            needsSignIn = true
            return
        }
        let key = "\(api.cacheKey)\(studio ? "-studio" : "")"
        if key != self.key {
            self.key = key
            data = DiskCache.read("finals-\(key)")
            links = DiskCache.read("finals-links-\(key)") ?? FinalsLinks()
            edits = DiskCache.read("finals-edits-\(key)") ?? []
            checkedAt = nil
        }
        if !force, let checkedAt, Date().timeIntervalSince(checkedAt) < 60 { return }
        loading = data == nil
        defer { loading = false }
        // a server without the Workshop link or the AI Editor, an account without them: the finals show all the same
        async let linked: FinalsLinks? = try? await api.get("/api/library/workshop")
        async let edited: Lossy<FinalsEdit>? = try? await api.get("/api/editor")
        do {
            let answer = studio ? try await api.studioFinals() : FinalsData(core: try await api.finals())
            guard key == self.key else { return }   // another list was asked for meanwhile
            let fresh = answer.showable
            if fresh != data { data = fresh }
            DiskCache.write("finals-\(key)", fresh)
            checkedAt = Date()
            error = nil
            needsSignIn = false
        } catch {
            guard key == self.key else { return }
            needsSignIn = error.needsToolsetSignIn
            self.error = needsSignIn ? nil : error.localizedDescription
        }
        if let fresh = await linked, key == self.key {
            if fresh != links { links = fresh }
            DiskCache.write("finals-links-\(key)", fresh)
        }
        if let fresh = await edited?.wrappedValue, key == self.key {
            if fresh != edits { edits = fresh }
            DiskCache.write("finals-edits-\(key)", fresh)
        }
    }
}

// MARK: The screen

/// Finals on the phone: what is ready to post on top, then every finished piece by month. Viewing, playing, saving and
/// posting; sorting pieces into folders stays on the computer.
struct FinalsView: View {
    @StateObject private var model = FinalsModel()
    @ObservedObject private var workshop = WorkshopModel.shared
    @ObservedObject private var plugins = ServerPlugins.shared
    @ObservedObject private var access = ToolsetAccess.shared
    @State private var kind: FinalsData.Piece.Kind?
    @State private var folder: String?
    @State private var query = ""
    @State private var opened: FinalsData.Piece?
    @State private var openedSession: WorkshopSession?
    @State private var tool: String?
    @State private var launched = false
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 3)

    private var studio: Bool { FinalsModel.usesStudio(plugins, access) }

    var body: some View {
        let made = FinalsSessions(pieces: pieces, sessions: workshop.sessions, links: model.links, edits: model.edits)
        let ready = ReadyToPost.list(sessions: workshop.sessions, pieces: pieces, made: made)
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if model.needsSignIn {
                    SignInAgainButton { await reload() }.padding(.horizontal)
                } else if let error = model.error {
                    Problem(text: error).padding(.horizontal)
                }
                if !ready.isEmpty, query.isEmpty { readyRow(ready) }
                if !pieces.isEmpty { filters.padding(.horizontal) }
            }

            if model.loading {
                ProgressView().padding(.top, 60)
            } else if shown.isEmpty, model.data != nil, !pieces.isEmpty || ready.isEmpty {
                ContentUnavailableView(pieces.isEmpty ? "Nothing here yet" : "No match", systemImage: "checkmark.seal")
                    .padding(.top, 40)
            }
            LazyVGrid(columns: columns, spacing: 4, pinnedViews: [.sectionHeaders]) {
                ForEach(months, id: \.title) { month in
                    Section {
                        ForEach(month.pieces) { piece in
                            NavigationLink(value: piece) { FinalCell(piece: piece) }
                                .buttonStyle(.plain)
                        }
                    } header: {
                        if !month.title.isEmpty {
                            Text(month.title)
                                .font(.subheadline.weight(.semibold))
                                .foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(.bar)
                        }
                    }
                }
            }
            .padding(.horizontal, 4)
            .padding(.bottom, 20)
        }
        .navigationTitle("Finals")
        .searchable(text: $query, prompt: "Search Finals")
        .refreshable { await reload() }
        // again when the server turns out to have the plug-in's list (or no longer has it)
        .task(id: studio) {
            async let sessions: Void = workshop.load()
            await model.load(studio: studio)
            await sessions
            openAtLaunch()
        }
        .navigationDestination(for: FinalsData.Piece.self) { detail($0, made: made) }
        .navigationDestination(for: WorkshopSession.self) { FinalDetailView(piece: nil, link: nil, made: $0, sure: true) }
        .navigationDestination(item: $opened) { detail($0, made: made) }
        .navigationDestination(item: $openedSession) { FinalDetailView(piece: nil, link: nil, made: $0, sure: true) }
        .navigationDestination(item: $tool) { name in
            if name == "captions" { CaptionStudioView() } else { StorySplitterView() }
        }
    }

    private func detail(_ piece: FinalsData.Piece, made: FinalsSessions) -> some View {
        FinalDetailView(piece: piece, link: model.links.link(of: piece.id), made: made.session(of: piece), sure: made.sure(of: piece))
    }

    /// A debug build opens a screen without taps: `-Open <piece id>`, `-OpenSession <session id>`, and the tools whose
    /// tiles live in More, `-OpenTool stories|captions`.
    private func openAtLaunch() {
        guard !launched else { return }
        launched = true
        if let id = debugArg("Open"), let piece = pieces.first(where: { $0.id == id }) { opened = piece }
        if let id = debugArg("OpenSession"), let session = workshop.sessions.first(where: { $0.id == id }) { openedSession = session }
        if let name = debugArg("OpenTool") { tool = name }
    }

    /// Pull to refresh: the finals and the sessions, both asked again now.
    private func reload() async {
        async let sessions: Void = workshop.load(force: true)
        await model.load(studio: studio, force: true)
        await sessions
    }

    // MARK: Ready to post

    private func readyRow(_ ready: [ReadyToPost]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Ready to post").font(.headline).padding(.horizontal)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(alignment: .top, spacing: 10) {
                    ForEach(ready) { item in
                        Group {
                            if let piece = item.piece {
                                NavigationLink(value: piece) { ReadyCard(item: item) }
                            } else {
                                NavigationLink(value: item.session) { ReadyCard(item: item) }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    // MARK: Filters

    private var pieces: [FinalsData.Piece] { model.data?.stacks ?? [] }

    private var shown: [FinalsData.Piece] {
        let words = query.trimmingCharacters(in: .whitespaces).lowercased()
        func matches(_ piece: FinalsData.Piece) -> Bool {
            if let kind, piece.type != kind { return false }
            if let folder, piece.folder != folder { return false }
            if words.isEmpty || piece.title.lowercased().contains(words) { return true }
            return piece.versions.contains { ($0.name ?? $0.file).lowercased().contains(words) }
        }
        let dated: [(piece: FinalsData.Piece, date: Date, at: Int)] = pieces.enumerated()
            .filter { matches($0.element) }
            .map { (piece: $0.element, date: $0.element.when.date, at: $0.offset) }
        // newest first; without dates, as the server listed them
        return dated.sorted { $0.date != $1.date ? $0.date > $1.date : $0.at < $1.at }.map { $0.piece }
    }

    private var months: [(title: String, pieces: [FinalsData.Piece])] {
        var out: [(title: String, pieces: [FinalsData.Piece])] = []
        for piece in shown {
            let date = piece.when.date
            let title = date == .distantPast ? "" : date.formatted(.dateTime.month(.wide).year())
            if out.last?.title == title { out[out.count - 1].pieces.append(piece) } else { out.append((title, [piece])) }
        }
        return out
    }

    private var filters: some View {
        VStack(alignment: .leading, spacing: 8) {
            // a list whose pieces have no kind (the core library's) has no kind to pick
            if pieces.contains(where: { $0.type != nil }) {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        chip("All \(pieces.count)", on: kind == nil) { kind = nil }
                        ForEach(FinalsData.Piece.Kind.allCases) { k in
                            let n = pieces.filter { $0.type == k }.count
                            if n > 0 { chip("\(k.plural) \(n)", on: kind == k) { kind = kind == k ? nil : k } }
                        }
                    }
                }
            }
            if let folders = model.data?.folders, !folders.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(folders) { f in
                            chip(f.name, icon: "folder", on: folder == f.id) { folder = folder == f.id ? nil : f.id }
                        }
                    }
                }
            }
        }
    }

    private func chip(_ title: String, icon: String? = nil, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label {
                Text(title)
            } icon: {
                if let icon { Image(systemName: icon) }
            }
            .font(.footnote.weight(.medium))
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(on ? Color("AccentColor").opacity(0.25) : Color(.secondarySystemBackground), in: Capsule())
            .foregroundStyle(on ? Color.primary : Color.secondary)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// One session that is ready to post: its final's picture (its kind's letter while there is none), the title, and
/// what it is.
private struct ReadyCard: View {
    let item: ReadyToPost

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Color.clear
                .aspectRatio(4 / 5, contentMode: .fit)
                .overlay { picture }
                .clipShape(RoundedRectangle(cornerRadius: 10))
            Text(item.session.title).font(.subheadline.weight(.semibold)).lineLimit(2)
            if !item.line.isEmpty {
                Text(item.line).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .frame(width: 150, alignment: .leading)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var picture: some View {
        if let path = item.piece?.coverPath {
            ToolsetImage(path: path, maxPixels: 480)
        } else {
            ZStack {
                Rectangle().fill(Color("AccentColor").opacity(0.22))
                Text(item.session.letter).font(.system(size: 44, weight: .semibold, design: .monospaced))
            }
        }
    }
}

private struct FinalCell: View {
    let piece: FinalsData.Piece

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Color.clear
                .aspectRatio(4 / 5, contentMode: .fit)
                .overlay { ToolsetImage(path: piece.coverPath, maxPixels: 360) }
                .overlay(alignment: .bottomLeading) {
                    HStack(spacing: 4) {
                        if piece.versions.count > 1 {
                            Label("\(piece.versions.count)", systemImage: "square.stack").labelStyle(.titleAndIcon)
                        }
                        Spacer(minLength: 0)
                        if let d = piece.cover?.duration, d > 0 { Text(clock(d)) }
                    }
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(5)
                    .shadow(radius: 2)
                }
                .overlay(alignment: .topLeading) {
                    if let type = piece.type, type != .reel {
                        Text(type.label)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5).padding(.vertical, 2)
                            .background(.black.opacity(0.6), in: RoundedRectangle(cornerRadius: 4))
                            .foregroundStyle(.white)
                            .padding(5)
                    }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
            Text(piece.title).font(.caption.weight(.medium)).lineLimit(1)
            if !piece.postedLine.isEmpty {
                Text(piece.postedLine).font(.caption2).foregroundStyle(piece.when.posted ? .green : .secondary).lineLimit(1)
            }
        }
        .padding(.bottom, 6)
    }
}

/// One thing the detail screen plays and saves: a version of a final, or a file that came back through a session's
/// share link.
struct FinalItem: Identifiable, Hashable {
    let id: String
    let name: String
    let filename: String
    let isImage: Bool
    /// The picture of a photo or a slide.
    let picture: String
    let play: String
    let download: String
    /// A version of a final: its clip, and what its own post description is filed under; nil for a file from a
    /// share link.
    let clip: String?
    let key: String?
    let facts: String

    init(_ v: FinalsData.Version) {
        id = "v\(v.clipId)"
        name = v.title
        filename = v.file
        isImage = v.isImage
        picture = "/api/library/media/\(v.clipId)/thumb"
        play = "/api/library/media/\(v.clipId)/play"
        download = "/api/library/media/\(v.clipId)/source"
        clip = v.clipId
        key = v.key
        facts = v.facts
    }

    init(_ file: WorkshopFile) {
        id = file.id
        name = withoutMediaExtension(file.delivery.name)
        filename = file.delivery.name
        isImage = !file.isVideo
        picture = file.path
        play = file.path
        download = file.path
        clip = nil
        key = nil
        facts = ""
    }
}

/// One final, opened from the grid or from Ready to post: the player (or a carousel's slides), its versions, Save to
/// Photos, and for a piece made for a Workshop session the words to post with it, the Story Splitter, the team link and
/// Mark published. A session that is ready to post without a final shows the files its share link brought back in the
/// same place.
struct FinalDetailView: View {
    let piece: FinalsData.Piece?
    let link: FinalsLinks.Link?
    /// The Workshop session it was made for; without a final, the session that was opened.
    let made: WorkshopSession?
    /// The session is known for sure, not guessed from the title: only then can it be changed from here.
    let sure: Bool
    @ObservedObject private var access = ToolsetAccess.shared
    @ObservedObject private var plugins = ServerPlugins.shared
    @ObservedObject private var workshop = WorkshopModel.shared
    @Environment(\.dismiss) private var dismiss
    @State private var files: [WorkshopFile] = []
    @State private var docs: [WorkshopDoc] = []
    @State private var loaded = false
    @State private var selected: FinalItem?
    @State private var player: AVPlayer?
    @State private var saving = false
    @State private var preparing = false
    @State private var linking = false
    @State private var publishing = false
    @State private var askPublish = false
    @State private var note: String?
    @State private var error: String?
    @State private var splitFile: URL?
    @State private var showSplitter = false
    @State private var teamLink: URL?

    private var admin: Bool { access.me?.role == "admin" }
    private var sessionId: String? { link?.sessionId ?? made?.id }
    /// The session as it is now (its status changes while this screen is open).
    private var session: WorkshopSession? { workshop.sessions.first { $0.id == sessionId } ?? made }
    private var title: String { piece?.title ?? session?.title ?? "" }

    private var items: [FinalItem] {
        guard let piece else { return files.map(FinalItem.init) }
        return (piece.type == .carousel ? piece.slides : piece.versions).map(FinalItem.init)
    }
    /// A carousel: its slides are swiped through and saved together.
    private var paged: Bool {
        if let piece { return piece.type == .carousel }
        return items.count > 1 && items.allSatisfy(\.isImage)
    }
    /// What shows first: the chosen version of a final, else the first video, else the first file.
    private var current: FinalItem? {
        if let selected { return selected }
        if let cover = piece?.cover, let item = items.first(where: { $0.clip == cover.clipId }) { return item }
        return items.first { !$0.isImage } ?? items.first
    }
    /// The plug-in's list lets only admins download a final; the core library lets whoever sees it; a file from a
    /// share link is anyone's who has the link.
    private var canSave: Bool {
        current != nil && (piece == nil || admin || !FinalsModel.usesStudio(plugins, access))
    }
    private var canSplit: Bool { canSave && !paged && current?.isImage == false }
    private var canPublish: Bool {
        guard sure, let status = session?.status else { return false }
        return ![WorkshopStatus.published, .shelved, .unknown].contains(status)
    }
    private var description: String? { postDescription(for: paged ? nil : current?.key, link: link, docs: docs) }
    private var pinned: String? { docs.compactMap { $0.pinned?.text }.map(scriptText).first { !$0.isEmpty } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                media
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.title3.weight(.semibold))
                    if session?.toPost == true {
                        Text("Ready to post").font(.footnote.weight(.semibold)).foregroundStyle(.orange)
                    }
                    if !subtitle.isEmpty { Text(subtitle).font(.subheadline).foregroundStyle(.secondary) }
                }
                .padding(.horizontal)

                if items.count > 1, !paged { versionPicker.padding(.horizontal) }
                if piece == nil, loaded, items.isEmpty, error == nil {
                    Text("No files yet").font(.subheadline).foregroundStyle(.secondary).padding(.horizontal)
                }
                buttons.padding(.horizontal)
                if let error { Problem(text: error).padding(.horizontal) }
                if let note { Text(note).font(.footnote).foregroundStyle(.secondary).padding(.horizontal) }
            }
            .padding(.bottom, 24)
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .tabBar)
        .task { await load() }
        .onDisappear { player?.pause() }
        .navigationDestination(isPresented: $showSplitter) { StorySplitterView(file: splitFile) }
        .sheet(isPresented: Binding(get: { teamLink != nil }, set: { if !$0 { teamLink = nil } })) {
            if let teamLink { ShareSheet(items: [teamLink]).presentationDetents([.medium, .large]) }
        }
        // it is the session that gets published: the question names it, not the final
        .confirmationDialog("Mark “\(session?.title ?? title)” as published?", isPresented: $askPublish, titleVisibility: .visible) {
            Button("Mark published") { Task { await markPublished() } }
            Button("Cancel", role: .cancel) {}
        }
    }

    private var subtitle: String {
        if let piece {
            return [piece.type?.label, piece.postedLine.isEmpty ? nil : piece.postedLine].compactMap { $0 }.joined(separator: " · ")
        }
        return [session?.kindLabel, session?.projectName].compactMap { $0 }.joined(separator: " · ")
    }

    /// Low enough that every button under it shows without scrolling; the player goes full screen on a tap.
    private static let mediaHeight: CGFloat = 340

    @ViewBuilder private var media: some View {
        if paged {
            TabView {
                ForEach(items) { slide in
                    ToolsetImage(path: slide.picture, maxPixels: 1200, contentMode: .fit)
                        .aspectRatio(4 / 5, contentMode: .fit)
                }
            }
            .tabViewStyle(.page)
            .frame(maxWidth: .infinity)
            .frame(height: Self.mediaHeight)
        } else if let current, current.isImage {
            ToolsetImage(path: current.picture, maxPixels: 1200, contentMode: .fit)
                .aspectRatio(4 / 5, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .frame(height: Self.mediaHeight)
        } else if let player {
            NativePlayer(player: player)
                .frame(maxWidth: .infinity)
                .frame(height: Self.mediaHeight)
                .background(Color.black)
        }
    }

    /// The versions by their names: side by side while they fit, a menu when there are many.
    @ViewBuilder private var versionPicker: some View {
        let picked = Binding(get: { current?.id ?? "" }, set: { id in
            if let item = items.first(where: { $0.id == id }) { select(item) }
        })
        VStack(alignment: .leading, spacing: 6) {
            if items.count <= 4 {
                Picker("Version", selection: picked) {
                    ForEach(items) { Text($0.name).tag($0.id) }
                }
                .pickerStyle(.segmented)
            } else {
                Picker("Version", selection: picked) {
                    ForEach(items) { Text($0.name).tag($0.id) }
                }
                .pickerStyle(.menu)
                .frame(minHeight: 44)
            }
            if let facts = current?.facts, !facts.isEmpty {
                Text(facts).font(.caption).foregroundStyle(.secondary).lineLimit(2)
            }
        }
    }

    private var buttons: some View {
        VStack(spacing: 10) {
            if canSave {
                WideButton(title: paged ? "Save all \(items.count) slides to Photos" : "Save to Photos",
                           systemImage: "square.and.arrow.down", busy: saving) {
                    Task { await save(paged ? items : [current].compactMap { $0 }) }
                }
            }
            if description != nil || pinned != nil {
                HStack(spacing: 10) {
                    if let description { CopyButton(title: "Post description", systemImage: "text.alignleft", text: description) }
                    if let pinned { CopyButton(title: "Pinned comment", systemImage: "pin", text: pinned) }
                }
            }
            if canSplit || (sessionId != nil && sure) {
                HStack(spacing: 10) {
                    if canSplit, let current {
                        WideButton(title: "Split into stories", systemImage: "scissors", kind: .plain, busy: preparing) {
                            Task { await openSplitter(current) }
                        }
                    }
                    if let sessionId, sure {
                        WideButton(title: "Send to team", systemImage: "person.2", kind: .plain, busy: linking) {
                            Task { await sendToTeam(sessionId) }
                        }
                    }
                }
            }
            if canPublish {
                WideButton(title: "Mark published", systemImage: "checkmark.circle", kind: .plain, busy: publishing) { askPublish = true }
            }
        }
    }

    // MARK: Actions

    /// The session's words (its documents) and, without a final, the files its share links brought back.
    private func load() async {
        if player == nil, !paged, let current { select(current) }
        guard let sessionId, let api = API.current else {
            loaded = true
            return
        }
        // without the documents the copy buttons simply aren't there
        docs = (try? await api.sessionDocs(sessionId)) ?? []
        if piece == nil {
            do {
                let shares = try await api.sessionShares(sessionId)
                files = shares.flatMap { share in (share.deliveries ?? []).map { WorkshopFile(token: share.token, delivery: $0) } }
                if selected == nil, !paged, let current { select(current) }
            } catch {
                self.error = error.localizedDescription
            }
        }
        loaded = true
    }

    private func select(_ item: FinalItem) {
        selected = item
        player?.pause()
        player = item.isImage ? nil : API.current?.player(item.play)
    }

    private func save(_ picked: [FinalItem]) async {
        guard let api = API.current else { return }
        saving = true
        error = nil
        defer { saving = false }
        do {
            for item in picked { try await api.saveToPhotos(item.download, filename: item.filename) }
            flash(picked.count == 1 ? "Saved to Photos" : "Saved \(picked.count) to Photos")
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The video downloads (as Save to Photos does) and opens in Story Splitter.
    private func openSplitter(_ item: FinalItem) async {
        guard let api = API.current else { return }
        preparing = true
        error = nil
        defer { preparing = false }
        do {
            splitFile = try await api.download(item.download, filename: item.filename,
                                               into: StorySplitterModel.folder.appendingPathComponent("source", isDirectory: true))
            showSplitter = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// The session's team link (the one it has, or a new one), handed to the iPhone's share sheet.
    private func sendToTeam(_ id: String) async {
        guard let api = API.current else { return }
        linking = true
        error = nil
        defer { linking = false }
        do {
            teamLink = api.server.appendingPathComponent("ws/\(try await api.teamShare(id).token)")
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func markPublished() async {
        guard let api = API.current, let sessionId else { return }
        publishing = true
        error = nil
        defer { publishing = false }
        do {
            try await api.setStatus(sessionId, .published)
            await workshop.load(force: true)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// A short line that goes away by itself.
    private func flash(_ message: String) {
        note = message
        Task {
            try? await Task.sleep(for: .seconds(2))
            if note == message { note = nil }
        }
    }
}

/// Copies a text and says so on the button for a moment.
private struct CopyButton: View {
    let title: String
    let systemImage: String
    let text: String
    @State private var copied = false

    var body: some View {
        WideButton(title: copied ? "Copied" : title, systemImage: copied ? "checkmark" : systemImage, kind: .plain) {
            UIPasteboard.general.string = text
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(1.5))
                copied = false
            }
        }
    }
}

/// The iPhone's own share sheet.
private struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
