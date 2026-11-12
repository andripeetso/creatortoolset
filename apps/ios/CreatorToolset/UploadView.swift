import Combine
import Photos
import SwiftUI
import UniformTypeIdentifiers

// MARK: What the tab works out

/// Which part of the camera roll the grid lists: the chips under the title.
enum PhoneFilter: Hashable {
    case notUploaded
    case all
    case favourites
    case album(String)  // PHAssetCollection localIdentifier
}

/// One clip of the camera roll, as the grid draws it.
struct PhoneClip: Identifiable, Equatable {
    let id: String  // PHAsset localIdentifier
    var badge: StatusBadge.Kind = .none
    var favourite = false
    /// nil for a photo.
    var duration: Double?

    /// Not in the library and not on its way: a tap picks it.
    var canPick: Bool { badge == .none }
}

/// The sums behind the Upload tab, apart from the screen so they can be tested.
enum UploadSums {
    /// The clips a chip lists. "Not uploaded" is every clip without the green check, so a clip just sent stays in view
    /// with its ring until it lands.
    static func listed(_ clips: [PhoneClip], filter: PhoneFilter, album: Set<String> = []) -> [PhoneClip] {
        switch filter {
        case .notUploaded: clips.filter { $0.badge != .uploaded }
        case .all: clips
        case .favourites: clips.filter(\.favourite)
        case .album: clips.filter { album.contains($0.id) }
        }
    }

    enum SelectAll: Equatable {
        /// "Select all N": the clips of the list that can be picked.
        case pick([String])
        /// "Clear": every one of them is picked already.
        case clear
    }

    /// The button at the left of the bar; nil when the list has nothing to pick and nothing is picked.
    static func selectAll(_ listed: [PhoneClip], picked: Set<String>) -> SelectAll? {
        let open = listed.filter(\.canPick).map(\.id)
        if open.isEmpty { return picked.isEmpty ? nil : .clear }
        return open.allSatisfy(picked.contains) ? .clear : .pick(open)
    }

    /// What one press of Upload sends: the picked clips that can still be picked (`fresh`), and with them every upload
    /// added earlier and never sent and every one that failed (a press tries those again). `count` is the number on
    /// the button. `uploads` are the Upload tab's own (no New edit clips).
    static func toSend(picked: Set<String>, uploads: [UploadItem],
                       badge: (String) -> StatusBadge.Kind) -> (fresh: [String], count: Int) {
        let fresh = picked.filter { badge($0) == .none }.sorted()
        return (fresh, fresh.count + uploads.filter { $0.state == .picked || $0.state == .failed }.count)
    }

    /// "Uploading 5 · 2 left" and how far along, while clips are on their way; nil otherwise. `since` is when these
    /// began: what landed after it is part of the 5.
    static func sending(_ uploads: [UploadItem], since: Date?, sent: (UploadItem) -> Int64) -> (text: String, progress: Double)? {
        let working = uploads.filter(\.isWorking)
        guard !working.isEmpty else { return nil }
        let landed = since.map { start in uploads.filter { $0.isFinished && ($0.finishedAt ?? .distantPast) >= start }.count } ?? 0
        let total = working.count + landed
        let partly = working.reduce(0.0) { sum, item in
            if item.state == .confirming || item.state == .finishing { return sum + 1 }
            return sum + (item.size > 0 ? min(1, Double(sent(item)) / Double(item.size)) : 0)
        }
        let text = landed == 0 ? "Uploading \(total)" : "Uploading \(total) · \(working.count) left"
        return (text, (Double(landed) + partly) / Double(total))
    }

    /// What each upload is doing, without how far along: this changes when a clip starts, lands or fails, and stays
    /// the same while its bytes go up.
    static func states(_ uploads: [UploadItem]) -> [UUID: UploadItem.State] {
        Dictionary(uploads.map { ($0.id, $0.state) }, uniquingKeysWith: { $1 })
    }

    /// "1 needs a look"; nil when nothing failed.
    static func failed(_ uploads: [UploadItem]) -> String? {
        let count = uploads.filter { $0.state == .failed }.count
        return count == 0 ? nil : "\(count) need\(count == 1 ? "s" : "") a look"
    }

    /// The Upload tab's uploads: the server in use's, without a New edit's clips (those show on the edit's row).
    static func tab(_ items: [UploadItem], server: String?) -> [UploadItem] {
        items.filter { $0.edit == nil && $0.server == server }
    }
}

