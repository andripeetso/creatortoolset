import SwiftUI

/// Review as the server sends it (`api/review.ts`), the parts the phone needs: a video, its
/// versions, its comments and its status. Fields the server may leave out are optional.
struct ReviewAsset: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let approval: Approval
    let versions: [Version]
    let projectId: String?
    let createdAt: Double
    let comments: Int?
    let newComments: Int?
    let updatedAt: Double?

    struct Approval: Codable, Hashable {
        let status: String
        /// Who set it; absent while there is no status.
        var by: String? = nil
    }

    struct Version: Codable, Hashable, Identifiable {
        let n: Int
        let name: String
        /// Seconds; 0 until the server has processed it.
        let duration: Double
        let width: Int
        let height: Int
        /// "processing", "ready" or "error".
        let status: String
        let createdAt: Double
        /// Its video file was deleted; the comments stay.
        let removed: Bool?
        var error: String? = nil
        var id: Int { n }
    }

    var latest: Version? { versions.last }

    func media(_ v: Version, _ file: String) -> String {
        "/api/review/assets/\(id)/v/\(v.n)/\(file)?c=\(Int(v.createdAt))"
    }

    /// The version a screen opens on: the one a link named when the video has it, otherwise the newest.
    func opening(_ wanted: Int?) -> Int {
        versions.first { $0.n == wanted }?.n ?? latest?.n ?? 1
    }
}

struct ReviewProject: Codable, Hashable, Identifiable {
    let id: String
    let name: String
}

struct ReviewComment: Codable, Hashable, Identifiable {
    let id: String
    let version: Int
    /// A reply: the comment it answers. Replies are one level deep and never have a time.
    let parentId: String?
    /// Seconds into the video.
    let t: Double?
    let text: String
    let author: String
    /// Absent, not false, until someone resolves it.
    let resolved: Bool?
    let createdAt: Double
    /// The end of the stretch of video it is about.
    var tEnd: Double? = nil
    /// Written by the signed-in person.
    var mine: Bool? = nil

    /// "0:06", or "0:06–0:07" for a stretch; nil for a comment about the whole video.
    var timeLabel: String? {
        guard let t else { return nil }
        guard let tEnd, clock(tEnd) != clock(t) else { return clock(t) }
        return "\(clock(t))–\(clock(tEnd))"
    }

    /// What is posted for a new comment: at a time, about the whole video (no `t`), or as a reply
    /// (a reply never carries a time, whatever the player shows).
    static func body(version: Int, text: String, t: Double?, parentId: String?) -> [String: Any] {
        var body: [String: Any] = ["version": version, "text": text]
        if let parentId {
            body["parentId"] = parentId
        } else if let t, t.isFinite {
            body["t"] = (max(0, t) * 100).rounded() / 100
        }
        return body
    }
}

/// A comment with the replies under it.
struct ReviewThread: Hashable, Identifiable {
    let comment: ReviewComment
    let replies: [ReviewComment]
    var id: String { comment.id }
}

extension Array where Element == ReviewComment {
    /// One version's comments as threads: the timed ones by their moment in the video, then the
    /// ones about the whole video, each group by when it was written; replies under their comment, oldest first.
    func threads(version: Int) -> [ReviewThread] {
        filter { $0.version == version && $0.parentId == nil }
            .sorted { ($0.t ?? .infinity, $0.createdAt) < ($1.t ?? .infinity, $1.createdAt) }
            .map { top in
                ReviewThread(comment: top, replies: filter { $0.parentId == top.id }.sorted { $0.createdAt < $1.createdAt })
            }
    }
}

/// What `GET /api/review/assets/:id` answers.
struct ReviewDetail: Decodable {
    let asset: ReviewAsset
    let comments: [ReviewComment]
    /// The signed-in person runs this video: they may resolve anyone's comment.
    let manage: Bool?
}

/// The server's approval states and the website's words for them.
enum ReviewStatus: String, CaseIterable, Identifiable {
    case none, in_progress, needs_review, changes, approved
    var id: String { rawValue }
    var label: String {
        switch self {
        case .none: "No status"
        case .in_progress: "In progress"
        case .needs_review: "Needs review"
        case .changes: "Changes requested"
        case .approved: "Approved"
        }
    }
    var color: Color {
        switch self {
        case .none: .gray
        case .in_progress: .blue
        case .needs_review: .yellow
        case .changes: .red
        case .approved: .green
        }
    }
}

/// More buttons under a Review video from a part of the app Review itself doesn't know:
/// whatever made the video can put its own next step here ("Revise from the comments").
@MainActor
enum ReviewExtras {
    static var actions: ((ReviewAsset, [ReviewComment]) -> AnyView)?
}
