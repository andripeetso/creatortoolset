import WebKit
import XCTest
@testable import CreatorToolset

/// Against a real server, skipped without one:
///   TEST_RUNNER_CT_TEST_SERVER=http://127.0.0.1:43127 TEST_RUNNER_CT_TEST_PASSWORD=<APP_SECRET> xcodebuild … test
/// Signs in as `admin`, uploads a 70 MB file in three chunks through the background session, uploads it again (the
/// server says it is a duplicate), and reads the screens' routes. `testRealContent` seeds a script, a post and a Finals
/// piece of a real video, and loads them the way the screens do.
@MainActor
final class ServerTests: XCTestCase {
    private var origin: URL!
    private var password = ""

    override func setUp() async throws {
        let env = ProcessInfo.processInfo.environment
        guard let raw = env["CT_TEST_SERVER"], let url = URL(string: raw) else { throw XCTSkip("CT_TEST_SERVER not set") }
        origin = SignIn.parse(url.absoluteString)!.origin
        password = env["CT_TEST_PASSWORD"] ?? ""
    }

    private func signIn() async throws -> String? {
        let first = try await SignIn.connect(SignIn.Target(origin: origin, linkPath: nil))
        if first != .needsPassword {
            guard case .signedIn(let cookie, _) = first else { return nil }
            return cookie
        }
        guard case .signedIn(let cookie, let name) = try await SignIn.login(origin, username: "admin", password: password) else {
            XCTFail("no sign-in")
            return nil
        }
        XCTAssertEqual(name, "admin")
        XCTAssertNotNil(cookie)
        return cookie
    }

    func testSignInLink() async throws {
        let cookie = try await signIn()
        struct Link: Decodable { let path: String? }
        let link: Link = try JSONDecoder().decode(Link.self, from: try await API(server: origin, cookie: cookie).send("/api/auth/link"))
        guard let path = link.path else { throw XCTSkip("a server without sign-in has no link") }
        let target = SignIn.parse(origin.absoluteString + path.dropFirst())!
        guard case .signedIn(let fresh, let name) = try await SignIn.connect(target) else { return XCTFail("link refused") }
        XCTAssertEqual(name, "admin")
        XCTAssertNotNil(fresh)
        // the link works once
        do {
            _ = try await SignIn.connect(target)
            XCTFail("a used link signed in")
        } catch APIError.server(let status, let message) {
            XCTAssertEqual(status, 410)
            XCTAssertTrue(message.contains("expired"), message)
        }
    }

    func testUploadAndScreens() async throws {
        let cookie = try await signIn()
        let server = Server(url: origin, username: "admin")
        Servers.shared.add(server, cookie: cookie)
        let api = try XCTUnwrap(Servers.shared.api)

        let engine = UploadEngine.shared
        let name = "tinyacrobatics-\(UUID().uuidString.prefix(8)).mov"
        var bytes = Data(count: 70 << 20)
        bytes.withUnsafeMutableBytes { _ = SecRandomCopyBytes(kSecRandomDefault, 4096, $0.baseAddress!) }
        let first = try await upload(bytes, name: name, engine: engine, server: server)
        XCTAssertEqual(first.state, .done, first.note ?? "")
        XCTAssertFalse(first.duplicate)
        let again = try await upload(bytes, name: "again-" + name, engine: engine, server: server)
        XCTAssertEqual(again.state, .done, again.note ?? "")
        XCTAssertTrue(again.duplicate)

        struct Page: Decodable { let items: [Asset] }
        let found = try await api.firstLibrary()
        let library = try XCTUnwrap(found)
        let page: Page = try await api.get("/api/library/\(library.id)/assets?limit=60")
        XCTAssertTrue(page.items.contains { $0.title.contains(name.dropLast(4)) }, page.items.map(\.title).description)

        let _: [WorkshopSession] = try await api.get("/api/workshop/sessions")
        _ = try await api.finals()
        let chat = try JSONSerialization.jsonObject(with: try await api.send("/api/assistant", method: "GET")) as? [String: Any]
        XCTAssertNotNil(chat?["messages"])
    }

    /// What `ServerPlugins` reads from a live server. `CT_TEST_STUDIO=1` when that server has the studio plug-in.
    func testWhatTheServerHas() async throws {
        let api = API(server: origin, cookie: try await signIn())
        let known = try await ServerPlugins.read(api)
        let studio = ProcessInfo.processInfo.environment["CT_TEST_STUDIO"] == "1"
        XCTAssertEqual(known.plugins.contains(Studio.plugin), studio, known.plugins.description)
        if !studio { XCTAssertNil(known.mainSource) }
    }

    private func upload(_ bytes: Data, name: String, engine: UploadEngine, server: Server) async throws -> UploadItem {
        let id = UUID()
        try bytes.write(to: AppFiles.upload(id))
        engine.add(id: id, filename: name, size: Int64(bytes.count), server: server)
        engine.uploadAll()
        let deadline = Date().addingTimeInterval(180)
        while Date() < deadline {
            if let item = engine.store.item(id), item.state == .done || item.state == .failed { return item }
            try await Task.sleep(for: .milliseconds(300))
        }
        return try XCTUnwrap(engine.store.item(id))
    }

