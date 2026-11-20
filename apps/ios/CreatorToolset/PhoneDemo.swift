#if DEBUG
import UIKit

/// `-PhoneDemo YES`: two computers with three workspaces and something in every tab, no server needed, for screenshots
/// of the tabs and the switcher (`-StartTab projects`, `-StartTab media`, `-SwitcherOpen YES`). Nothing is sent anywhere.
enum PhoneDemo {
    static let on = debugArg("PhoneDemo") != nil

    static let studio = Server(url: URL(string: "https://studio.example.test/")!, username: "kaia", label: "MacBook Pro")
    static let cloud = Server(url: URL(string: "https://cloud.example.test/")!, username: "kaia", label: "Creator Toolset Cloud")

    static let lists: [String: [Workspace]] = [
        studio.id: [Workspace(id: "tiny", name: "Tiny Acrobatics", color: "rose", createdAt: 1),
                    Workspace(id: "northside", name: "Northside Gym", color: "sky", createdAt: 2)],
        cloud.id: [Workspace(id: "harbor", name: "Harbor Bakery", color: "emerald", createdAt: 3)],
    ]

    static let waiting: [String: WorkspaceWaiting] = [
        "\(studio.id)|northside": WorkspaceWaiting(reviews: 2),
        "\(cloud.id)|harbor": WorkspaceWaiting(chats: 1),
    ]

    /// The two computers as `Connections` holds them (never saved), both connected, the first in use.
    static let saved: ServerRegistry.Saved = {
        let entries = [studio, cloud].map { server in
            ServerEntry(serverId: server.url.host() ?? server.id, label: server.label ?? server.name, routes: [.paired(server.url)],
                        username: server.username, version: "0.15.70", platform: "mac", home: server.url)
        }
        return ServerRegistry.Saved(servers: entries, currentKey: entries[0].key)
    }()

    static var states: [String: ConnectionState] {
        Dictionary(uniqueKeysWithValues: saved.servers.map {
            ($0.serverId, ConnectionState(phase: .connected, attempt: 1, routeId: $0.routes[0].id, since: .distantPast))
        })
    }

    /// Before `Servers` reads them: the first computer in use in Tiny Acrobatics, an admin on each.
    static func install() {
        guard on else { return }
        let defaults = UserDefaults.standard
        for server in [studio, cloud] {
            if WorkspacePick.get(server: server.id, username: server.username) == nil {
                WorkspacePick.set(lists[server.id]?.first?.id, server: server.id, username: server.username)
            }
        }
        let admin = ToolsetAccess.Me(username: "kaia", role: "admin", off: nil)
        defaults.set(try? JSONEncoder().encode([studio.id: admin, cloud.id: admin]), forKey: "toolsetAccess")
    }

    private static let now = Date().timeIntervalSince1970 * 1000
    private static func ago(_ minutes: Double) -> Double { now - minutes * 60_000 }

    /// The edits: one Review video, a go, a failure, one at work and one done (the video and the one at work are
    /// projects', the rest Other edits). The chats are in two workspaces.
    static func edits() -> (videos: [ReviewListItem], others: [ChatRow], spaces: [String: String]) {
        let json = """
        [{"id":"r1","name":"Handstand basics, cut 2","approval":{"status":"needs_review"},"updatedAt":\(ago(10)),
          "versions":[{"n":1,"status":"ready","createdAt":1,"duration":87},{"n":2,"status":"ready","createdAt":2,"duration":90}]}]
        """
        let videos = (try? JSONDecoder().decode([ReviewListItem].self, from: Data(json.utf8))) ?? []
        let date = { (m: Double) in Date(timeIntervalSince1970: ago(m) / 1000) }
        let others = [
            ChatRow(id: "/editor/e1", route: .edit("e1"), title: "Cartwheel day", detail: "Plan ready", status: .yourGo, at: date(30),
                    picture: "/demo/2"),
            ChatRow(id: "/editor/e2", route: .edit("e2"), title: "Warm-up reel", detail: "A clip didn't upload", detailIsError: true,
                    status: .failed, at: date(50)),
            ChatRow(id: "/editor/e3", route: .edit("e3"), title: "Bridge practice", detail: "Editing", status: .working(since: date(3.2)),
                    at: date(4), shelf: .working, picture: "/demo/3"),
            ChatRow(id: "/editor/e4", route: .edit("e4"), title: "Balance beam", detail: "Approved yesterday", status: .time(date(1500)),
                    at: date(1500), shelf: .done, picture: "/demo/4"),
        ]
        return (videos, others, ["c1": "tiny", "c2": "tiny", "c3": "northside"])
    }

