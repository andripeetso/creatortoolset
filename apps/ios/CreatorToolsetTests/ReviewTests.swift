import XCTest
@testable import CreatorToolset

/// Review on the phone: the server's own answers decode, comments come out as threads in the
/// order they are shown, a new comment is posted in the right shape, and a link opens its version.
final class ReviewTests: XCTestCase {
    /// `GET /api/review/assets/:id` as the test server answered it (fixtures/review-asset.json):
    /// a video with two versions, changes requested, replies from the AI and one resolved thread.
    private let assetJSON = #"""
    {"asset":{"id":"9f3d4416-935a-4045-9880-cfc5e24614c4","name":"V1A-2","approval":{"status":"changes","by":"local","at":1794417383224},"versions":[{"n":1,"name":"V1A-1.mp4","duration":10,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":true,"timelineFile":"V1A-1.view.json","edit":{"project":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","draft":"V1A-1"},"source":{"kind":"ai-edit","id":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","label":"Sleep routine reel, V1A-1","href":"/editor/840e7e5e-48c6-4e14-ae4d-8924aa0a3267/V1A-1"},"bytes":2233381,"removed":false,"createdAt":1794417380599},{"n":2,"name":"V1A-2.mp4","duration":8,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":true,"timelineFile":"V1A-2.view.json","edit":{"project":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","draft":"V1A-2"},"source":{"kind":"ai-edit","id":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","label":"Sleep routine reel, V1A-2","href":"/editor/840e7e5e-48c6-4e14-ae4d-8924aa0a3267/V1A-2"},"bytes":1845404,"removed":false,"createdAt":1794417381761}],"download":true,"owner":"local","share":null,"projectId":"ded05e8b-467a-4047-b89f-29f19e1b3973","done":null,"createdAt":1794417380599},"comments":[{"id":"1d36abd1-574b-49f9-95c9-41425f876751","version":1,"t":2.5,"text":"Cut the pause here.","author":"local","user":"local","createdAt":1794417381706,"resolved":true,"mine":true},{"id":"6f1b4218-3e72-403b-8ce4-df9aaba8d688","version":1,"t":6,"tEnd":7.5,"text":"Can we see the stretch on the mat here?","author":"local","user":"local","createdAt":1794417381719,"mine":true},{"id":"9aa1937a-ec91-49d5-9f6c-887c0a49350d","version":1,"parentId":"1d36abd1-574b-49f9-95c9-41425f876751","text":"Changed in V1A-2: Closed the pause: the cut now lands on the next word.","author":"AI Editor","createdAt":1794417381756,"mine":false},{"id":"4e0c34af-939e-462b-9156-e8bcbbc758d4","version":1,"parentId":"6f1b4218-3e72-403b-8ce4-df9aaba8d688","text":"There is no certified clip of the mat stretch yet. Add one to the Media Library and ask again.","author":"AI Editor","createdAt":1794417381756,"mine":false},{"id":"704937e6-7787-4864-b7e2-a428c02c391f","version":2,"t":6.8,"text":"Still a beat too long before the call to action.","author":"local","user":"local","createdAt":1794417383222,"mine":true}],"manage":true,"user":"local"}
    """#

    /// `GET /api/review` as the test server answered it (fixtures/review-list.json; the share link's token cut short).
    private let listJSON = #"""
    [{"id":"ca5463a2-36d1-46dc-9f41-3ae5c54a4d2f","name":"Hanging basics teaser v2","approval":{"status":"approved","by":"local","at":1794417464101},"versions":[{"n":1,"name":"Hanging basics teaser.mp4","duration":10,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":false,"bytes":2233381,"removed":false,"createdAt":1794417377106},{"n":2,"name":"Hanging basics teaser v2.mp4","duration":8,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":false,"bytes":1845404,"removed":false,"createdAt":1794417378215}],"download":true,"owner":"local","share":{"token":"79d99b08","enabled":true,"download":true},"projectId":"eadcd7d2-bf51-4e16-a69b-87b5c69d1e0c","done":null,"createdAt":1794417377106,"comments":2,"newComments":0,"updatedAt":1794417464101},{"id":"ef173602-861d-44e0-8529-894f2a06243e","name":"V1A-1","approval":{"status":"needs_review","by":"AI Editor","at":1794417379401},"versions":[{"n":1,"name":"V1A-1.mp4","duration":10,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":true,"timelineFile":"V1A-1.view.json","edit":{"project":"3215990a-fd60-4077-8306-9a2762ab6b67","draft":"V1A-1"},"source":{"kind":"ai-edit","id":"3215990a-fd60-4077-8306-9a2762ab6b67","label":"Tummy time: 3 mistakes, V1A-1","href":"/editor/3215990a-fd60-4077-8306-9a2762ab6b67/V1A-1"},"bytes":2233381,"removed":false,"createdAt":1794417379392}],"download":true,"owner":"local","share":null,"projectId":"78731bcb-c11c-427a-b0d1-109f8f674486","done":null,"createdAt":1794417379392,"comments":1,"newComments":0,"updatedAt":1794417388812},{"id":"9f3d4416-935a-4045-9880-cfc5e24614c4","name":"V1A-2","approval":{"status":"changes","by":"local","at":1794417383224},"versions":[{"n":1,"name":"V1A-1.mp4","duration":10,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":true,"timelineFile":"V1A-1.view.json","edit":{"project":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","draft":"V1A-1"},"source":{"kind":"ai-edit","id":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","label":"Sleep routine reel, V1A-1","href":"/editor/840e7e5e-48c6-4e14-ae4d-8924aa0a3267/V1A-1"},"bytes":2233381,"removed":false,"createdAt":1794417380599},{"n":2,"name":"V1A-2.mp4","duration":8,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":true,"timelineFile":"V1A-2.view.json","edit":{"project":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","draft":"V1A-2"},"source":{"kind":"ai-edit","id":"840e7e5e-48c6-4e14-ae4d-8924aa0a3267","label":"Sleep routine reel, V1A-2","href":"/editor/840e7e5e-48c6-4e14-ae4d-8924aa0a3267/V1A-2"},"bytes":1845404,"removed":false,"createdAt":1794417381761}],"download":true,"owner":"local","share":null,"projectId":"ded05e8b-467a-4047-b89f-29f19e1b3973","done":null,"createdAt":1794417380599,"comments":1,"newComments":0,"updatedAt":1794417388718}]
    """#

    private func detail() throws -> ReviewDetail {
        try JSONDecoder().decode(ReviewDetail.self, from: Data(assetJSON.utf8))
    }

    func testTheServersAnswersDecode() throws {
        let detail = try detail()
        XCTAssertEqual(detail.asset.name, "V1A-2")
        XCTAssertEqual(ReviewStatus(rawValue: detail.asset.approval.status), .changes)
        XCTAssertEqual(detail.asset.approval.by, "local")
        XCTAssertEqual(detail.asset.versions.map(\.n), [1, 2])
        XCTAssertEqual(detail.asset.versions.map(\.status), ["ready", "ready"])
        XCTAssertEqual(detail.manage, true)
        XCTAssertEqual(detail.comments.count, 5)
        // a comment about a stretch of the video, not yet resolved: `resolved` is left out, not false
        let stretch = try XCTUnwrap(detail.comments.first { $0.tEnd != nil })
        XCTAssertEqual(stretch.timeLabel, "0:06–0:07")
        XCTAssertEqual(stretch.mine, true)
        XCTAssertNil(stretch.resolved)
        // a reply has no time, and the AI's is not the person's own
        let reply = try XCTUnwrap(detail.comments.first { $0.parentId != nil })
        XCTAssertEqual(reply.author, "AI Editor")
        XCTAssertEqual(reply.mine, false)
        XCTAssertNil(reply.timeLabel)

        let list = try JSONDecoder().decode([ReviewAsset].self, from: Data(listJSON.utf8))
        XCTAssertEqual(list.map(\.name), ["Hanging basics teaser v2", "V1A-1", "V1A-2"])
        XCTAssertEqual(list.map(\.approval.status), ["approved", "needs_review", "changes"])
        XCTAssertEqual(list.map(\.comments), [2, 1, 1])
        XCTAssertEqual(list.map { $0.latest?.n }, [2, 1, 2])
        let cut = list[1]
        XCTAssertEqual(cut.media(try XCTUnwrap(cut.latest), "play"), "/api/review/assets/\(cut.id)/v/1/play?c=1794417379392")
    }

    /// What the server answers to a reply, a resolve and an approval (fixtures/review-comment-post.json,
    /// review-comment-patch.json, review-approval-post.json with the share link's token cut short): the screen
    /// shows these at once instead of reading the whole video again.
    func testTheAnswersOfWritesDecode() throws {
        let reply = try JSONDecoder().decode(ReviewComment.self, from: Data(#"""
        {"id":"86022905-2612-4d18-b4f6-19ad527cfc3d","version":2,"parentId":"9d308e85-5fb4-4b4a-8902-aa4f8891bbbb","text":"Seen on the phone.","author":"local","user":"local","createdAt":1794417464084,"mine":true}
        """#.utf8))
        XCTAssertEqual(reply.parentId, "9d308e85-5fb4-4b4a-8902-aa4f8891bbbb")
        XCTAssertEqual(reply.text, "Seen on the phone.")
        XCTAssertNil(reply.t)
        let resolved = try JSONDecoder().decode(ReviewComment.self, from: Data(#"""
        {"id":"9d308e85-5fb4-4b4a-8902-aa4f8891bbbb","version":2,"t":2,"tEnd":4.5,"text":"Love this stretch, keep it exactly like this.","author":"local","user":"local","createdAt":1794417379261,"resolved":true,"mine":true}
        """#.utf8))
        XCTAssertEqual(resolved.resolved, true)
        XCTAssertEqual(resolved.timeLabel, "0:02–0:04")
        let approved = try JSONDecoder().decode(ReviewAsset.self, from: Data(#"""
        {"id":"ca5463a2-36d1-46dc-9f41-3ae5c54a4d2f","name":"Hanging basics teaser v2","approval":{"status":"approved","by":"local","at":1794417464101},"versions":[{"n":1,"name":"Hanging basics teaser.mp4","duration":10,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":false,"bytes":2233381,"removed":false,"createdAt":1794417377106},{"n":2,"name":"Hanging basics teaser v2.mp4","duration":8,"fps":30,"width":1080,"height":1920,"status":"ready","progress":1,"captioned":false,"timeline":false,"bytes":1845404,"removed":false,"createdAt":1794417378215}],"download":true,"owner":"local","share":{"token":"79d99b08","enabled":true,"download":true},"projectId":"eadcd7d2-bf51-4e16-a69b-87b5c69d1e0c","done":null,"createdAt":1794417377106}
        """#.utf8))
        XCTAssertEqual(ReviewStatus(rawValue: approved.approval.status), .approved)
        XCTAssertNil(approved.comments)   // the list's counts are not in this answer
        XCTAssertEqual(approved.opening(nil), 2)
    }

    func testCommentsBecomeThreadsInTheOrderShown() throws {
        let comments = try detail().comments
        let first = comments.threads(version: 1)
        XCTAssertEqual(first.map(\.comment.text), ["Cut the pause here.", "Can we see the stretch on the mat here?"])
        XCTAssertEqual(first.map { $0.replies.map(\.author) }, [["AI Editor"], ["AI Editor"]])
        XCTAssertEqual(first[0].replies.first?.parentId, first[0].comment.id)
        XCTAssertEqual(first[0].comment.resolved, true)   // a resolved thread stays in the list
        XCTAssertEqual(comments.threads(version: 2).map(\.comment.t), [6.8])
        XCTAssertTrue(comments.threads(version: 3).isEmpty)

        // made-up comments to pin the order: by the moment in the video, then by when written;
        // the ones about the whole video after them; replies under their comment, oldest first
        func comment(_ id: String, t: Double? = nil, at: Double, under parent: String? = nil) -> ReviewComment {
            ReviewComment(id: id, version: 1, parentId: parent, t: t, text: id, author: "a", resolved: nil, createdAt: at)
        }
        let mixed = [
            comment("whole-late", at: 9), comment("reply-2", at: 8, under: "at-5"), comment("at-5", t: 5, at: 3),
            comment("whole-early", at: 1), comment("at-5-later", t: 5, at: 4), comment("at-1", t: 1, at: 7),
            comment("reply-1", at: 6, under: "at-5"),
        ]
        let threads = mixed.threads(version: 1)
        XCTAssertEqual(threads.map(\.id), ["at-1", "at-5", "at-5-later", "whole-early", "whole-late"])
        XCTAssertEqual(threads[1].replies.map(\.id), ["reply-1", "reply-2"])
        XCTAssertTrue(threads[0].replies.isEmpty)
    }

    func testWhatIsPostedForAComment() {
        // at a moment of the video, to the hundredth of a second
        XCTAssertEqual(ReviewComment.body(version: 2, text: "Too long", t: 6.8349, parentId: nil) as NSDictionary,
                       ["version": 2, "text": "Too long", "t": 6.83] as NSDictionary)
        // about the whole video
        XCTAssertEqual(ReviewComment.body(version: 2, text: "Good to post", t: nil, parentId: nil) as NSDictionary,
                       ["version": 2, "text": "Good to post"] as NSDictionary)
        // a reply never carries a time, whatever the player shows
        let reply = ReviewComment.body(version: 1, text: "Seen", t: 3, parentId: "c1")
        XCTAssertEqual(reply as NSDictionary, ["version": 1, "text": "Seen", "parentId": "c1"] as NSDictionary)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(reply))
    }

    func testWhichVersionALinkOpens() throws {
        let asset = try detail().asset
        XCTAssertEqual(asset.opening(2), 2)
        XCTAssertEqual(asset.opening(1), 1)
        XCTAssertEqual(asset.opening(nil), 2)   // no version named: the newest
        XCTAssertEqual(asset.opening(7), 2)     // a version the video hasn't got: the newest
    }
}