    func testRealContent() async throws {
        let cookie = try await signIn()
        let server = Server(url: origin, username: "admin")
        Servers.shared.add(server, cookie: cookie)
        let api = try XCTUnwrap(Servers.shared.api)

        // a script to film and a post that is ready
        struct Made: Decodable { let id: String }
        let film: Made = try JSONDecoder().decode(Made.self, from: try await api.send(
            "/api/workshop/sessions", json: ["title": "Tiny Acrobatics: first roll", "status": "ready"]))
        try await api.send("/api/workshop/sessions/\(film.id)/docs",
                           json: ["kind": "reel", "title": "Script", "text": "Hook: three rolls in one take."])
        let post: Made = try JSONDecoder().decode(Made.self, from: try await api.send(
            "/api/workshop/sessions", json: ["title": "Tiny Acrobatics: posted", "status": "toPost"]))
        let sessions: [WorkshopSession] = try await api.get("/api/workshop/sessions")
        XCTAssertTrue(sessions.contains { $0.id == film.id && $0.toFilm })
        XCTAssertTrue(sessions.contains { $0.id == post.id && $0.toPost })
        let docs = try await api.sessionDocs(film.id)
        XCTAssertEqual(docs.first?.blocks.first.map { scriptText($0.text) }, "Hook: three rolls in one take.")

        // a real video: uploaded, then its picture and its playback
        let video = try Data(contentsOf: try XCTUnwrap(Bundle(for: Self.self).url(forResource: "tiny", withExtension: "mp4")))
        let name = "tinyacrobatics-final.mp4"
        let item = try await upload(video, name: name, engine: UploadEngine.shared, server: server)
        XCTAssertEqual(item.state, .done, item.note ?? "")
        let found = try await api.firstLibrary()
        let library = try XCTUnwrap(found)
        struct Page: Decodable { let items: [Asset] }
        var asset: Asset?
        for _ in 0..<60 {
            let page: Page = try await api.get("/api/library/\(library.id)/assets?limit=60")
            asset = page.items.first { $0.title.hasPrefix("tinyacrobatics-final") }
            if asset?.thumbUrl != nil, asset?.state == "ready" { break }
            try await Task.sleep(for: .seconds(1))
        }
        let ready = try XCTUnwrap(asset, "the upload is not in the library")
        let thumb = try XCTUnwrap(ready.thumbUrl, "no picture after a minute (state \(ready.state))")
        let picture = try await api.data(api.request(thumb))
        XCTAssertNotNil(UIImage(data: picture), "the picture does not decode")
        let player = api.player("/api/library/media/\(ready.versionId)/play")
        let media = try XCTUnwrap(player.currentItem?.asset)
        let playable = try await media.load(.isPlayable)
        XCTAssertTrue(playable, "the player can't open the video with the sign-in cookie")

        // a Finals piece of it
        struct Collections: Decodable { struct C: Decodable { let id: String; let name: String }; let collections: [C] }
        let all: Collections = try await api.get("/api/library/\(library.id)/collections")
        let finalsId: String
        if let existing = all.collections.first(where: { $0.name == "Finals" }) {
            finalsId = existing.id
        } else {
            let made: Made = try JSONDecoder().decode(Made.self, from: try await api.send(
                "/api/library/\(library.id)/collections", json: ["name": "Finals"]))
            finalsId = made.id
        }
        let piece: Made = try JSONDecoder().decode(Made.self, from: try await api.send(
            "/api/library/\(library.id)/pieces", json: ["label": "Tiny Acrobatics reel", "collectionId": finalsId]))
        try await api.send("/api/library/\(library.id)/pieces/\(piece.id)/items", json: ["versionId": ready.versionId])
        let finals = try await api.finals()
        let shown = try XCTUnwrap(finals.first { $0.id == piece.id }, "the piece is not in Finals")
        XCTAssertEqual(shown.main?.versionId, ready.versionId)
        let cover = try XCTUnwrap(shown.cover)
        let coverData = try await api.data(api.request(cover))
        XCTAssertNotNil(UIImage(data: coverData), "the Finals cover does not decode")
    }