/// A debug build can draw made-up uploads over the first clips of the camera roll, to look at the rings, the strip
/// and Activity without sending anything (`-UploadFake sending` or `failed`). Never saved; the uploader never sees them.
enum UploadFakes {
    static func items(over assets: [PHAsset], server: String?) -> [UploadItem]? {
        guard let kind = debugArg("UploadFake"), let server else { return nil }
        func item(_ n: Int, _ state: UploadItem.State, sent: Int64 = 0, note: String? = nil) -> UploadItem? {
            guard assets.indices.contains(n) else { return nil }
            var made = UploadItem(asset: assets[n].localIdentifier, filename: "IMG_010\(n).MOV", isVideo: assets[n].mediaType == .video,
                                  capturedAt: assets[n].creationDate, server: server,
                                  id: UUID(uuidString: "00000000-0000-0000-0000-00000000000\(n)")!)
            made.state = state
            made.size = 100_000_000
            made.sent = sent
            made.note = note
            if made.isFinished { made.finishedAt = .distantFuture }
            return made
        }
        switch kind {
        case "sending":
            return [item(0, .sending, sent: 62_000_000), item(1, .sending, sent: 9_000_000), item(2, .preparing),
                    item(3, .done), item(4, .done)].compactMap { $0 }
        case "failed":
            return [item(0, .failed, note: "The server kept losing this upload (HTTP 500)")].compactMap { $0 }
        default:
            return nil
        }
    }
}

/// A debug run (`-UploadDo 3`) counts how often the tab is drawn and the roll walked while bytes tick, and writes that
/// twice a second, with what the button and the strip say, to Caches/upload-do.log. A release build counts nothing.
@MainActor
enum UploadTrace {
    static func drew() {
        #if DEBUG
        draws += 1
        #endif
    }

    static func walked(_ clips: Int, since began: CFAbsoluteTime) {
        #if DEBUG
        walks += 1
        lastWalk = (clips, (CFAbsoluteTimeGetCurrent() - began) * 1000)
        walkMs += lastWalk.ms
        #endif
    }

    #if DEBUG
    static var draws = 0
    static var walks = 0
    static var walkMs = 0.0
    static var lastWalk = (clips: 0, ms: 0.0)
    static var ticks = 0
    static var watching: AnyCancellable?
    private static let began = CFAbsoluteTimeGetCurrent()
    private static let file = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("upload-do.log")

    static func start(_ store: UploadStore) {
        try? FileManager.default.removeItem(at: file)
        watching = store.$liveBytes.dropFirst().sink { _ in ticks += 1 }
    }

    static func line(_ said: String, _ uploads: [UploadItem]) {
        let states = uploads.map { "\($0.filename):\($0.state.rawValue)" }.joined(separator: ",")
        let text = String(format: "t=%.1f draws=%d walks=%d walkMs=%.1f lastWalk=%d/%.2fms ticks=%d ",
                          CFAbsoluteTimeGetCurrent() - began, draws, walks, walkMs, lastWalk.clips, lastWalk.ms, ticks)
            + said + " [" + states + "]\n"
        guard let handle = try? FileHandle(forWritingTo: file) else {
            try? Data(text.utf8).write(to: file)
            return
        }
        handle.seekToEndOfFile()
        handle.write(Data(text.utf8))
        try? handle.close()
    }
    #endif
}

/// The roll's clips as last walked, kept between redraws of the tab.
final class RollMemo {
    private var key = ""
    private var clips: [PhoneClip] = []
    /// What each upload was doing at the last look (`UploadSums.states`).
    var states: [UUID: UploadItem.State] = [:]

    func clips(_ key: String, walk: () -> [PhoneClip]) -> [PhoneClip] {
        if key != self.key {
            clips = walk()
            self.key = key
        }
        return clips
    }
}

// MARK: The tab

/// The Upload tab is the camera roll: pick clips, press Upload. The Media Library sits beside it.
struct UploadView: View {
    enum Segment: String, CaseIterable, Identifiable {
        case phone = "This phone"
        case library = "Media Library"
        var id: String { rawValue }
    }

