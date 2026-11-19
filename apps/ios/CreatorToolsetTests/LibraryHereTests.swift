import XCTest
@testable import CreatorToolset

/// Answers as the server's library does, and records every request with the workspace it named.
private final class LibraryServer: URLProtocol {
    struct Asked: Equatable {
        let method: String
        let path: String
        let query: String?
        let workspace: String?
        let origin: String?
    }
    nonisolated(unsafe) static var asked: [Asked] = []
    nonisolated(unsafe) static var answer: (URLRequest) -> (Int, [String: String], String) = { _ in (404, [:], "{}") }

    static func session() -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LibraryServer.self]
        return config
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        Self.asked.append(Asked(method: request.httpMethod ?? "GET", path: url.path, query: url.query,
                                workspace: request.value(forHTTPHeaderField: WorkspacePick.header),
                                origin: request.value(forHTTPHeaderField: "x-ct-origin")))
        let (status, headers, body) = Self.answer(request)
        var all = headers
        all["Content-Type"] = "application/json"
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: all)!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// The phone's uploads go to the workspace each clip was queued in, through POST /api/library/here/uploads.
@MainActor
final class LibraryHereUploadTests: XCTestCase {
    private let server = Server(url: URL(string: "https://here-uploads.example.test/")!, username: "sam")
    private var folder: URL!
    private var transfers: [Transfers] = []
    private var made: [UUID] = []

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("library-here-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        Servers.shared.add(server, cookie: nil)
        // a route checked already, so requests go to the server's address
        let entry = try XCTUnwrap(Connections.shared.entry(key: server.id))
        Connections.shared.connected(entry.serverId, route: entry.routes[0])
        LibraryServer.asked = []
        var n = 0
        LibraryServer.answer = { request in
            let path = request.url!.path
            switch (request.httpMethod ?? "GET", path) {
            case ("GET", "/api/library"):
                return (200, [:], #"{"libraries":[{"id":"lib_a","settings":{"upload":"all"}}],"uploadTakes":0}"#)
            case ("POST", "/api/library/here/uploads"):
                n += 1
                return (201, [:], #"{"id":"u\#(n)","offset":0,"chunkSize":1000}"#)
            case ("PATCH", _):
                return (204, ["Upload-Offset": "14"], "")
            case ("POST", _) where path.hasSuffix("/finish"):
                return (200, [:], #"{"assetId":"a","versionId":"v"}"#)
            default:
                return (404, [:], #"{"error":"Not found"}"#)
            }
        }
    }

    override func tearDown() async throws {
        WorkspacePick.set(nil, server: server.id, username: "sam")
        Servers.shared.remove(server.id)
        for t in transfers { t.session.invalidateAndCancel() }
        for id in made {
            try? FileManager.default.removeItem(at: AppFiles.upload(id))
            AppFiles.removeSlices(of: id)
        }
        try? FileManager.default.removeItem(at: folder)
    }

    private var file: URL { folder.appendingPathComponent("uploads.json") }

    private func engine() -> UploadEngine {
        let t = Transfers(configuration: LibraryServer.session())
        transfers.append(t)
        let engine = UploadEngine(transfers: t, store: UploadStore(file: file))
        engine.session = URLSession(configuration: LibraryServer.session())
        return engine
    }

    private func pick(_ workspace: String) { WorkspacePick.set(workspace, server: server.id, username: "sam") }

    /// Three files from Files, queued while `workspace` is picked (their route decided, so the next step is the start).
    private func queue(_ engine: UploadEngine, in workspace: String) throws -> [UUID] {
        pick(workspace)
        return try (0 ..< 3).map { n in
            let id = UUID()
            made.append(id)
            try Data("tinyacrobatics".utf8).write(to: AppFiles.upload(id))
            engine.add(id: id, filename: "clip\(n).mov", size: 14, server: server)
            engine.store.update(id) { $0.route = .library }
            return id
        }
    }

    private func wait(_ what: String, _ done: () -> Bool) async throws {
        for _ in 0 ..< 250 where !done() { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(done(), what)
    }

    private func assertAllInA(_ ids: [UUID], _ engine: UploadEngine) throws {
        XCTAssertEqual(ids.compactMap { engine.store.item($0)?.state }, [.done, .done, .done])
        let starts = LibraryServer.asked.filter { $0.path == "/api/library/here/uploads" }
        XCTAssertEqual(starts.count, 3, "each started through here/uploads")
        XCTAssertTrue(starts.allSatisfy { $0.method == "POST" && $0.origin == "phone" }, "the phone's own send")
        XCTAssertEqual(LibraryServer.asked.filter { $0.method == "PATCH" }.count, 3)
        XCTAssertEqual(LibraryServer.asked.filter { $0.path.hasSuffix("/finish") }.count, 3)
        XCTAssertFalse(LibraryServer.asked.contains { $0.path.hasPrefix("/api/library/lib_a/") }, "never into a library by id")
        let wrong = LibraryServer.asked.filter { $0.workspace != "ws-a" }
        XCTAssertTrue(wrong.isEmpty, "every request names A: \(wrong)")
    }

    func testClipsQueuedInAWorkspaceLandThereAfterASwitch() async throws {
        let engine = engine()
        let ids = try queue(engine, in: "ws-a")
        pick("ws-b")
        XCTAssertEqual(engine.api(for: try XCTUnwrap(engine.store.item(ids[0])))?.workspace, "ws-a")
        engine.uploadAll()
        await engine.reconcile()
        try await wait("all three landed") { ids.allSatisfy { engine.store.item($0)?.state == .done } }
        try assertAllInA(ids, engine)
    }

    func testARelaunchKeepsEachClipsWorkspace() async throws {
        let ids = try queue(engine(), in: "ws-a")
        UploadStore.disk.sync {}
        pick("ws-b")

        // the next run of the app reads the queue from disk
        let again = engine()
        XCTAssertEqual(ids.compactMap { again.store.item($0)?.workspace }, ["ws-a", "ws-a", "ws-a"])
        again.uploadAll()
        await again.reconcile()
        try await wait("all three landed after the relaunch") { ids.allSatisfy { again.store.item($0)?.state == .done } }
        try assertAllInA(ids, again)
    }

    func testARefusedStartShowsItsOneLine() async throws {
        for (status, body, line) in [
            (403, #"{"error":"This account can't add footage to that workspace","code":"forbidden"}"#, "This account can't add footage to that workspace"),
            (409, #"{"error":"This workspace's uploads go somewhere else","code":"conflict","target":"store"}"#, "This workspace's uploads go somewhere else"),
        ] {
            let previous = LibraryServer.answer
            LibraryServer.answer = { request in
                request.url!.path == "/api/library/here/uploads" ? (status, [:], body) : previous(request)
            }
            defer { LibraryServer.answer = previous }
            let engine = engine()
            let id = try queue(engine, in: "ws-a")[0]
            engine.retry(id)
            await engine.reconcile()
            try await wait("\(status): failed") { engine.store.item(id)?.state == .failed }
            XCTAssertEqual(engine.store.item(id)?.note, line, "\(status)")
        }
    }

    /// On a server with the studio plug-in, each clip goes where its own workspace's uploads go (GET /api/upload-target
    /// in that workspace), asked once per workspace; a refusal fails the clip with the server's line.
    func testEachClipGoesWhereItsWorkspaceSends() async throws {
        let previous = LibraryServer.answer
        LibraryServer.answer = { request in
            switch (request.url!.path, request.value(forHTTPHeaderField: WorkspacePick.header)) {
            case ("/api/plugins", _): return (200, [:], #"{"plugins":[{"id":"\#(Studio.plugin)"}]}"#)
            case ("/api/upload-target", "ws-a"): return (200, [:], #"{"target":"catalog"}"#)
            case ("/api/upload-target", "ws-b"): return (200, [:], #"{"target":"library"}"#)
            case ("/api/upload-target", _):
                return (403, [:], #"{"error":"This account can't add footage to that workspace","code":"forbidden"}"#)
            default: return previous(request)
            }
        }
        defer { LibraryServer.answer = previous }
        let engine = engine()
        func clip(in workspace: String) throws -> UUID {
            pick(workspace)
            let id = UUID()
            made.append(id)
            try Data("tinyacrobatics".utf8).write(to: AppFiles.upload(id))
            engine.add(id: id, filename: "clip.mov", size: 14, server: server)
            return id
        }
        let a = try clip(in: "ws-a"), b1 = try clip(in: "ws-b"), b2 = try clip(in: "ws-b"), c = try clip(in: "ws-c")
        pick("ws-a")

        for id in [b1, b2] {
            engine.store.move(id, to: .preparing)
            await engine.prepare(id)
        }
        try await wait("both B clips landed") { [b1, b2].allSatisfy { engine.store.item($0)?.state == .done } }
        XCTAssertEqual([b1, b2].compactMap { engine.store.item($0)?.route }, [.library, .library])
        let starts = LibraryServer.asked.filter { $0.path == "/api/library/here/uploads" }
        XCTAssertEqual(starts.map(\.workspace), ["ws-b", "ws-b"], "into B's own library, with B's header")
        XCTAssertEqual(LibraryServer.asked.filter { $0.path == "/api/upload-target" }.map(\.workspace), ["ws-b"],
                       "asked once for B, not per clip")

        let aItem = try XCTUnwrap(engine.store.item(a))
        let aRoute = try await engine.route(for: aItem, api: try XCTUnwrap(engine.api(for: aItem)))
        XCTAssertEqual(aRoute, .catalog, "A's clip goes to the catalog")

        engine.store.move(c, to: .preparing)
        await engine.prepare(c)
        XCTAssertEqual(engine.store.item(c)?.state, .failed)
        XCTAssertEqual(engine.store.item(c)?.note, "This account can't add footage to that workspace")
        XCTAssertFalse(LibraryServer.asked.contains { $0.path == "/api/library/here/uploads" && $0.workspace != "ws-b" })
    }
}

/// The phone's Media Library asks the server for its folders and searches as the website's page does.
final class LibraryListingTests: XCTestCase {
    private let session = URLSession(configuration: LibraryServer.session())
    private var api: API {
        var api = API(server: URL(string: "https://listing.example.test/")!, cookie: nil)
        api.workspace = "ws-a"
        return api
    }
    private let asset = #"{"id":"a1","kind":"video","title":"Beach day","versionId":"v1","thumbUrl":"/api/library/media/v1/thumb","state":"ready"}"#

    override func setUp() {
        LibraryServer.asked = []
        let asset = asset
        LibraryServer.answer = { request in
            switch request.url!.path {
            case "/api/library": return (200, [:], #"{"libraries":[{"id":"lib_a","name":"Library"},{"id":"lib_b","name":"Other"}]}"#)
            case "/api/library/lib_a/collections":
                return (200, [:], """
                {"collections":[
                  {"id":"fin","name":"Finals","parentId":null,"kind":"manual","createdBy":"sam","count":4},
                  {"id":"s1","name":"Sunny","parentId":null,"kind":"smart","query":{"q":"sun","kind":["video"],"limit":60},"createdBy":"sam"},
                  {"id":"f2","name":"b-roll","parentId":null,"kind":"manual","createdBy":"sam","count":2},
                  {"id":"f1","name":"Acro","parentId":null,"kind":"manual","createdBy":"sam","count":0},
                  {"id":"f3","name":"Beach","parentId":"f2","kind":"manual","createdBy":"sam"},
                  {"id":"f4","name":"Lost","parentId":"gone","kind":"manual","createdBy":"sam"}
                ]}
                """)
            case "/api/library/lib_a/assets": return (200, [:], #"{"items":[\#(asset)],"next":"c2"}"#)
            case "/api/library/lib_a/search": return (200, [:], #"[{"asset":\#(asset),"seconds":3,"snippet":"sun"},{"asset":\#(asset)}]"#)
            default: return (404, [:], "{}")
            }
        }
    }

    func testFoldersAreReadAndShownAsOnThePage() async throws {
        let read = try await LibraryListing.library(api, session: session)
        let library = try XCTUnwrap(read)
        XCTAssertEqual(library.id, "lib_a")
        XCTAssertEqual(library.name, "Library")
        let all = try await LibraryListing.folders(api, library: library.id, session: session)
        XCTAssertFalse(all.contains { $0.id == "fin" }, "Finals is its own tool")
        // folders first, then saved searches, A to Z; one whose parent is gone shows at the top
        XCTAssertEqual(LibraryListing.foldersAt(all, open: nil, search: "").map(\.id), ["f1", "f2", "f4", "s1"])
        XCTAssertEqual(LibraryListing.foldersAt(all, open: "f2", search: "").map(\.id), ["f3"])
        // searching: every folder below the open one whose name matches
        XCTAssertEqual(LibraryListing.foldersAt(all, open: nil, search: "bea").map(\.id), ["f3"])
        XCTAssertEqual(LibraryListing.foldersAt(all, open: "f1", search: "bea").map(\.id), [])
        XCTAssertEqual(LibraryListing.trail(all, to: "f3").map(\.name), ["b-roll", "Beach"])
        XCTAssertEqual(LibraryServer.asked.map(\.path), ["/api/library", "/api/library/lib_a/collections"])
        XCTAssertEqual(LibraryServer.asked.map(\.workspace), ["ws-a", "ws-a"], "in the screen's own workspace")
    }

    func testClipsAndSearchAskTheServer() async throws {
        let all = try await LibraryListing.folders(api, library: "lib_a", session: session)
        func folder(_ id: String) -> LibraryFolder? { all.first { $0.id == id } }
        LibraryServer.asked = []

        // the top lists the clips in no folder; a folder its own, a page at a time
        let top = try await LibraryListing.page(api, library: "lib_a", open: nil, search: "", session: session)
        XCTAssertEqual(top.items.map(\.title), ["Beach day"])
        XCTAssertEqual(top.next, "c2")
        _ = try await LibraryListing.page(api, library: "lib_a", open: folder("f2"), search: " ", cursor: "c2", session: session)
        // words: the server's search, in the open folder; a saved search runs its own words and kind with the typed ones
        let found = try await LibraryListing.page(api, library: "lib_a", open: folder("f2"), search: "a+b", session: session)
        XCTAssertEqual(found.items.map(\.id), ["a1"], "one card per clip")
        XCTAssertNil(found.next)
        _ = try await LibraryListing.page(api, library: "lib_a", open: folder("s1"), search: "", session: session)

        XCTAssertEqual(LibraryServer.asked.map { "\($0.path)?\($0.query ?? "")" }, [
            "/api/library/lib_a/assets?limit=60&unfiled=1",
            "/api/library/lib_a/assets?limit=60&collectionId=f2&cursor=c2",
            "/api/library/lib_a/search?q=a%2Bb&collectionId=f2",
            "/api/library/lib_a/search?q=sun&kind=video",
        ])
        XCTAssertTrue(LibraryServer.asked.allSatisfy { $0.workspace == "ws-a" })
    }
}