    /// New edit: two clips picked, Start. The edit is there with both uploads waiting before any byte goes; once both
    /// are in, it has them as its sources and its first step (analyze) is queued, without the phone doing more.
    func testNewEdit() async throws {
        let cookie = try await signIn()
        let server = Server(url: origin, username: "admin")
        Servers.shared.add(server, cookie: cookie)
        let api = try XCTUnwrap(Servers.shared.api)
        let engine = UploadEngine.shared
        let edits = PhoneEdits.shared

        // two different clips (the library counts the same bytes once): the synthetic video, each with its own tail
        let video = try Data(contentsOf: try XCTUnwrap(Bundle(for: Self.self).url(forResource: "tiny", withExtension: "mp4")))
        let local = UUID()
        var clips: [UUID] = []
        for n in 1...2 {
            let id = UUID()
            try (video + Data(UUID().uuidString.utf8)).write(to: AppFiles.upload(id))
            engine.add(id: id, filename: "tinyacrobatics-clip\(n).mp4", size: Int64(video.count + 36), server: server, edit: local)
            clips.append(id)
        }
        edits.add(PhoneEdit(id: local, server: server.id, name: "Phone edit, Tiny Acrobatics", clips: clips))

        var waiting: RemoteEdit?
        await edits.start(local) {
            waiting = try await api.get("/api/editor/\(edits.item(local)?.editId ?? "")")
            // no byte has gone yet
            XCTAssertTrue(clips.allSatisfy { engine.store.item($0)?.state == .picked })
        }
        let editId = try XCTUnwrap(edits.item(local)?.editId, edits.item(local)?.problem ?? "no edit")
        XCTAssertEqual(waiting?.sources, [])
        XCTAssertEqual(waiting?.uploads?.map(\.id), clips.map { engine.store.item($0)?.uploadId ?? "" }, "in the order picked")
        XCTAssertEqual(waiting?.uploads?.compactMap(\.version), [])

        var now: RemoteEdit?
        for _ in 0..<180 {
            now = try await api.get("/api/editor/\(editId)")
            if now?.sources?.count == 2 { break }
            try await Task.sleep(for: .seconds(1))
        }
        XCTAssertEqual(now?.sources?.count, 2, clips.map { engine.store.item($0)?.note ?? "" }.description)
        XCTAssertNil(now?.uploads)
        XCTAssertEqual(now?.jobs?.first?.kind, "analyze")

        // the row follows: the copies on the phone are cleared, and it reads Editing (or the step's problem)
        await edits.refresh()
        try await Task.sleep(for: .milliseconds(500))
        XCTAssertTrue(clips.allSatisfy { engine.store.item($0) == nil })
        let row = edits.state(try XCTUnwrap(edits.item(local)))
        XCTAssertTrue(row == .editing || { if case .stuck = row { return true } else { return false } }(), "\(row)")
    }

    /// Try again: the old edit goes to the trash, the clips go again as new uploads (the library has them already, so
    /// they count as themselves), and a fresh edit starts with both.
    func testNewEditTryAgain() async throws {
        let cookie = try await signIn()
        let server = Server(url: origin, username: "admin")
        Servers.shared.add(server, cookie: cookie)
        let api = try XCTUnwrap(Servers.shared.api)
        let engine = UploadEngine.shared
        let edits = PhoneEdits.shared
        let video = try Data(contentsOf: try XCTUnwrap(Bundle(for: Self.self).url(forResource: "tiny", withExtension: "mp4")))
        let local = UUID()
        var clips: [UUID] = []
        for n in 1...2 {
            let id = UUID()
            try (video + Data(UUID().uuidString.utf8)).write(to: AppFiles.upload(id))
            engine.add(id: id, filename: "tinyacrobatics-again\(n).mp4", size: Int64(video.count + 36), server: server, edit: local)
            clips.append(id)
        }
        edits.add(PhoneEdit(id: local, server: server.id, name: "Phone edit, Tiny Acrobatics again", clips: clips))
        await edits.start(local)
        let first = try XCTUnwrap(edits.item(local)?.editId, edits.item(local)?.problem ?? "no edit")
        for _ in 0..<120 where !clips.allSatisfy({ engine.store.item($0)?.state == .done }) {
            try await Task.sleep(for: .seconds(1))
        }

        await edits.retry(local)
        let second = try XCTUnwrap(edits.item(local)?.editId, edits.item(local)?.problem ?? "no new edit")
        XCTAssertNotEqual(second, first)
        do {
            let _: RemoteEdit = try await api.get("/api/editor/\(first)")
            XCTFail("the old edit is still there")
        } catch APIError.server(let status, _) {
            XCTAssertEqual(status, 404)
        }
        var now: RemoteEdit?
        for _ in 0..<120 {
            now = try await api.get("/api/editor/\(second)")
            if now?.sources?.count == 2 { break }
            try await Task.sleep(for: .seconds(1))
        }
        XCTAssertEqual(now?.sources?.count, 2, clips.map { engine.store.item($0)?.note ?? "" }.description)
        XCTAssertTrue(clips.allSatisfy { engine.store.item($0)?.duplicate == true })
        edits.forget(local)
    }

    /// The web view ("Everything else") is signed in with the phone's cookie, on http as on https.
    func testWebViewSignedIn() async throws {
        let cookie = try await signIn()
        guard cookie != nil else { throw XCTSkip("a server without sign-in needs no cookie") }
        let api = API(server: origin, cookie: cookie)
        let web = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 800),
                            configuration: { let c = WKWebViewConfiguration(); c.websiteDataStore = .nonPersistent(); return c }())
        await web.configuration.websiteDataStore.httpCookieStore.setCookie(try XCTUnwrap(api.webCookie))
        web.load(URLRequest(url: api.url("/api/auth/check")))
        var text = ""
        for _ in 0..<50 where !text.contains("authed") {
            try await Task.sleep(for: .milliseconds(200))
            text = (try? await web.evaluateJavaScript("document.body ? document.body.innerText : ''") as? String) ?? ""
        }
        XCTAssertTrue(text.contains("\"authed\":true"), text)
    }
}
