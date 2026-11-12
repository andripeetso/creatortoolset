import AVKit
import SwiftUI

struct LibrarySummary: Decodable {
    let id: String
    let name: String
}

struct Piece: Decodable, Identifiable, Hashable {
    struct Item: Decodable, Hashable, Identifiable {
        let id: String
        let label: String?
        let winner: Bool
        let versionId: String?
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

/// What is ready to post, then the finished pieces.
struct FinalsView: View {
    @EnvironmentObject private var servers: Servers
    @StateObject private var workshop = WorkshopModel()
    @State private var pieces: [Piece]?
    @State private var error: String?

    private let columns = [GridItem(.adaptive(minimum: 104), spacing: 4)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let error { Problem(text: error) }
                let toPost = workshop.sessions.filter(\.toPost)
                if !toPost.isEmpty {
                    Text("Ready to post").font(.headline)
                    ForEach(toPost) { session in
                        NavigationLink(value: session) { SessionRow(session: session) }
                            .buttonStyle(.plain)
                    }
                }
                if let pieces, !pieces.isEmpty {
                    Text("Finals").font(.headline)
                    LazyVGrid(columns: columns, spacing: 4) {
                        ForEach(pieces) { piece in
                            NavigationLink(value: piece) {
                                RemoteImage(path: piece.cover ?? "")
                                    .aspectRatio(9 / 16, contentMode: .fit)
                                    .overlay(alignment: .bottomLeading) {
                                        Text(piece.label).font(.caption2.weight(.medium)).lineLimit(2)
                                            .padding(4)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .background(.black.opacity(0.55))
                                    }
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                            }
                        }
                    }
                }
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .overlay {
            if pieces == nil && error == nil {
                ProgressView()
            } else if pieces?.isEmpty == true && !workshop.sessions.contains(where: \.toPost) && error == nil {
                ContentUnavailableView("No finals yet", systemImage: "film.stack")
            }
        }
        .navigationTitle("Finals")
        .navigationDestination(for: Piece.self) { PieceView(piece: $0) }
        .navigationDestination(for: WorkshopSession.self) { ScriptReaderView(session: $0) }
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        guard let api = servers.api else { return }
        async let sessions: Void = workshop.load()
        do {
            pieces = try await api.finals()
            error = nil
        } catch {
            self.error = error.localizedDescription
            pieces = pieces ?? []
        }
        await sessions
    }
}

/// A piece's versions, the winner first, each in the iPhone's own player.
struct PieceView: View {
    let piece: Piece
    @EnvironmentObject private var servers: Servers
    @State private var playing: Piece.Item?
    @State private var player: AVPlayer?

    private var versions: [Piece.Item] {
        piece.items.filter { $0.versionId != nil }.sorted { $0.winner && !$1.winner }
    }

    var body: some View {
        VStack(spacing: 0) {
            if let player {
                NativePlayer(player: player).aspectRatio(9 / 16, contentMode: .fit).frame(maxHeight: 460)
            }
            List(versions) { item in
                Button {
                    play(item)
                } label: {
                    HStack {
                        Text(item.label ?? piece.label)
                        Spacer()
                        if item.winner { Image(systemName: "star.fill").foregroundStyle(.yellow) }
                        if playing == item { Image(systemName: "speaker.wave.2.fill") }
                    }
                }
            }
        }
        .navigationTitle(piece.label)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if playing == nil, let first = versions.first { play(first) } }
        .onDisappear { player?.pause() }
    }

    private func play(_ item: Piece.Item) {
        guard let api = servers.api, let version = item.versionId else { return }
        player?.pause()
        playing = item
        player = api.player("/api/library/media/\(version)/play")
        player?.play()
    }
}
