import Foundation
import SwiftUI

/// The Content Workshop's sessions, documents and share links, as the server sends them (`apps/captions/api/workshop.ts`).
enum WorkshopStatus: String, Codable, Equatable {
    case draft, writing, ready, production, editing, toPost, published, shelved
    case unknown

    init(from decoder: Decoder) throws {
        self = WorkshopStatus(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .unknown
    }

    var label: String {
        switch self {
        case .draft: return "Idea"
        case .writing: return "Writing"
        case .ready: return "Ready"
        case .production: return "In Production"
        case .editing: return "Editing"
        case .toPost: return "Ready to post"
        case .published: return "Published"
        case .shelved: return "Shelved"
        case .unknown: return "Unknown"
        }
    }
}

struct WorkshopSession: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let status: WorkshopStatus
    /// Newest first: reel, carousel, youtube, ad, free.
    let kinds: [String]?
    let projectName: String?
    /// Epoch milliseconds (the server's `updatedAt`).
    let updatedAt: Double?
    let posted: Posted?

    struct Posted: Codable, Hashable { let url: String }

    /// Ready or in production with something to film: a session of carousels only is designed, never filmed.
    var toFilm: Bool { (status == .ready || status == .production) && filmable }
    var filmable: Bool { (kinds ?? []).contains { $0 != "carousel" } }
    var toPost: Bool { status == .toPost }
    var editing: Bool { status == .editing }

    /// The one-letter kind tile: R reel, C carousel, Y youtube, A ad, F free.
    var letter: String {
        switch kinds?.first {
        case "reel": "R"
        case "carousel": "C"
        case "youtube": "Y"
        case "ad": "A"
        default: "F"
        }
    }

    /// The kind in a word, for a line under the title; nil for a free piece.
    var kindLabel: String? {
        switch kinds?.first {
        case "reel": "Reel"
        case "carousel": "Carousel"
        case "youtube": "YouTube"
        case "ad": "Ad"
        default: nil
        }
    }
}

struct WorkshopBlock: Codable, Hashable, Identifiable {
    let id: String
    let text: String
}

struct WorkshopCompanion: Codable, Hashable {
    let text: String
}

/// A document of a session: a reel's script, a carousel's slides, … `caption` is the server's name for the post
/// description.
struct WorkshopDoc: Codable, Hashable, Identifiable {
    let id: String
    let kind: String
    let title: String
    let blocks: [WorkshopBlock]
    let hooks: [WorkshopBlock]?
    let caption: WorkshopCompanion?
    let pinned: WorkshopCompanion?
}

/// A share of a session; `deliveries` are the finished files a freelancer sent back.
struct WorkshopShare: Codable, Hashable {
    let token: String
    let all: Bool?
    let deliveries: [WorkshopDelivery]?
}

struct WorkshopDelivery: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let size: Double?
    /// The MIME type ("video/mp4", "image/jpeg").
    let type: String
}

/// One finished file, with the share it came through (its download path).
struct WorkshopFile: Identifiable, Hashable {
    let token: String
    let delivery: WorkshopDelivery

    var id: String { token + delivery.id }
    var path: String { "/api/workshop-share/\(token)/deliveries/\(delivery.id)" }
    var isVideo: Bool { delivery.type.hasPrefix("video/") }
}

/// The script as it reads: picture tokens (`![alt](pic:id)`) left out.
func scriptText(_ text: String) -> String {
    text.replacingOccurrences(of: #"!\[[^\]]*\]\(pic:[^)]*\)"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// A list from the server where one odd item is left out instead of losing the whole list: the server changes many
/// times a day, and a final still being processed has no clip yet.
@propertyWrapper
struct Lossy<Item: Codable & Hashable>: Codable, Hashable {
    var wrappedValue: [Item]

    init(wrappedValue: [Item]) { self.wrappedValue = wrappedValue }

    init(from decoder: Decoder) throws {
        var list = try decoder.unkeyedContainer()
        var items: [Item] = []
        while !list.isAtEnd {
            let before = list.currentIndex
            if let item = try? list.decode(Item.self) { items.append(item) } else { _ = try? list.decode(Skipped.self) }
            if list.currentIndex == before { break }   // nothing could be read past this item
        }
        wrappedValue = items
    }

    func encode(to encoder: Encoder) throws { try wrappedValue.encode(to: encoder) }

    private struct Skipped: Decodable {
        init(from decoder: Decoder) throws {}
    }
}

extension Error {
    /// The sign-in ended (or was never made): the screen shows the button that opens it.
    var needsToolsetSignIn: Bool { (self as? APIError)?.status == 401 }
}

/// The Workshop sessions of the account on the server in use. Scripts, Ready to post on the Finals tab and that tab's
/// badge read this one copy; it shows the last answer at once and asks again when it is a minute old or on pull.
@MainActor
final class WorkshopModel: ObservableObject {
    /// The copy the Finals tab's badge counts.
    static let shared = WorkshopModel()

    @Published private(set) var sessions: [WorkshopSession] = []
    @Published private(set) var error: String?
    @Published private(set) var needsSignIn = false
    @Published private(set) var loading = false
    private var checkedAt: Date?
    /// The server and account the sessions are of.
    private var key: String?

    init() {
        if let api = API.current { show(api) }
    }

    /// Another server or account: its own last copy, and asked again.
    private func show(_ api: API) {
        key = api.cacheKey
        sessions = DiskCache.read("workshop-\(api.cacheKey)") ?? []
        checkedAt = nil
        error = nil
    }

    func load(force: Bool = false) async {
        guard let api = API.current else {
            needsSignIn = true
            return
        }
        if api.cacheKey != key { show(api) }
        if !force, let checkedAt, Date().timeIntervalSince(checkedAt) < 60 { return }
        loading = sessions.isEmpty
        defer { loading = false }
        do {
            let fresh: Lossy<WorkshopSession> = try await api.get("/api/workshop/sessions")
            guard api.cacheKey == key else { return }   // the server changed while it was asked
            sessions = fresh.wrappedValue
            DiskCache.write("workshop-\(api.cacheKey)", sessions)
            checkedAt = Date()
            error = nil
            needsSignIn = false
        } catch {
            guard api.cacheKey == key else { return }
            needsSignIn = error.needsToolsetSignIn
            self.error = needsSignIn ? nil : error.localizedDescription
        }
    }
}

extension API {
    /// The session's documents; the Workshop's own notes stay on the computer.
    func sessionDocs(_ id: String) async throws -> [WorkshopDoc] {
        let docs: Lossy<WorkshopDoc> = try await get("/api/workshop/sessions/\(id)/docs")
        return docs.wrappedValue.filter { $0.kind != "notes" }
    }

    func sessionShares(_ id: String) async throws -> [WorkshopShare] {
        struct Answer: Decodable { let shares: [WorkshopShare] }
        let answer: Answer = try await get("/api/workshop/sessions/\(id)/shares")
        return answer.shares
    }

    /// The session's team link: the one it has, or a new one (asked for again, the same link).
    func teamShare(_ id: String) async throws -> WorkshopShare {
        try JSONDecoder().decode(WorkshopShare.self, from: try await send("/api/workshop/sessions/\(id)/shares", json: ["all": true]))
    }

    func setStatus(_ id: String, _ status: WorkshopStatus) async throws {
        _ = try await send("/api/workshop/sessions/\(id)", method: "PATCH", json: ["status": status.rawValue])
    }
}