    static let assistant = """
    {"id":"c1","provider":"claude","aiName":"Claude","workspace":"tiny","sendNow":true,"videosLater":true,
     "messages":[{"id":"m1","role":"user","text":"Turn yesterday's beam clips into a 30 second reel","at":\(ago(20))},
                 {"id":"m2","role":"assistant","text":"v2 of “Handstand basics” is ready.","at":\(ago(18)),"status":"done",
                  "media":[{"id":"review:r1:2","kind":"video","title":"Handstand basics · v2","src":"/api/review/assets/r1/v/2/play",
                            "poster":"/demo/2","href":"/review/r1?v=2","duration":90,"cut":{"asset":"r1","n":2,"next":"B-roll"}}]}],
     "past":[{"id":"c2","title":"Captions for the cartwheel post","at":\(ago(300)),"count":6},
             {"id":"c3","title":"Open day poster for the gym","at":\(ago(400)),"count":3}]}
    """

    /// The Review video the chat's cut is (`/review/r1`): two versions, notes on the first, the second waits.
    static let review: ReviewDetail? = try? JSONDecoder().decode(ReviewDetail.self, from: Data("""
    {"asset":{"id":"r1","name":"Handstand basics v1","approval":{"status":"needs_review"},"createdAt":1,
      "versions":[{"n":1,"name":"Handstand basics v1.mp4","duration":87,"width":1080,"height":1920,"status":"ready","createdAt":1,"draft":{"edit":"e5","name":"v1"}},
                  {"n":2,"name":"Handstand basics v1.mp4","duration":90,"width":1080,"height":1920,"status":"ready","createdAt":2,"draft":{"edit":"e5","name":"v1"},"next":"B-roll"}]},
     "comments":[{"id":"k1","version":1,"t":0,"text":"These shots should not be blurred at all","author":"kaia","createdAt":1,"resolved":true,"mine":true},
                 {"id":"k2","version":1,"t":31,"text":"Hold the landing a beat longer","author":"kaia","createdAt":2,"mine":true},
                 {"id":"k3","version":2,"t":42,"text":"Nice, keep this pace","author":"kaia","createdAt":3,"mine":true}],
     "manage":true}
    """.utf8))

    /// The studio edit behind it (`/editor/e5`): a failure a later run fixed, two cuts, a note on the first.
    static let project: EditorProject? = try? JSONDecoder().decode(EditorProject.self, from: Data("""
    {"id":"e5","name":"Handstand basics","jobs":[
      {"id":"j1","kind":"analyze","status":"error","progress":0.2,"createdAt":\(ago(300)),"startedAt":\(ago(300)),"finishedAt":\(ago(299)),"error":"The mic file is missing"},
      {"id":"j2","kind":"analyze","status":"done","progress":1,"createdAt":\(ago(290)),"startedAt":\(ago(290)),"finishedAt":\(ago(286))},
      {"id":"j3","kind":"script","status":"done","progress":1,"createdAt":\(ago(285)),"startedAt":\(ago(285)),"finishedAt":\(ago(281))},
      {"id":"j4","kind":"draft","status":"done","progress":1,"createdAt":\(ago(280)),"startedAt":\(ago(280)),"finishedAt":\(ago(150)),"draft":"v1"},
      {"id":"j5","kind":"revise","status":"done","progress":1,"createdAt":\(ago(60)),"startedAt":\(ago(60)),"finishedAt":\(ago(20)),"draft":"v2"}],
     "drafts":[{"name":"v1","variant":"A","n":1,"createdAt":\(ago(150)),"pass":false,"durationS":87,"failed":["vo_linked","look_away"],"preview":true,"review":{"asset":"r1","n":1}},
               {"name":"v2","variant":"A","n":2,"createdAt":\(ago(20)),"pass":false,"durationS":90,"failed":["look_away"],"preview":true,"review":{"asset":"r1","n":2}}],
     "feedback":[{"id":"f1","at":\(ago(70)),"text":"These shots should not be blurred at all","job":"j5"}]}
    """.utf8))

