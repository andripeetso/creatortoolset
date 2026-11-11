import XCTest
@testable import CreatorToolset

/// Against a real server, skipped without one:
///   TEST_RUNNER_CT_TEST_SERVER=http://127.0.0.1:43127 TEST_RUNNER_CT_TEST_PASSWORD=<APP_SECRET> xcodebuild … test
/// Signs in as `admin`, uploads a 70 MB file in three chunks through the background session, uploads it again (the
/// server says it is a duplicate), and reads the screens' routes.
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
        let _: ChatView.Chat = try await api.get("/api/assistant")
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
}