    @EnvironmentObject private var servers: Servers
    /// The uploads are read through it (`engine.store`) and not followed: the store says "changed" many times a
    /// second while bytes go up, and the tab is redrawn only when an upload's state changes (`uploadsChanged`). The
    /// rings and the strip follow the bytes themselves.
    @EnvironmentObject private var engine: UploadEngine
    @ObservedObject private var library = PhotoLibrary.shared
    @ObservedObject private var index = LibraryIndex.shared
    @ObservedObject private var access = ToolsetAccess.shared
    @ObservedObject private var plugins = ServerPlugins.shared
    @Environment(\.scenePhase) private var scenePhase
    /// Goes up when the roll, a camera verdict, the library's answers or an upload's state changed: only then is the
    /// whole roll walked again (`memo`).
    @State private var stale = 0
    @State private var memo = RollMemo()
    @State private var segment: Segment = debugArg("UploadSegment") == "library" ? .library : .phone
    @State private var filter: PhoneFilter = debugArg("UploadFilter") == "all" ? .all : .notUploaded
    /// Kept here, above the two sides, so a look at the Media Library does not drop the picks.
    @State private var picked: Set<String> = []
    @State private var album: Set<String> = []
    /// When the clips now on their way began, so the strip can say "5 · 2 left".
    @State private var runStart: Date?
    @State private var showingActivity = debugArg("UploadShow") == "activity"
    @State private var importing = false
    @State private var problem: String?
    /// Screenshots, screen recordings and images saved from other apps stay out of the way unless asked for.
    @AppStorage("upload.cameraOnly") private var cameraOnly = true

    private let columns = [GridItem(.adaptive(minimum: 110), spacing: 2)]