    static let sessions: [WorkshopSession] = {
        func s(_ id: String, _ title: String, _ status: WorkshopStatus, _ kind: String, _ minutes: Double) -> WorkshopSession {
            WorkshopSession(id: id, title: title, status: status, kinds: [kind], projectName: "Tiny Acrobatics", updatedAt: ago(minutes), posted: nil)
        }
        return [
            s("s1", "Three mistakes in a forward roll", .ready, "reel", 40),
            s("s2", "Five beam drills", .ready, "reel", 200),
            s("s3", "Spring term timetable", .writing, "carousel", 90),
            s("s4", "Parent Q&A: is it safe?", .draft, "reel", 600),
            s("s5", "Coach intro", .draft, "youtube", 1400),
            s("s6", "Handstand basics", .production, "reel", 60),
            s("s7", "Bridge practice", .editing, "reel", 5),
            s("s8", "Summer camp is open", .toPost, "reel", 120),
            s("s9", "Cartwheel progressions", .toPost, "carousel", 300),
            s("s10", "First class nerves", .published, "reel", 3000),
            s("s11", "Old logo reveal", .shelved, "free", 9000),
        ]
    }()

    static let finals: FinalsData? = {
        let pieces = (1...9).map { n in
            """
            {"id":"p\(n)","title":"\(n == 1 ? "First class nerves" : "Final \(n)")","kind":"reel","createdAt":"2026-11-\(String(format: "%02d", 18 - n))T10:00:00Z",
             "versions":[{"clipId":"demo\(n)","mediaType":"video","duration":28}]}
            """
        }.joined(separator: ",")
        return try? JSONDecoder().decode(FinalsData.self, from: Data(#"{"folders":[],"stacks":[\#(pieces)]}"#.utf8))
    }()

    static func assets(_ query: String) -> [Asset] {
        let names = ["Beam warm-up", "Forward roll", "Cartwheel line", "Bridge", "Handstand wall", "Parents waving",
                     "Trampoline", "Rope climb", "Cool-down", "Medal day", "Balance walk", "Group photo"]
        return names.enumerated()
            .filter { query.isEmpty || $0.element.lowercased().contains(query.lowercased()) }
            .map { Asset(id: "a\($0.offset)", kind: $0.offset % 4 == 3 ? "image" : "video", title: $0.element, versionId: "v\($0.offset)",
                         thumbUrl: "/demo/\($0.offset)", state: "ready") }
    }

    /// A soft colour for each picture path, so grids read as pictures.
    static func picture(_ path: String) -> UIImage {
        let hues: [CGFloat] = [0.95, 0.55, 0.08, 0.38, 0.72, 0.15, 0.6, 0.85]
        let hue = hues[path.unicodeScalars.reduce(0) { $0 + Int($1.value) } % hues.count]
        return UIGraphicsImageRenderer(size: CGSize(width: 240, height: 320)).image { context in
            let colors = [UIColor(hue: hue, saturation: 0.35, brightness: 0.95, alpha: 1).cgColor,
                          UIColor(hue: hue, saturation: 0.55, brightness: 0.7, alpha: 1).cgColor]
            let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors as CFArray, locations: [0, 1])!
            context.cgContext.drawLinearGradient(gradient, start: .zero, end: CGPoint(x: 240, y: 320), options: [])
        }
    }
}
#endif
