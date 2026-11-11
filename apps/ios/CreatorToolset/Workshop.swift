import Foundation

/// The Content Workshop's sessions and documents, as the server sends them (`apps/captions/api/workshop.ts`).
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
    let updatedAt: Double?

    /// Ready or in production with something to film: a session of carousels only is designed, never filmed.
    var toFilm: Bool { (status == .ready || status == .production) && (kinds ?? []).contains { $0 != "carousel" } }
    var toPost: Bool { status == .toPost }

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
}

struct WorkshopBlock: Codable, Hashable, Identifiable {
    let id: String
    let text: String
}

struct WorkshopCompanion: Codable, Hashable {
    let text: String
}

/// A document of a session: a reel's script, a carousel's slides, …
struct WorkshopDoc: Codable, Hashable, Identifiable {
    let id: String
    let kind: String
    let title: String
    let blocks: [WorkshopBlock]
    let hooks: [WorkshopBlock]?
    let caption: WorkshopCompanion?
}

/// The script as it reads: picture tokens (`![alt](pic:id)`) left out.
func scriptText(_ text: String) -> String {
    text.replacingOccurrences(of: #"!\[[^\]]*\]\(pic:[^)]*\)"#, with: "", options: .regularExpression)
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

/// The sessions of the signed-in account, one copy for Scripts and Finals' Ready to post.
@MainActor
final class WorkshopModel: ObservableObject {
    @Published private(set) var sessions: [WorkshopSession] = []
    @Published private(set) var error: String?
    @Published private(set) var loading = false

    func load() async {
        guard let api = Servers.shared.api else { return }
        loading = sessions.isEmpty
        defer { loading = false }
        do {
            sessions = try await api.get("/api/workshop/sessions")
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

extension API {
    /// The session's documents; the Workshop's own notes stay on the computer.
    func sessionDocs(_ id: String) async throws -> [WorkshopDoc] {
        let docs: [WorkshopDoc] = try await get("/api/workshop/sessions/\(id)/docs")
        return docs.filter { $0.kind != "notes" }
    }
}
