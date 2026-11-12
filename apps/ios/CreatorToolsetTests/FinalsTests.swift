import XCTest
@testable import CreatorToolset

/// Finals with Ready to post, and the script reader's speed. The JSON is what a test server with a plug-in's Finals
/// list answered on 2026-11-11, trimmed, unless a comment says otherwise; the core library's is from a scratch
/// public server.
final class FinalsTests: XCTestCase {
    /// `GET /api/library?trash=0`: two finals the Media Library holds, sent there from Review.
    private let finals = Data(#"""
    {"folders":[],"stacks":[{"id":1256809450198422,"title":"Client cuts","kind":"reel","folder_id":null,"winner_clip_id":null,"has_cover":false,"updated_at":"2026-11-11T17:36:19.956Z","created_at":"2026-11-11T17:36:19.956Z","posts":{"published":0,"trial":0,"first_posted_at":null,"last_posted_at":null,"max_views":0},"versions":[{"clip_id":1248486577477340,"label":"Hanging basics teaser v2.mp4","position":1,"filename":"Hanging basics teaser v2.mp4","duration":8,"media_type":"video","width":1080,"height":1920,"captions":null,"made_from_clip_id":null,"name":"Hanging basics teaser v2.mp4"}]},{"id":1169117380430094,"title":"Sleep routine reel","kind":"reel","folder_id":null,"winner_clip_id":null,"has_cover":false,"updated_at":"2026-11-11T17:36:20.416Z","created_at":"2026-11-11T17:36:20.416Z","posts":{"published":0,"trial":0,"first_posted_at":null,"last_posted_at":null,"max_views":0},"versions":[{"clip_id":1127346934691213,"label":"V1A-2.mp4","position":1,"filename":"V1A-2.mp4","duration":8,"media_type":"video","width":1080,"height":1920,"captions":null,"made_from_clip_id":null,"name":"V1A-2.mp4"}]}]}
    """#.utf8)

    /// A plug-in's own stacks in the same answer, written from the code that builds them, not captured. A version
    /// still being processed has `clip_id: null`; the last two stacks are broken on purpose.
    private let pluginStacks = Data(#"""
    {"folders":[{"id":1,"name":"Course promos","created_at":"2026-10-01 10:00:00"}],"stacks":[
    {"id":11,"title":"Rolling over: 3 cues","kind":"reel","folder_id":1,"trashed_at":null,"winner_clip_id":101,"created_at":"2026-10-27 15:02:11","updated_at":"2026-10-28 09:30:00","has_cover":0,"versions":[
      {"clip_id":101,"label":"A","position":null,"filename":"RollingOver_V1A_captions.mp4","duration":38.4,"media_type":"video","width":1080,"height":1920,"captions":true,"made_at":"2026-10-27 15:02:11","note":"hook two","name":"V1A","from_broll":false,"posts":[],"made_from_clip_id":102},
      {"clip_id":102,"label":"B","position":null,"filename":"RollingOver_V1A_clean.mp4","duration":38.4,"media_type":"video","width":1080,"height":1920,"captions":false,"made_at":"2026-10-27 15:01:40","note":"","name":"","from_broll":false,"posts":[],"made_from_clip_id":null},
      {"clip_id":null,"ingest_id":9001,"label":null,"position":null,"filename":"RollingOver_V1B.mp4","duration":null,"media_type":"video","width":null,"height":null,"captions":null,"made_at":"2026-11-11 09:00:00","note":"","name":"","from_broll":false,"processing":true,"step":"Waiting to start","failed":null}],
     "posts":{"published":1,"trial":0,"first_posted_at":"2026-10-28T09:00:00+00:00","last_posted_at":"2026-10-28T09:00:00+00:00","max_views":48200}},
    {"id":12,"title":"5 carrying positions","kind":"carousel","folder_id":null,"trashed_at":null,"winner_clip_id":null,"created_at":"2026-11-09 08:00:00","updated_at":"2026-11-09 08:00:00","has_cover":0,"versions":[
      {"clip_id":122,"label":"B","position":1,"filename":"CarryingPositions_2.jpg","duration":null,"media_type":"image","width":1080,"height":1350,"captions":null,"made_at":"2026-11-09 08:00:00","note":"","name":"","from_broll":false,"posts":[],"made_from_clip_id":null},
      {"clip_id":121,"label":"A","position":0,"filename":"CarryingPositions_1.jpg","duration":null,"media_type":"image","width":1080,"height":1350,"captions":null,"made_at":"2026-11-09 08:00:00","note":"","name":"","from_broll":false,"posts":[],"made_from_clip_id":null}],
     "posts":{"published":0,"trial":0,"first_posted_at":null,"last_posted_at":null,"max_views":0}},
    {"id":14,"title":"Bath time reel","kind":"reel","folder_id":null,"trashed_at":null,"winner_clip_id":null,"created_at":"2026-11-11 09:10:00","updated_at":"2026-11-11 09:10:00","has_cover":0,"versions":[
      {"clip_id":null,"ingest_id":9002,"label":null,"position":null,"filename":"BathTime_V1A.mp4","duration":null,"media_type":"video","width":null,"height":null,"captions":null,"made_at":"2026-11-11 09:10:00","note":"","name":"","from_broll":false,"processing":true,"step":"Waiting to start","failed":null}],
     "posts":{"published":0,"trial":0,"first_posted_at":null,"last_posted_at":null,"max_views":0}},
    {"id":15,"title":null,"versions":[]},
    null],"trash_days":5}
    """#.utf8)

    /// `GET /api/library/workshop`, from a copy of the test server where the second version of
    /// "Sleep routine reel" was sent to Finals, the piece linked to its session with the server's
    /// own route, and one version given a post description of its own. `12` is a plug-in's stack.
    private let links = Data(#"""
    {"pieces":{"12":{"description":"Five carrying positions, from easiest to hardest. Which one is your favourite?\n\n#babycarrying #tinyacrobatics","versions":{},"sessionId":"95725200-492b-44b6-978a-b9c4ade028f7","status":"toPost","files":[]},"1169117380430094":{"description":"Sleep routine reel 👶\n\nSave this for later and send it to a parent who needs it.\n\n#babydevelopment #tummytime #tinyacrobatics","versions":{"1176277119360392":{"text":"The shorter cut: bedtime in three steps. Save it for tonight.\n\n#sleeproutine #tinyacrobatics","label":"V1A-1.mp4","author":"user"}},"sessionId":"40acbd0a-786f-4f8e-92be-1977e142f310","status":"toPost","files":[]}}}
    """#.utf8)

    /// `GET /api/workshop/sessions`: three of the six rows.
    private let sessions = Data(#"""
    [{"id":"95725200-492b-44b6-978a-b9c4ade028f7","owner":"local","title":"5 carrying positions","query":"ways to carry a newborn","status":"writing","projectId":"f24b8e0b-35b9-46a8-8e5e-3d0f438c4062","createdAt":1794417377065,"updatedAt":1794417377065,"statusAt":1794417377074,"sourceIds":[],"sourceCount":0,"draftCount":0,"generating":false,"projectName":"Tiny Acrobatics","kinds":["carousel"],"working":false,"ready":false,"shared":false},{"id":"40acbd0a-786f-4f8e-92be-1977e142f310","owner":"local","title":"Sleep routine reel","query":"an evening routine","status":"toPost","projectId":"f24b8e0b-35b9-46a8-8e5e-3d0f438c4062","createdAt":1794417377004,"updatedAt":1794417377004,"statusAt":1794417377018,"sourceIds":[],"sourceCount":0,"draftCount":0,"generating":false,"projectName":"Tiny Acrobatics","kinds":["reel"],"working":false,"ready":false,"shared":false},{"id":"ebf45a58-9c10-4998-afd9-9352446def64","owner":"local","title":"Rolling cues","query":"signs of a first roll","status":"ready","projectId":"f24b8e0b-35b9-46a8-8e5e-3d0f438c4062","createdAt":1794417376865,"updatedAt":1794417376865,"statusAt":1794417376887,"sourceIds":[],"sourceCount":0,"draftCount":0,"generating":false,"projectName":"Tiny Acrobatics","kinds":["reel"],"working":false,"ready":false,"shared":false}]
    """#.utf8)

    /// `GET /api/editor`: two of the five rows (one edit made for a session, one not).
    private let edits = Data(#"""
    [{"id":"00862de2-6a2b-4311-b87f-b53cf13da55c","name":"Rolling cues","cam":"/Volumes/Shoots/tiny-acrobatics/rolling","updatedAt":1794419218956,"drafts":0,"busy":true,"stage":"editing","waiting":0,"usage":{"calls":1,"input":18400,"output":2150,"cache_read":96000,"cache_write":4200,"thinking":3100,"cost_usd":0.39,"ms":41000}},{"id":"3215990a-fd60-4077-8306-9a2762ab6b67","name":"Tummy time: 3 mistakes","cam":"/Volumes/Shoots/tiny-acrobatics/tummy-time","updatedAt":1794418615106,"session":"19202779-569d-4f33-ab8f-dc35b5ab9bde","drafts":1,"busy":false,"stage":"editing","waiting":1,"usage":{"calls":3,"input":55200,"output":6450,"cache_read":288000,"cache_write":12600,"thinking":9300,"cost_usd":3.22,"ms":123000}}]
    """#.utf8)

    /// `GET /api/workshop/sessions/:id/shares`, from the same copy: a team link through which
    /// two files came back. The link's token is replaced by zeros (a link is a key).
    private let shares = Data(#"""
    {"shares":[{"token":"00000000-0000-4000-8000-000000000000","owner":"local","sessionId":"f983b76c-3796-415b-b520-1973410540c4","all":true,"docIds":[],"title":"Hanging basics","createdAt":1794419185472,"deliveries":[{"id":"672771d7-f1a8-408a-b6a8-414ff273eb25","name":"Hanging-basics-final.mp4","size":1845404,"type":"video/mp4","by":"Editor","at":1794419185525},{"id":"44623bf4-5ff8-4025-b5d8-2cba901e7a19","name":"Hanging-basics-cover.jpg","size":73710,"type":"image/jpeg","by":"Editor","at":1794419185575}]}]}
    """#.utf8)

    /// The core library's Finals collection (`GET /api/library/:id/pieces?collectionId=`) and its Workshop links
    /// (`GET /api/library/workshop`), from a scratch public server: one piece linked to a session, its version given a
    /// post description of its own.
    private let corePieces = Data(#"""
    {"pieces":[{"id":"pce_c703d70c51374916","label":"Rolling cues reel","collectionId":"col_6c3f5a52830a46bd","createdBy":"admin","coverUrl":null,"items":[{"id":"pci_f5ae7469df924ee1","label":null,"position":1,"winner":false,"versionId":"e9afe12b-c761-4f78-b774-22daca1ba0b8","externalRef":null,"postDescription":"Three cues before a roll. Save it for later.\n\n#tinyacrobatics","postings":[]}]}]}
    """#.utf8)
    private let coreLinks = Data(#"""
    {"pieces":{"pce_c703d70c51374916":{"description":"","versions":{"pci_f5ae7469df924ee1":{"text":"Three cues before a roll. Save it for later.\n\n#tinyacrobatics","author":"user"}},"sessionId":"267e2d77-b839-44d6-92dd-26d21bb5c73f","status":"toPost"}}}
    """#.utf8)

    private func session(_ id: String, _ title: String, _ status: WorkshopStatus, kinds: [String] = ["reel"]) -> WorkshopSession {
        WorkshopSession(id: id, title: title, status: status, kinds: kinds, projectName: nil, updatedAt: 0, posted: nil)
    }

    func testTheFinalsListReadsAndSurvivesTheSavedCopy() throws {
        let data = try ToolsetAPI.snake.decode(FinalsData.self, from: finals)
        XCTAssertEqual(data.stacks.map(\.id), ["1256809450198422", "1169117380430094"])   // above 2^50, whole
        let reel = data.stacks[1]
        XCTAssertEqual(reel.versions.map(\.title), ["V1A-2"])            // the version's name, without ".mp4"
        XCTAssertEqual(reel.summary, "Reel · 0:08")
        XCTAssertEqual(reel.coverPath, "/api/library/media/1127346934691213/thumb")
        XCTAssertNotEqual(reel.when.date, .distantPast)
        XCTAssertFalse(reel.when.posted)
        // the list is kept on the phone between launches: written and read back, it is the same list
        let saved = try JSONDecoder().decode(FinalsData.self, from: JSONEncoder().encode(data))
        XCTAssertEqual(saved, data)
    }

    func testAFinalStillBeingProcessedNeverBreaksTheList() throws {
        let data = try ToolsetAPI.snake.decode(FinalsData.self, from: pluginStacks)
        XCTAssertEqual(data.stacks.map(\.id), ["11", "12", "14"])               // the stack without a title and the null are left out
        XCTAssertEqual(data.showable.stacks.map(\.id), ["11", "12"])          // nothing of "Bath time reel" can be shown yet
        let reel = data.stacks[0]
        XCTAssertEqual(reel.versions.map(\.clipId), ["101", "102"])           // the version without a clip is left out
        XCTAssertEqual(reel.versions.map(\.title), ["V1A", "B"])
        XCTAssertEqual(reel.versions[0].facts, "Captions · 0:38 · hook two")
        XCTAssertEqual(reel.versions[1].facts, "No captions · 0:38")
        XCTAssertEqual(reel.cover?.clipId, "101")                           // the chosen version
        XCTAssertEqual(reel.summary, "Reel · 0:38")
        XCTAssertTrue(reel.postedLine.hasPrefix("Posted "))
        let carousel = data.stacks[1]
        XCTAssertEqual(carousel.slides.map(\.clipId), ["121", "122"])         // in slide order
        XCTAssertEqual(carousel.summary, "Carousel · 2 slides")
        XCTAssertEqual(data.folders.map(\.name), ["Course promos"])
    }

    func testTheVersionsOwnPostDescriptionIsCopiedElseTheSessions() throws {
        let all = try JSONDecoder().decode(FinalsLinks.self, from: links)
        let link = try XCTUnwrap(all.link(of: "1169117380430094"))
        XCTAssertEqual(link.sessionId, "40acbd0a-786f-4f8e-92be-1977e142f310")
        XCTAssertEqual(postDescription(for: "1176277119360392", link: link, docs: [])?.hasPrefix("The shorter cut"), true)
        XCTAssertEqual(postDescription(for: "1127346934691213", link: link, docs: [])?.hasPrefix("Sleep routine reel"), true)
        XCTAssertEqual(postDescription(for: nil, link: all.link(of: "12"), docs: [])?.hasPrefix("Five carrying positions"), true)
        XCTAssertNil(all.link(of: "11"))

        // no link, or a link without words: the session's own piece; picture marks never get copied
        let doc = WorkshopDoc(id: "d", kind: "reel", title: "t", blocks: [], hooks: nil,
                              caption: WorkshopCompanion(text: "![cover](pic:1) Words to post  "), pinned: nil)
        XCTAssertEqual(postDescription(for: "7", link: nil, docs: [doc]), "Words to post")
        let empty = FinalsLinks.Link(sessionId: "s", description: "", versions: [:])
        XCTAssertEqual(postDescription(for: "7", link: empty, docs: [doc]), "Words to post")
        XCTAssertNil(postDescription(for: "7", link: empty, docs: []))
    }

    func testReadyToPostShowsEachSessionWithItsFinal() throws {
        let rows = try JSONDecoder().decode(Lossy<WorkshopSession>.self, from: sessions).wrappedValue
        let pieces = try ToolsetAPI.snake.decode(FinalsData.self, from: finals).stacks
        let linked = try JSONDecoder().decode(FinalsLinks.self, from: links)
        func ready(_ sessions: [WorkshopSession], links: FinalsLinks = FinalsLinks(), edits: [FinalsEdit] = []) -> [ReadyToPost] {
            ReadyToPost.list(sessions: sessions, pieces: pieces,
                             made: FinalsSessions(pieces: pieces, sessions: sessions, links: links, edits: edits))
        }

        // only the session that is ready to post; nobody linked its final, so it is found by its name
        let byName = ready(rows)
        XCTAssertEqual(byName.map(\.session.title), ["Sleep routine reel"])
        XCTAssertEqual(byName[0].piece?.id, "1169117380430094")
        XCTAssertEqual(byName[0].line, "Reel · 0:08")
        XCTAssertEqual(ready(rows, links: linked)[0].piece?.id, "1169117380430094")   // and by the server's link

        // a cut the AI Editor sent to Finals is named after the edit: the edit says which session it is for
        let teaser = session("s1", "Hanging: the teaser", .toPost)
        let through = ready([teaser], edits: [FinalsEdit(name: "Client cuts", session: "s1")])
        XCTAssertEqual(through[0].piece?.title, "Client cuts")

        // a linked final is its session's alone, whatever another session is called
        let twin = session("s2", "Sleep routine reel", .toPost)
        XCTAssertNil(ready([twin, rows[1]], links: linked)[0].piece)

        // nothing made yet: the card still shows, with the kind alone
        let bare = ready([session("s3", "Brand new", .toPost), session("s4", "Slides", .toPost, kinds: ["carousel"])])
        XCTAssertEqual(bare.map(\.piece), [nil, nil])
        XCTAssertEqual(bare.map(\.line), ["Reel", "Carousel"])
        XCTAssertEqual(FinalsSessions.nameKey("Tummy time: 3 mistakes"), "tummytime3mistakes")
    }

    func testTheEditsReadWithOrWithoutASession() throws {
        let list = try JSONDecoder().decode(Lossy<FinalsEdit>.self, from: edits).wrappedValue
        XCTAssertEqual(list.map(\.name), ["Rolling cues", "Tummy time: 3 mistakes"])
        XCTAssertEqual(list.map(\.session), [nil, "19202779-569d-4f33-ab8f-dc35b5ab9bde"])
    }

    func testFilesThatCameBackThroughAShareLink() throws {
        struct Answer: Decodable { let shares: [WorkshopShare] }
        let share = try XCTUnwrap(JSONDecoder().decode(Answer.self, from: shares).shares.first)
        XCTAssertEqual(share.all, true)
        let files = (share.deliveries ?? []).map { WorkshopFile(token: share.token, delivery: $0) }
        XCTAssertEqual(files.map(\.isVideo), [true, false])
        XCTAssertEqual(files[0].path, "/api/workshop-share/00000000-0000-4000-8000-000000000000/deliveries/672771d7-f1a8-408a-b6a8-414ff273eb25")
        let items = files.map(FinalItem.init)
        XCTAssertEqual(items.map(\.name), ["Hanging-basics-final", "Hanging-basics-cover"])
        XCTAssertEqual(items.map(\.isImage), [false, true])
        XCTAssertEqual(items.map(\.filename), ["Hanging-basics-final.mp4", "Hanging-basics-cover.jpg"])   // saved under its own name
        XCTAssertNil(items[0].clip)
        XCTAssertNil(items[0].key)
    }

    /// A server without a plug-in's list: its library's Finals collection reads as the same list, with no dates or
    /// kinds, and the version's own post description is found by its piece item.
    func testTheCoreLibrarysFinalsReadAsTheSameList() throws {
        struct Pieces: Decodable { let pieces: [Piece] }
        let data = FinalsData(core: try JSONDecoder().decode(Pieces.self, from: corePieces).pieces).showable
        let piece = try XCTUnwrap(data.stacks.first)
        XCTAssertEqual(piece.title, "Rolling cues reel")
        XCTAssertNil(piece.type)
        XCTAssertEqual(piece.summary, "Reel")
        XCTAssertEqual(piece.postedLine, "")                       // no date to say
        XCTAssertEqual(piece.when.date, .distantPast)
        let version = try XCTUnwrap(piece.versions.first)
        XCTAssertEqual(piece.coverPath, "/api/library/media/\(version.clipId)/thumb")
        let item = FinalItem(version)
        XCTAssertEqual(item.download, "/api/library/media/\(version.clipId)/source")
        XCTAssertEqual(item.play, "/api/library/media/\(version.clipId)/play")

        let links = try JSONDecoder().decode(FinalsLinks.self, from: coreLinks)
        let link = try XCTUnwrap(links.link(of: piece.id))
        XCTAssertEqual(postDescription(for: item.key, link: link, docs: [])?.hasPrefix("Three cues before a roll."), true)
        let made = FinalsSessions(pieces: data.stacks, sessions: [session(link.sessionId, "Rolling cues reel", .toPost)],
                                  links: links, edits: [])
        XCTAssertTrue(made.sure(of: piece))
        // kept on the phone between launches
        XCTAssertEqual(try JSONDecoder().decode(FinalsData.self, from: JSONEncoder().encode(data)), data)
    }

    /// 0.5×, 1×, 1.5×, 2× are points per second underneath (1× = 25), the setting the camera reads too.
    func testScrollSpeedStepsAndPointsPerSecond() {
        XCTAssertEqual([12.5, 25, 37.5, 50].map(ScrollSpeed.label), ["0.5×", "1×", "1.5×", "2×"])
        XCTAssertEqual([12.5, 25, 37.5, 50].map(ScrollSpeed.next(after:)), [25, 37.5, 50, 12.5])
        // a speed left by the old slider (5 to 80) shows as it is and joins the steps on the next tap
        XCTAssertEqual(ScrollSpeed.label(33), "1.3×")
        XCTAssertEqual(ScrollSpeed.next(after: 33), 37.5)
        XCTAssertEqual(ScrollSpeed.next(after: 80), 12.5)
        XCTAssertEqual(ScrollSpeed.next(after: 5), 12.5)
    }

    func testACarouselOnlySessionIsNeverToFilm() throws {
        let rows = try JSONDecoder().decode(Lossy<WorkshopSession>.self, from: sessions).wrappedValue
        XCTAssertEqual(rows.filter(\.toFilm).map(\.title), ["Rolling cues"])
        XCTAssertFalse(session("c", "Slides", .ready, kinds: ["carousel"]).toFilm)       // designed, never filmed
        XCTAssertTrue(session("m", "Both", .production, kinds: ["carousel", "reel"]).toFilm)
        XCTAssertEqual(rows.map(\.kindLabel), ["Carousel", "Reel", "Reel"])
    }
}