    var body: some View {
        Group {
            if segment == .library, showsLibrary {
                LibraryBrowse(segment: $segment)
            } else if library.canRead {
                roll
            } else {
                photosAsk
            }
        }
        .navigationTitle("Upload")
        .sheet(isPresented: $showingActivity) { ActivityView() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.movie, .image, .audio, .item],
                      allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls { keep(url) }
        }
        .onReceive(library.$assets) { _ in stale += 1 }
        .onReceive(library.$cameraMarks) { _ in stale += 1 }
        .onReceive(index.$marks) { _ in stale += 1 }
        .onReceive(engine.store.$items) { uploadsChanged($0) }
        .onAppear { library.refreshAccess() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { library.refreshAccess() } }
    }

    /// The Media Library side: for an account that has it on a server that is signed in.
    private var showsLibrary: Bool { access.allows("media") && servers.api != nil }

    /// The store changed its uploads. Bytes going up, a note or a retry count change nothing here.
    private func uploadsChanged(_ items: [UploadItem]) {
        let list = uploads(items).list
        let states = UploadSums.states(list)
        if states != memo.states {
            memo.states = states
            stale += 1
        }
        let working = list.contains(where: \.isWorking)
        if working != (runStart != nil) { runStart = working ? Date() : nil }
    }

    // MARK: The camera roll

    @ViewBuilder private var roll: some View {
        let _ = UploadTrace.drew()
        let clips = self.clips
        let shown = UploadSums.listed(clips, filter: filter, album: album)
        let send = toSend()
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                UploadSegments(segment: $segment, shown: showsLibrary)
                chips(notUploaded: UploadSums.listed(clips, filter: .notUploaded).count)
                UploadStrip(since: runStart) { showingActivity = true }
                checks
                if let problem { Problem(text: problem) }
            }
            .padding(.horizontal)
            .padding(.bottom, 6)
            if shown.isEmpty {
                Text(emptyLine(clips)).font(.subheadline).foregroundStyle(.secondary).padding(.top, 60)
            }
            LazyVGrid(columns: columns, spacing: 2) {
                ForEach(shown) { clip in
                    let isPicked = clip.canPick && picked.contains(clip.id)
                    PhoneClipCell(clip: clip, key: UploadStore.key(asset: clip.id, server: servers.currentId ?? ""), picked: isPicked)
                        .onTapGesture { tap(clip) }
                        .accessibilityAddTraits(isPicked ? [.isButton, .isSelected] : .isButton)
                }
            }
        }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { filterMenu } }
        .safeAreaInset(edge: .bottom) { bar(UploadSums.selectAll(shown, picked: picked), count: send.count) }
        .refreshable { await engine.reconcile() }
        .task(id: "\(library.kind.rawValue) \(library.assets.count) \(servers.currentId ?? "") \(plugins.known.catalog)") {
            // the studio's library answers by name and size before anything is picked
            if plugins.known.catalog, let api = servers.api, let server = servers.currentId {
                index.refresh(library.assets, server: server, check: CatalogAPI(api: api).sameFiles)
            }
            loadAlbum()
        }
        .onChange(of: filter) { _, _ in loadAlbum() }
        .task { await debugRun() }
    }

    /// A debug build shows photos and picks the first clips by itself, for a screenshot: -UploadKind photos,
    /// -UploadPick 3. -UploadDo 3 picks them and presses Upload; "3,2" presses again two seconds later with two more.
    private func debugRun() async {
        if debugArg("UploadKind") == "photos" { library.kind = .photos }
        #if DEBUG
        let presses = debugArg("UploadDo")?.split(separator: ",").compactMap { Int($0) }
        guard let counts = presses ?? debugArg("UploadPick").flatMap(Int.init).map({ [$0] }) else { return }
        if presses != nil { UploadTrace.start(engine.store) }
        try? await Task.sleep(for: .seconds(3))
        for count in counts {
            let now = UploadSums.listed(self.clips, filter: filter, album: album)
            for clip in now.filter(\.canPick).prefix(count) { tap(clip) }
            guard presses != nil else { return }
            UploadTrace.line("picked=\(picked.count) button=\(toSend().count) press", uploads().list)
            upload()
            try? await Task.sleep(for: .seconds(2))
        }
        while !Task.isCancelled {
            let items = uploads().list
            let strip = UploadSums.sending(items, since: runStart) { engine.store.sentBytes($0) }
            UploadTrace.line("button=\(toSend().count) strip=\"\(strip?.text ?? "")\" "
                             + String(format: "progress=%.2f", strip?.progress ?? 0)
                             + " failed=\"\(UploadSums.failed(items) ?? "")\"", items)
            try? await Task.sleep(for: .milliseconds(500))
        }
        #endif
    }

    /// The tab's uploads, as a list and by clip.
    private func uploads(_ items: [UploadItem]? = nil) -> (list: [UploadItem], byAsset: [String: UploadItem]) {
        if let fakes = UploadFakes.items(over: library.assets, server: servers.currentId) {
            return (fakes, UploadStore.byAsset(fakes))
        }
        return (UploadSums.tab(items ?? engine.store.items, server: servers.currentId), engine.store.byAsset)
    }

    /// A clip this phone sent shows its upload's state; any other shows the check when the library has it already
    /// (uploaded from anywhere). On screen a ring follows the live bytes by itself (`LiveRing`).
    private func badge(_ assetId: String, _ byAsset: [String: UploadItem]) -> StatusBadge.Kind {
        let item = byAsset[UploadStore.key(asset: assetId, server: servers.currentId ?? "")]
        return StatusBadge.kind(for: item, sent: item?.sent ?? 0, inLibrary: index.isInLibrary(assetId, server: servers.currentId))
    }

    /// The roll after "Only camera photos" / "Hide screen recordings". Walking it is the costly part with thousands of
    /// clips, so it is walked when `stale` went up or the toggle changed, never for a redraw alone.
    private var clips: [PhoneClip] {
        memo.clips("\(stale) \(cameraOnly) \(servers.currentId ?? "")") {
            let began = CFAbsoluteTimeGetCurrent()
            defer { UploadTrace.walked(library.assets.count, since: began) }
            let byAsset = uploads().byAsset
            return library.assets.compactMap { asset in
                guard !cameraOnly || library.isFromCamera(asset) else { return nil }
                let id = asset.localIdentifier
                return PhoneClip(id: id, badge: badge(id, byAsset), favourite: asset.isFavorite,
                                 duration: asset.mediaType == .video ? asset.duration : nil)
            }
        }
    }

    private func chips(notUploaded: Int) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                FilterChip(title: notUploaded > 0 ? "Not uploaded \(notUploaded)" : "Not uploaded", on: filter == .notUploaded) {
                    filter = .notUploaded
                }
                FilterChip(title: "All", on: filter == .all) { filter = .all }
                FilterChip(title: "Favourites", on: filter == .favourites) { filter = .favourites }
                if !library.albums.isEmpty {
                    Menu {
                        Picker("Albums", selection: $filter) {
                            ForEach(library.albums) { Text($0.title).tag(PhoneFilter.album($0.id)) }
                        }
                    } label: {
                        ChipFace(title: albumTitle ?? "Albums", icon: "chevron.down", on: albumTitle != nil)
                    }
                }
            }
        }
    }

    private var albumTitle: String? {
        guard case .album(let id) = filter else { return nil }
        return library.albums.first { $0.id == id }?.title
    }

    /// The two checks that run over the roll, only while they run.
    @ViewBuilder private var checks: some View {
        if let progress = index.progress {
            checkLine("Checking the library · \(progress.done) of \(progress.total)")
        }
        if cameraOnly, library.kind == .photos, let check = library.cameraCheck {
            checkLine("Finding camera photos · \(check.done) of \(check.total)")
        }
    }

    private func checkLine(_ text: String) -> some View {
        Text(text).font(.footnote).monospacedDigit().foregroundStyle(.secondary)
    }

    private func emptyLine(_ clips: [PhoneClip]) -> String {
        if clips.isEmpty { return "No \(library.kind.rawValue.lowercased()) from 2023 on" }
        switch filter {
        case .favourites: return "No favourites"
        case .album: return "Nothing in this album"
        case .notUploaded, .all: return "All uploaded"
        }
    }

    /// The toggles used rarely, Files, and Activity while nothing is on its way.
    private var filterMenu: some View {
        Menu {
            Picker("Show", selection: $library.kind) {
                ForEach(PhotoLibrary.Kind.allCases) { Text($0.rawValue).tag($0) }
            }
            Toggle(library.kind == .photos ? "Only camera photos" : "Hide screen recordings", isOn: $cameraOnly)
            Divider()
            Button("From Files", systemImage: "folder") { importing = true }
            Button("Activity", systemImage: "list.bullet") { showingActivity = true }
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
        }
        .accessibilityLabel("Filter")
    }

    /// Floats above the tab bar while there is something to pick or to send.
    @ViewBuilder private func bar(_ selectAll: UploadSums.SelectAll?, count: Int) -> some View {
        if selectAll != nil || count > 0 {
            HStack(spacing: 10) {
                switch selectAll {
                case .pick(let ids): pill("Select all \(ids.count)") { picked.formUnion(ids) }
                case .clear: pill("Clear") { picked.removeAll() }
                case nil: EmptyView()
                }
                if count > 0 {
                    WideButton(title: "Upload \(count)", systemImage: "arrow.up") { upload() }
                } else {
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
        }
    }

    private func pill(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(.semibold))
                .monospacedDigit()
                .padding(.horizontal, 16)
                .frame(height: 44)
                .chatSurface(cornerRadius: 22)
        }
        .buttonStyle(.plain)
    }

    /// A tap picks or unpicks a clip not in the library; a failed one opens Activity.
    private func tap(_ clip: PhoneClip) {
        if clip.canPick {
            if !picked.insert(clip.id).inserted { picked.remove(clip.id) }
        } else if clip.badge == .failed {
            showingActivity = true
        }
    }

    private func toSend() -> (fresh: [String], count: Int) {
        let uploads = uploads()
        return UploadSums.toSend(picked: picked, uploads: uploads.list) { badge($0, uploads.byAsset) }
    }

    /// One press: the picked clips join the uploads and everything waiting starts, the clips that failed with it.
    private func upload() {
        guard let server = servers.currentId else { return }
        var chosen: [PHAsset] = []
        // the picks can mix videos and photos: fetched by id
        PHAsset.fetchAssets(withLocalIdentifiers: toSend().fresh, options: nil).enumerateObjects { asset, _, _ in chosen.append(asset) }
        engine.add(chosen, server: server)
        engine.uploadAll()
        picked.removeAll()
    }

    /// A file from Files is copied into the app at once and waits for Upload with the clips.
    private func keep(_ url: URL) {
        guard let server = servers.current else { return }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let id = UUID()
        do {
            try FileManager.default.copyItem(at: url, to: AppFiles.upload(id))
        } catch {
            return problem = "Couldn't copy \(url.lastPathComponent): \(error.localizedDescription)"
        }
        let size = ((try? FileManager.default.attributesOfItem(atPath: AppFiles.upload(id).path)[.size]) as? NSNumber)?.int64Value ?? 0
        guard size > 0 else {
            try? FileManager.default.removeItem(at: AppFiles.upload(id))
            return problem = "\(url.lastPathComponent) is empty"
        }
        problem = nil
        engine.add(id: id, filename: url.lastPathComponent, size: size, server: server)
    }

    /// Which clips the picked album holds. An album deleted in Photos goes back to Not uploaded.
    private func loadAlbum() {
        guard case .album(let id) = filter else { return album = [] }
        guard let collection = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil).firstObject else {
            return filter = .notUploaded
        }
        var ids = Set<String>()
        PHAsset.fetchAssets(in: collection, options: nil).enumerateObjects { asset, _, _ in ids.insert(asset.localIdentifier) }
        album = ids
    }

    // MARK: Photos access

    /// First use: the ask for Photos, in place of the grid.
    private var photosAsk: some View {
        ScrollView {
            VStack(spacing: 12) {
                UploadSegments(segment: $segment, shown: showsLibrary)
                if library.access == .notDetermined {
                    WideButton(title: "Allow Photos access", systemImage: "photo.on.rectangle") {
                        Task { await library.requestAccess() }
                    }
                    .padding(.top, 48)
                } else {
                    Text("Photos access is off").font(.subheadline).foregroundStyle(.secondary).padding(.top, 48)
                    WideButton(title: "Open Settings", systemImage: "gear") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            }
            .padding(.horizontal)
        }
        .toolbar { ToolbarItem(placement: .topBarTrailing) { filterMenu } }
    }
}

