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
        /// Its cut plays footage nobody has blurred yet: only its owner approves it, as filmed.
        var notBlurred: Bool? = nil
        /// Its owner approved it with the faces as filmed.
        var approvedAsFilmed: AsFilmed? = nil
        /// What approving it starts ("B-roll", "cards"): an edit in passes.
        var next: String? = nil
        /// What made it (managers only): the app's own AI Editor (`draft`), a plug-in's (`edit`), and its link back.
        var draft: Made? = nil
        var edit: Made? = nil
        var source: Source? = nil
        var id: Int { n }

        struct Made: Codable, Hashable {
            /// The edit's id: `edit` for the app's own editor, `project` for a plug-in's.
            var edit: String? = nil
            var project: String? = nil
            /// The cut's name inside the edit.
            var name: String? = nil
            var draft: String? = nil
        }

        struct Source: Codable, Hashable {
            var label: String? = nil
            var href: String? = nil
        }

        /// The edit that made it, when one did.
        var editId: String? { draft?.edit ?? edit?.project }

        struct AsFilmed: Codable, Hashable {
            let by: String
            let at: Double
        }

        /// The amber tag the website shows on it (ReviewAssetPage); nil when its faces are blurred.
        var blurTag: String? {
            notBlurred == true ? "Not blurred yet" + (approvedAsFilmed != nil ? " · approved as filmed" : "") : nil
        }
    }

    var latest: Version? { versions.last }

    /// The name of what made it, not the file's: an edit's cut "Hook v1" or "Hook, V2A_D1" reads "Hook". The video's
    /// own name when nothing made it.
    var title: String {
        guard let v = latest else { return name }
        if let label = v.source?.label, let cut = v.edit?.draft, label.hasSuffix(", \(cut)") {
            return String(label.dropLast(cut.count + 2))
        }
        if let cut = v.draft?.name, name.hasSuffix(" \(cut)") { return String(name.dropLast(cut.count + 1)) }
        return name
    }

    /// A cut's name (owner, 2026-11-20): each round of an edit is the next draft (its Review version number), the
    /// alternatives in one round Version A, B…; `version` only when a round has several. "Draft 2 · Version B".
    static func draftName(_ n: Int, version: String? = nil) -> String {
        "Draft \(n)" + (version.map { " · Version \($0)" } ?? "")
    }

    /// What a version is called here: "Draft 2" for a cut an edit made, "v2" for a video uploaded as it is.
    func label(_ n: Int) -> String { latest?.editId != nil ? Self.draftName(n) : "v\(n)" }

    /// Approve's words: what approving the newest cut starts, when it starts something.
    static func approveTitle(_ next: String?) -> String {
        guard let next, !next.isEmpty else { return "Approve" }
        return "Approve · add \(next)"
    }

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
    case none, in_progress, needs_review, changes, rejected, approved
    var id: String { rawValue }
    var label: String {
        switch self {
        case .none: "No status"
        case .in_progress: "In progress"
        case .needs_review: "Needs review"
        case .changes: "Changes requested"
        case .rejected: "Rejected"
        case .approved: "Approved"
        }
    }
    var color: Color {
        switch self {
        case .none: .gray
        case .in_progress: .blue
        case .needs_review: .yellow
        case .changes: .orange
        case .rejected: .red
        case .approved: .green
        }
    }
}

/// `POST /api/review/assets/:id/approval`. Approving a cut whose faces aren't blurred: the server refuses anyone but its
/// owner (403, its line, thrown) and asks the owner first (409, its question: `.ask`); `asFilmed` is the owner's yes.
enum ReviewApproval {
    enum Answer {
        case done(Data)
        case ask(String)
    }

    /// `version`: the one the press was about; the server refuses it when a newer one is in Review.
    static func send(_ api: API, asset id: String, _ status: ReviewStatus, asFilmed: Bool = false, version: Int? = nil,
                     session: URLSession = API.session) async throws -> Answer {
        var body: [String: Any] = ["status": status.rawValue]
        if asFilmed { body["asFilmed"] = true }
        if let version { body["version"] = version }
        let request = api.request("/api/review/assets/\(id)/approval", method: "POST", json: body)
        do {
            return .done(try await api.data(request, session: session, coded: true))
        } catch let refusal as CodedRefusal where refusal.code == "not_blurred" && status == .approved && !asFilmed {
            return .ask(refusal.line)
        } catch APIError.server(409, let line) where status == .approved && !asFilmed {
            return .ask(line)   // a server from before the codes (no `code`): its only 409 here is that question
        }
    }
}

/// What Request changes does besides marking the video, from a part of the app Review itself doesn't know: whatever
/// made the video makes its next cut from the open notes. Throws the server's refusal.
@MainActor
enum ReviewExtras {
    static var requestChanges: ((ReviewAsset) async throws -> Void)?
}
