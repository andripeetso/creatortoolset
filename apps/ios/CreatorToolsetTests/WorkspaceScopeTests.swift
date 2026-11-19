import XCTest
@testable import CreatorToolset

/// Records every request with the workspace it named, and answers 404.
private final class ScopeServer: URLProtocol {
    nonisolated(unsafe) static var asked: [(path: String, workspace: String?)] = []

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [ScopeServer.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.asked.append((request.url!.path, request.value(forHTTPHeaderField: WorkspacePick.header)))
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data("{}".utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// What a screen, a chat or a queued video was opened in stays its own when another workspace is picked later.
@MainActor
final class WorkspaceScopeTests: XCTestCase {
    private let server = Server(url: URL(string: "https://scope.example.test/")!, username: "sam")
    private var before: String?

    override func setUp() async throws {
        before = Servers.shared.currentId
        Servers.shared.add(server, cookie: nil)
        let entry = try XCTUnwrap(Connections.shared.entry(key: server.id))
        Connections.shared.connected(entry.serverId, route: entry.routes[0])
        Servers.shared.use(server.id)
        ScopeServer.asked = []
    }

    override func tearDown() async throws {
        WorkspacePick.set(nil, server: server.id, username: "sam")
        Servers.shared.remove(server.id)
        if let before { Servers.shared.use(before) }
    }

    private func pick(_ workspace: String) { WorkspacePick.set(workspace, server: server.id, username: "sam") }

    /// A chat's video is stamped with the chat's server and workspace when its message is sent, and goes there after
    /// a switch; one an older app saved (no stamp) follows the pick.
    func testAChatVideoQueuedInAUploadsToAAfterASwitch() throws {
        pick("ws-a")
        XCTAssertEqual(API.current?.workspace, "ws-a")
        let model = AssistantModel()
        model.server = { nil }   // nothing leaves the phone
        model.send(QueuedMessage(text: "cut this", videos: [QueuedMessage.Video(name: "clip.mov", copy: "c1")]))
        pick("ws-b")

        let video = try XCTUnwrap(model.outbox.items.last?.videos?.first)
        XCTAssertEqual(video.workspace, "ws-a")
        XCTAssertEqual(video.server, server.id)
        let api = try AssistantUpload.api(for: video)
        XCTAssertEqual(api.key, server.id)
        XCTAssertEqual(api.request("/api/assistant/files", method: "POST").value(forHTTPHeaderField: WorkspacePick.header), "ws-a")
        XCTAssertEqual(try AssistantUpload.api(for: QueuedMessage.Video(name: "old.mov", copy: "c2")).workspace, "ws-b")
    }

    /// The Upload tab's library side is a plug-in's catalog in one workspace and not in another: a pick shows the new
    /// workspace's at once, not the last one's.
    func testTheLibrarySideFollowsAWorkspaceSwitch() {
        let plugins = ServerPlugins.shared
        let catalog = ServerPlugins.Known(plugins: [Studio.plugin], mainSource: .init(id: "catalog", label: "Library"))
        plugins.take(catalog, server: server.id, workspace: "ws-a")
        plugins.take(ServerPlugins.Known(plugins: [Studio.plugin]), server: server.id, workspace: "ws-b")
        let workspaces = Workspaces.shared
        workspaces.pick(WorkspaceEntry(server: server, workspace: Workspace(id: "ws-a", name: "Tiny Acrobatics")))
        plugins.load(for: server.id)
        XCTAssertTrue(plugins.known.catalog, "A's library is the catalog")

        workspaces.pick(WorkspaceEntry(server: server, workspace: Workspace(id: "ws-b", name: "Tiny Kitchen")))
        XCTAssertFalse(plugins.known.catalog, "B's is its own library")
        workspaces.pick(WorkspaceEntry(server: server, workspace: Workspace(id: "ws-a", name: "Tiny Acrobatics")))
        XCTAssertTrue(plugins.known.catalog)
    }

    /// A script link from another workspace names it (the switch button's workspace); one here, or one that names
    /// none, opens.
    func testASessionFromAnotherWorkspaceSaysWhere() throws {
        let session = try JSONDecoder().decode(WorkshopSession.self, from: Data(#"""
            {"id":"s1","title":"Handstand","status":"ready","projectId":"ws-b"}
            """#.utf8))
        XCTAssertEqual(SessionRouteView.found(session, picked: "ws-a"), .elsewhere("ws-b"))
        XCTAssertEqual(SessionRouteView.found(session, picked: "ws-b"), .open(session))
        let older = WorkshopSession(id: "s2", title: "Old", status: .ready, kinds: nil, projectName: nil, updatedAt: nil, posted: nil)
        XCTAssertEqual(SessionRouteView.found(older, picked: "ws-a"), .open(older))
    }

    /// Pictures ask in the screen's workspace, not the current pick: Finals and an edit keep the one they opened in.
    func testPicturesAskInTheScreensWorkspace() async throws {
        pick("ws-a")
        let images = ToolsetImages()
        images.session = ScopeServer.session()
        let path = "/api/library/media/\(UUID().uuidString)/thumb"   // never on disk from an earlier run
        _ = await images.image(path, maxPixels: 100, api: API.current(in: "ws-b"))
        XCTAssertEqual(ScopeServer.asked.map(\.workspace), ["ws-b"])

        let edit = EditThreadModel(id: "e-\(UUID().uuidString)")
        let finals = FinalsModel()
        await finals.load(studio: false)
        pick("ws-b")
        XCTAssertEqual(edit.api?.workspace, "ws-a", "an edit asks in the workspace it was opened in")
        XCTAssertEqual(finals.api?.workspace, "ws-a", "Finals asks in the workspace it was opened in")
        await finals.load(studio: false, force: true)
        XCTAssertEqual(finals.api?.workspace, "ws-a")
    }
}