// MARK: Pieces

/// This phone | Media Library, under the title; only for an account that has the Media Library.
struct UploadSegments: View {
    @Binding var segment: UploadView.Segment
    let shown: Bool

    var body: some View {
        if shown {
            Picker("Show", selection: $segment) {
                ForEach(UploadView.Segment.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
        }
    }
}

/// What is on its way and what failed; a tap opens Activity. Nothing when all is fine. It follows the bytes itself,
/// so a tick redraws this strip and not the roll.
struct UploadStrip: View {
    let since: Date?
    let open: () -> Void
    @EnvironmentObject private var store: UploadStore
    @EnvironmentObject private var servers: Servers

    var body: some View {
        let uploads = UploadFakes.items(over: PhotoLibrary.shared.assets, server: servers.currentId)
            ?? UploadSums.tab(store.items, server: servers.currentId)
        if let sending = UploadSums.sending(uploads, since: since, sent: { store.sentBytes($0) }) {
            Button(action: open) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(sending.text).font(.footnote.weight(.medium)).monospacedDigit()
                    ProgressView(value: sending.progress)
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
        if let failed = UploadSums.failed(uploads) {
            Button(action: open) {
                Label(failed, systemImage: "exclamationmark.circle.fill")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }
}

/// The face of a filter chip: lit while its filter is on. 44 points to tap.
struct ChipFace: View {
    let title: String
    var icon: String?
    let on: Bool

    var body: some View {
        HStack(spacing: 4) {
            Text(title).monospacedDigit()
            if let icon { Image(systemName: icon).font(.caption2.weight(.semibold)) }
        }
        .font(.footnote.weight(.medium))
        .padding(.horizontal, 12)
        .frame(height: 32)
        .background(on ? Color("AccentColor").opacity(0.25) : Color(.secondarySystemBackground), in: Capsule())
        .foregroundStyle(on ? Color.primary : Color.secondary)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

struct FilterChip: View {
    let title: String
    let on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) { ChipFace(title: title, on: on) }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// One clip of the camera roll: its badge, its length, and the outline while it is picked.
struct PhoneClipCell: View {
    let clip: PhoneClip
    /// Its upload in the store (`UploadStore.key`).
    let key: String
    let picked: Bool

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay(AssetThumbnail(assetId: clip.id))
            .clipped()
            .overlay(alignment: .bottomLeading) {
                if let duration = clip.duration {
                    Text(clock(duration))
                        .font(.caption2.monospacedDigit().bold())
                        .foregroundStyle(.white)
                        .shadow(radius: 2)
                        .padding(4)
                }
            }
            .overlay(alignment: .topTrailing) {
                Group {
                    if case .uploading = clip.badge {
                        LiveRing(key: key, drawn: clip.badge)
                    } else {
                        StatusBadge(kind: clip.badge)
                    }
                }
                .padding(4)
            }
            .overlay {
                if picked {
                    Rectangle().strokeBorder(Color("AccentColor"), lineWidth: 3)
                    Image(systemName: "checkmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.white, Color("AccentColor"))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(4)
                }
            }
            // what is in the library steps back, so what is left to send stands out
            .opacity(clip.badge == .uploaded ? 0.6 : 1)
            .contentShape(Rectangle())
    }
}

/// A clip from the Photos picker (New edit), moved into the app's upload folder under a fresh id.
struct PickedFile: Transferable {
    let url: URL
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in try take(received.file) }
        FileRepresentation(importedContentType: .image) { received in try take(received.file) }
    }

    private static func take(_ file: URL) throws -> PickedFile {
        let dest = AppFiles.upload(UUID())
        do {
            try FileManager.default.moveItem(at: file, to: dest)
        } catch {
            try FileManager.default.copyItem(at: file, to: dest)
        }
        return PickedFile(url: dest, name: file.lastPathComponent)
    }
}
