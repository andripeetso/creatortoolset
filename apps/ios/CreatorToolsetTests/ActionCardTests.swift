import XCTest
@testable import CreatorToolset

/// Answers as the server does for a card's requests, and records each with its workspace, sign-in and body.
private final class CardServer: URLProtocol {
    struct Asked: Equatable {
        let method: String
        let path: String
        let query: String?
        let workspace: String?
        let cookie: String?
        let body: [String: String]
    }
    nonisolated(unsafe) static var asked: [Asked] = []
    nonisolated(unsafe) static var answer: (URLRequest) -> (Int, String) = { _ in (404, #"{"error":"Not found"}"#) }

    static func session() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [CardServer.self]
        return URLSession(configuration: config)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        let url = request.url!
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
            stream.close()
        }
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        Self.asked.append(Asked(method: request.httpMethod ?? "GET", path: url.path, query: url.query,
                                workspace: request.value(forHTTPHeaderField: WorkspacePick.header),
                                cookie: request.value(forHTTPHeaderField: "Cookie"),
                                body: json.mapValues { "\($0)" }))
        let (status, body) = Self.answer(request)
        client?.urlProtocol(self, didReceive: HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!,
                            cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@MainActor
final class ActionCardTests: XCTestCase {
    private let api = API(server: URL(string: "https://cards.example.test/")!, cookie: "tiny-cookie", workspace: "ws_phone")

    override func setUp() {
        CardServer.asked = []
        CardServer.answer = { _ in (404, #"{"error":"Not found"}"#) }
    }

    private func action(_ json: String) throws -> AssistantAction {
        try XCTUnwrap(JSONDecoder().decode(AssistantMessage.self, from: Data(#"{"id":"a1","role":"assistant","text":"First this.","at":1,"status":"done","action":\#(json)}"#.utf8)).action)
    }

    // MARK: decoding

    func testTheServersCardIsReadWithEveryActionType() throws {
        let card = try action(#"""
        {"kind":"projects","workspace":"ws_p","workspaceName":"Tiny Acrobatics","device":"dev_1","deviceName":"Studio Mac","path":"~/Movies/Creator Toolset/Tiny Acrobatics/Project files",
         "title":"Project files folder for Tiny Acrobatics","line":"Pick where this workspace's project files go. The edit goes on by itself.",
         "actions":[
          {"id":"use_default","label":"Use ~/Movies/Creator Toolset/Tiny Acrobatics/Project files","primary":true,
           "call":{"method":"POST","path":"/api/devices/storage/folders","body":{"role":"projects","host":"dev_1","path":"~/Movies/Creator Toolset/Tiny Acrobatics/Project files","make":true},"workspace":"ws_p"}},
          {"id":"choose","label":"Choose…","browse":{"device":"dev_1","role":"projects","workspace":"ws_p","start":"~/Movies"}},
          {"id":"customise","label":"Customise","open":"/settings/folders"},
          {"id":"teleport","label":"Beam it","teleport":{"to":"mars"}},
          {"id":5,"label":["broken"]},
          "nonsense"
         ]}
        """#)
        XCTAssertEqual(card.title, "Project files folder for Tiny Acrobatics")
        XCTAssertEqual(card.line, "Pick where this workspace's project files go. The edit goes on by itself.")
        XCTAssertNil(card.missing)
        let actions = try XCTUnwrap(card.actions)
        XCTAssertEqual(actions.map(\.id), ["use_default", "choose", "customise"])   // the unknown and broken ones are left out
        XCTAssertEqual(actions[0].primary, true)
        XCTAssertEqual(actions[0].call?.method, "POST")
        XCTAssertEqual(actions[0].call?.path, "/api/devices/storage/folders")
        XCTAssertEqual(actions[0].call?.workspace, "ws_p")
        XCTAssertEqual(actions[0].call?.body?["make"], .bool(true))
        XCTAssertEqual(actions[0].call?.body?["host"], .string("dev_1"))
        XCTAssertEqual(actions[1].browse, CardAction.Browse(device: "dev_1", role: "projects", workspace: "ws_p", start: "~/Movies"))
        XCTAssertNil(actions[1].primary)
        XCTAssertEqual(actions[2].open, "/settings/folders")
    }

    func testAMissingComputerCardHasOnlyItsRetry() throws {
        let card = try action(#"""
        {"kind":"projects","workspace":"ws_p","workspaceName":"Tiny Acrobatics","device":null,"path":"","missing":"computer",
         "title":"Project files folder for Tiny Acrobatics","line":"Can't find Studio Mac right now: open Creator Toolset on it",
         "actions":[{"id":"retry","label":"Retry","call":{"method":"GET","path":"/api/assistant/action/step_1"}}]}
        """#)
        XCTAssertEqual(card.missing, "computer")
        XCTAssertEqual(card.actions?.map(\.id), ["retry"])
        XCTAssertNil(card.actions?.first?.call?.body)
    }

    func testAnOlderServerWithoutActionsKeepsTheFallback() throws {
        let old = try action(#"{"kind":"downloads","libraryId":"lib_1","workspace":"ws_p"}"#)
        XCTAssertNil(old.actions)
        XCTAssertEqual(old.card?.title, "Turn on Automatic downloads on your computer")
        // an empty list is the server's own card, with no buttons
        let none = try action(#"{"kind":"downloads","libraryId":"lib_1","workspace":"ws_p","title":"Downloads","line":"Nothing to do.","actions":[]}"#)
        XCTAssertEqual(none.actions, [])
    }

    // MARK: call

    private let turnOn = CardAction.Call(method: "PUT", path: "/api/work/downloads", body: ["library": .string("lib_1"), "mode": .string("needed")], workspace: "ws_p")
    private let button = CardAction(id: "turn_on", label: "Turn on", primary: true, call: nil)

    func testATakenCallLeavesTheCardWorking() async {
        CardServer.answer = { _ in (200, #"{"ok":true}"#) }
        let model = ActionCardModel(api: { self.api }, session: CardServer.session())
        await model.run(turnOn, at: 0)
        XCTAssertEqual(CardServer.asked, [.init(method: "PUT", path: "/api/work/downloads", query: nil, workspace: "ws_p", cookie: "cap_auth=tiny-cookie",
                                                body: ["library": "lib_1", "mode": "needed"])])
        XCTAssertTrue(model.working)
        XCTAssertNil(model.failure)
        XCTAssertNil(model.busy)
        // working: nothing more goes
        await model.run(turnOn, at: 0)
        XCTAssertEqual(CardServer.asked.count, 1)
    }

    func testARefusedCallShowsTheServersLineAndRetrySendsItAgain() async {
        var tries = 0
        CardServer.answer = { _ in
            tries += 1
            return tries == 1 ? (409, #"{"error":"Can't find Studio Mac right now: open Creator Toolset on it"}"#) : (204, "")
        }
        let model = ActionCardModel(api: { self.api }, session: CardServer.session())
        await model.run(turnOn, at: 1)
        XCTAssertEqual(model.failure, "Can't find Studio Mac right now: open Creator Toolset on it")
        XCTAssertFalse(model.working)
        XCTAssertEqual(model.label(button, at: 1), "Retry")
        XCTAssertEqual(model.label(button, at: 0), "Turn on")

        await model.run(turnOn, at: 1)   // Retry: the same call
        XCTAssertEqual(CardServer.asked.count, 2)
        XCTAssertEqual(CardServer.asked[0], CardServer.asked[1])
        XCTAssertTrue(model.working)
        XCTAssertNil(model.failure)
        XCTAssertEqual(model.label(button, at: 1), "Turn on")
    }

    func testACallWithoutItsOwnWorkspaceGoesInTheChats() async {
        CardServer.answer = { _ in (200, "{}") }
        let model = ActionCardModel(api: { self.api }, session: CardServer.session())
        await model.run(.init(method: "GET", path: "/api/assistant/action/step_1"), at: 0)
        XCTAssertEqual(CardServer.asked.first?.workspace, "ws_phone")
        XCTAssertEqual(CardServer.asked.first?.method, "GET")
    }

    // MARK: browse

    private let choose = CardAction.Browse(device: "dev_1", role: "projects", workspace: "ws_p", start: nil)

    nonisolated private static func listing(_ path: String, parent: String?, dirs: [String]) -> String {
        let p = parent.map { "\"\($0)\"" } ?? "null"
        let d = dirs.map { #"{"name":"\#($0)","path":"\#(path == "/" ? "" : path)/\#($0)"}"# }.joined(separator: ",")
        return #"{"device":"dev_1","deviceName":"Studio Mac","path":"\#(path)","parent":\#(p),"roots":[{"name":"Home","path":"/Users/tiny"},{"name":"Footage SSD","path":"/Volumes/Footage SSD"}],"dirs":[\#(d)]}"#
    }

    func testTheBrowserGoesInAndBackAndUsesTheFolderShown() async throws {
        CardServer.answer = { request in
            let url = request.url!
            if request.httpMethod == "POST" { return (201, #"{"id":"f1"}"#) }
            let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "path" }?.value
            switch path {
            case "~", "/Users/tiny": return (200, Self.listing("/Users/tiny", parent: "/Users", dirs: ["Movies", "Music"]))
            case "/Users/tiny/Movies": return (200, Self.listing("/Users/tiny/Movies", parent: "/Users/tiny", dirs: ["Creator Toolset"]))
            default: return (400, #"{"error":"Only folders in your home folder or on your drives"}"#)
            }
        }
        let browser = FolderBrowser(browse: choose, api: api, session: CardServer.session())
        await browser.go(to: nil)
        XCTAssertEqual(CardServer.asked.last?.path, "/api/devices/dev_1/browse")
        XCTAssertEqual(CardServer.asked.last?.query, "path=~")
        XCTAssertEqual(browser.listing?.deviceName, "Studio Mac")
        XCTAssertEqual(browser.listing?.roots.map(\.name), ["Home", "Footage SSD"])
        XCTAssertEqual(browser.listing?.dirs.map(\.name), ["Movies", "Music"])

        await browser.go(to: "/Users/tiny/Movies")
        XCTAssertEqual(browser.listing?.path, "/Users/tiny/Movies")
        await browser.up()
        XCTAssertEqual(browser.listing?.path, "/Users/tiny")
        await browser.go(to: "/Users/tiny/Movies")

        // the parent of home is outside: the server's line, and the folder shown stays
        await browser.go(to: "/Users")
        XCTAssertEqual(browser.error, "Only folders in your home folder or on your drives")
        XCTAssertEqual(browser.listing?.path, "/Users/tiny/Movies")

        let used = await browser.use()
        XCTAssertTrue(used)
        XCTAssertNil(browser.error)
        XCTAssertEqual(CardServer.asked.last, .init(method: "POST", path: "/api/devices/storage/folders", query: nil, workspace: "ws_p",
                                                    cookie: "cap_auth=tiny-cookie",
                                                    body: ["role": "projects", "host": "dev_1", "path": "/Users/tiny/Movies", "make": "1"]))
    }

    func testTheBrowserStartsWhereTheActionSays() async {
        CardServer.answer = { _ in (200, Self.listing("/Volumes/Footage SSD/A & B", parent: "/Volumes/Footage SSD", dirs: [])) }
        let browser = FolderBrowser(browse: .init(device: "dev 1", role: "library", workspace: "ws_p", start: "/Volumes/Footage SSD/A & B"),
                                    api: api, session: CardServer.session())
        await browser.go(to: nil)
        XCTAssertEqual(FolderBrowser.address("dev 1", "/Volumes/Footage SSD/A & B"), "/api/devices/dev%201/browse?path=/Volumes/Footage%20SSD/A%20%26%20B")
        XCTAssertEqual(CardServer.asked.last?.query, "path=/Volumes/Footage%20SSD/A%20%26%20B")
        XCTAssertEqual(browser.listing?.dirs, [])
    }

    func testTheBrowserShowsTheServersLineWhenItCant() async {
        let lines: [(Int, String)] = [
            (409, #"{"error":"Can't find Studio Mac right now: open Creator Toolset on it","code":"computer_offline"}"#),
            (501, #"{"error":"Update Creator Toolset on Studio Mac to choose a folder from here","code":"update_needed"}"#),
            (404, #"{"error":"Not found"}"#),
        ]
        for (status, body) in lines {
            CardServer.answer = { _ in (status, body) }
            let browser = FolderBrowser(browse: choose, api: api, session: CardServer.session())
            await browser.go(to: nil)
            XCTAssertNil(browser.listing)
            XCTAssertEqual(browser.error, (try? JSONSerialization.jsonObject(with: Data(body.utf8)) as? [String: Any])?["error"] as? String)
            let used = await browser.use()
            XCTAssertFalse(used)   // nothing shown, nothing to use
        }
    }

    func testAFolderTheServerWontTakeSaysWhy() async {
        CardServer.answer = { request in
            request.httpMethod == "POST" ? (409, #"{"error":"Can't find Studio Mac right now: open Creator Toolset on it"}"#)
                                         : (200, Self.listing("/Users/tiny", parent: nil, dirs: []))
        }
        let browser = FolderBrowser(browse: choose, api: api, session: CardServer.session())
        await browser.go(to: nil)
        let used = await browser.use()
        XCTAssertFalse(used)
        XCTAssertEqual(browser.error, "Can't find Studio Mac right now: open Creator Toolset on it")
        XCTAssertEqual(browser.listing?.path, "/Users/tiny")
    }
}
