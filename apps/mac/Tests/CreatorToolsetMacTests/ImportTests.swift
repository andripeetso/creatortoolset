import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CreatorToolsetMac

final class ImportTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        let base = ProcessInfo.processInfo.environment["CT_SCRATCH_DIR"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.temporaryDirectory
        // real path: /var is /private/var, and the checks compare real paths
        let made = base.appendingPathComponent("import-tests/\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
        root = made.resolvingSymlinksInPath()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    @discardableResult
    private func write(_ relative: String, _ data: Data = Data("x".utf8)) throws -> String {
        let file = root.appendingPathComponent(relative)
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: file)
        return file.path
    }

    private func at(_ relative: String) -> String { root.appendingPathComponent(relative).path }

    func testAsksParsed() {
        XCTAssertEqual(importAsk(#"import:copy:{"id":"c1","files":[{"from":"/a/b.mov","to":"/c/b.mov"}]}"#),
                       .copy(id: "c1", files: [ImportPair(from: "/a/b.mov", to: "/c/b.mov")]))
        // the page names the default folder from the home folder, which only this app knows
        XCTAssertEqual(importAsk(#"import:copy:{"id":"c2","files":[{"from":"/a/b.mov","to":"~/Movies/Creator Toolset/Lib/b.mov"}]}"#),
                       .copy(id: "c2", files: [ImportPair(from: "/a/b.mov", to: NSHomeDirectory() + "/Movies/Creator Toolset/Lib/b.mov")]))
        XCTAssertEqual(importAsk("import:progress:c1"), .progress("c1"))
        XCTAssertEqual(importAsk("import:cancel:c1"), .cancel("c1"))
        XCTAssertEqual(importAsk(#"import:scan:{"path":"/Volumes/Footage"}"#), .scan("/Volumes/Footage"))
        XCTAssertEqual(importAsk(#"import:print:{"paths":["/a.mov"]}"#), .print(["/a.mov"]))
        XCTAssertEqual(importAsk(#"import:hash:{"paths":["/a.mov"]}"#), .hash(["/a.mov"]))
        XCTAssertNil(importAsk("import:progress:a b"))
        XCTAssertNil(importAsk(#"import:copy:{"id":"c1","files":[{"from":"/a.mov"}]}"#))   // a pair without `to`
        XCTAssertNil(importAsk("import:delete:{}"))
        XCTAssertTrue(isImportAsk("import:scan:{}"))
        XCTAssertFalse(isImportAsk("reveal:{}"))
    }

    /// Sources: under a dropped folder or a picked file, never next to it, never through `..` or a link out of it.
    func testCopyReadsOnlyFromDropsAndPicks() throws {
        let clip = try write("Drop/Day 1/A001.mov")
        let picked = try write("Picked.mov")
        try write("Dropbar/B.mov")
        try write("Elsewhere/C.mov")
        try FileManager.default.createSymbolicLink(atPath: at("Drop/out"), withDestinationPath: at("Elsewhere"))
        let sources = [at("Drop"), picked]
        XCTAssertEqual(Imports.inside(clip, sources), at("Drop"))
        XCTAssertEqual(Imports.inside(picked, sources), picked)
        XCTAssertNil(Imports.inside(at("Dropbar/B.mov"), sources))
        XCTAssertNil(Imports.inside(at("Drop/../Elsewhere/C.mov"), sources))
        XCTAssertNil(Imports.inside(at("Drop/out/C.mov"), sources))
        XCTAssertNil(Imports.inside("relative/A001.mov", sources))
        XCTAssertNil(Imports.inside("/etc/hosts", ["/"]))   // the whole disk is never a root
    }

    /// Destinations: under the library's folder or a chosen one (made as needed), never the folder itself.
    func testCopyWritesOnlyUnderItsFolders() throws {
        let library = at("Movies/Creator Toolset")   // not made yet
        XCTAssertEqual(Imports.destination(at("Movies/Creator Toolset/Tiny/Footage/Day 1/A001.mov"), [library]), library)
        XCTAssertNil(Imports.destination(library, [library]))
        XCTAssertNil(Imports.destination(at("Movies/Other/A001.mov"), [library]))
        XCTAssertNil(Imports.destination(at("Movies/Creator Toolset/../A001.mov"), [library]))
        try FileManager.default.createDirectory(atPath: library, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(atPath: at("Movies/Creator Toolset/out"), withDestinationPath: at("Movies"))
        XCTAssertNil(Imports.destination(at("Movies/Creator Toolset/out/A001.mov"), [library]))
    }

    func testNeverOverwrites() {
        let sizes = ["/L/A001.mov": Int64(10), "/L/A001 2.mov": 20, "/L/B": 5]
        let free = { (to: String, size: Int64) in Imports.freeName(to, size: size) { sizes[$0] } }
        XCTAssertEqual(free("/L/New.mov", 10).path, "/L/New.mov")
        XCTAssertTrue(free("/L/A001.mov", 10).copied)   // the same name and size: copied before
        XCTAssertEqual(free("/L/A001.mov", 20).path, "/L/A001 2.mov")   // copied before under its numbered name
        XCTAssertTrue(free("/L/A001.mov", 20).copied)
        XCTAssertEqual(free("/L/A001.mov", 30).path, "/L/A001 3.mov")
        XCTAssertFalse(free("/L/A001.mov", 30).copied)
        XCTAssertEqual(free("/L/B", 6).path, "/L/B 2")
    }

    func testCopiesMakesFoldersAndKeepsWhatIsThere() throws {
        let a = try write("Drop/A001.mov", Data(repeating: 1, count: 3000))
        let b = try write("Drop/B.mov", Data(repeating: 2, count: 10))
        let lib = at("Lib")
        try write("Lib/Footage/B.mov", Data("other".utf8))   // a different file of that name
        let pairs = [ImportPair(from: a, to: at("Lib/Footage/Drop/A001.mov")), ImportPair(from: b, to: at("Lib/Footage/B.mov")),
                     ImportPair(from: at("Elsewhere.mov"), to: at("Lib/E.mov"))]
        var granted: [String] = []
        let reply = Imports().copy(id: "t1", pairs, sources: [at("Drop")], destinations: [lib]) { granted.append($0) }
        let copied = reply["copied"] as? [[String: String]] ?? []
        XCTAssertEqual(copied.map { $0["to"] }, [at("Lib/Footage/Drop/A001.mov"), at("Lib/Footage/B 2.mov")])
        XCTAssertEqual(try Data(contentsOf: URL(fileURLWithPath: at("Lib/Footage/Drop/A001.mov"))), Data(repeating: 1, count: 3000))
        XCTAssertEqual(try String(contentsOfFile: at("Lib/Footage/B.mov"), encoding: .utf8), "other")
        XCTAssertEqual((reply["failed"] as? [[String: String]])?.count, 1)
        XCTAssertNil(reply["stopped"])
        // again: nothing new, both taken as copied
        XCTAssertEqual(Set(granted), [lib])
        let again = Imports().copy(id: "t2", Array(pairs.prefix(2)), sources: [at("Drop")], destinations: [lib]) { _ in }
        XCTAssertEqual((again["copied"] as? [[String: String]])?.map { $0["to"] }, copied.map { $0["to"] })
        XCTAssertFalse(FileManager.default.fileExists(atPath: at("Lib/Footage/B 3.mov")))
    }

    /// The import rule: a listed Media folder's Imports/ takes copies; with that Media folder gone (its drive away) nothing
    /// is written, not even the folder.
    func testCopiesIntoAMediaFoldersImportsOnlyWhileItIsThere() throws {
        let suite = "import-tests-\(UUID().uuidString)"
        let was = MediaFiles.defaults
        MediaFiles.defaults = UserDefaults(suiteName: suite)!
        defer { MediaFiles.defaults.removePersistentDomain(forName: suite); MediaFiles.defaults = was }
        let media = at("Tiny Footage")
        try FileManager.default.createDirectory(atPath: media, withIntermediateDirectories: true)
        MediaFiles.setServerFolders([.init(id: "f1", path: media, workspaces: ["*"], use: "media"), .init(id: "f2", path: at("Gone"), workspaces: ["*"], use: "media")], server: "s")
        XCTAssertTrue(MediaFiles.importsFolders(server: "s").isEmpty)   // not allowed on this Mac yet
        MediaFiles.allow(media, server: "s")
        MediaFiles.allow(at("Gone"), server: "s")
        XCTAssertEqual(Set(MediaFiles.importsFolders(server: "s")), [media + "/Imports", at("Gone") + "/Imports"])
        XCTAssertEqual(MediaFiles.importsFolders(server: "other"), [])   // another server's page never copies into them
        XCTAssertNil(Imports.destination(media + "/Imports/x/A001.mov", Imports.copyDestinations(server: "other")))
        let a = try write("Downloads/A001.mov", Data(repeating: 1, count: 10))
        let into = media + "/Imports/Summer reel/A001.mov"
        let reply = Imports().copy(id: "m1", [ImportPair(from: a, to: into), ImportPair(from: a, to: at("Gone/Imports/Summer reel/A001.mov"))],
                                   sources: [at("Downloads")], destinations: MediaFiles.importsFolders(server: "s")) { _ in }
        XCTAssertEqual((reply["copied"] as? [[String: String]])?.map { $0["to"] }, [into])
        XCTAssertEqual((reply["failed"] as? [[String: String]])?.map { $0["error"] }, ["Gone isn't connected."])
        XCTAssertFalse(FileManager.default.fileExists(atPath: at("Gone")))
        XCTAssertNil(Imports.destination(media + "/A001.mov", MediaFiles.importsFolders(server: "s")))   // the Media folder itself: never
        // a picked folder around a Media folder whose drive is away: still refused by the Media folder, never its parent
        let picked = Imports().copy(id: "m2", [ImportPair(from: a, to: at("Gone/Imports/Summer reel/A001.mov"))],
                                    sources: [at("Downloads")], destinations: MediaFiles.importsFolders(server: "s") + [root.path]) { _ in }
        XCTAssertEqual((picked["failed"] as? [[String: String]])?.map { $0["error"] }, ["Gone isn't connected."])
        XCTAssertFalse(FileManager.default.fileExists(atPath: at("Gone")))
    }

    /// Another workspace's or another signed-in server's footage is never copied into a library: a file inside any of
    /// their Media folders, by its real path (a link to it too), is refused. A server this Mac has no sign-in for any more
    /// never blocks a drop. And a Media folder not allowed here yet says so.
    func testNeverCopiesFromAMediaFolderAndSaysWhenOneIsNotAllowed() throws {
        let suite = "import-tests-\(UUID().uuidString)"
        let was = MediaFiles.defaults
        MediaFiles.defaults = UserDefaults(suiteName: suite)!
        defer { MediaFiles.defaults.removePersistentDomain(forName: suite); MediaFiles.defaults = was }
        let mine = at("Tiny Footage"), other = at("Movies/Creator Toolset/Other/Media"), waiting = at("Waiting"), studio = at("Studio/FOOTAGE")
        for d in [mine, waiting] { try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true) }
        let clip = try write("Movies/Creator Toolset/Other/Media/clip.mov")
        let studioClip = try write("Studio/FOOTAGE/Shoot/clip.mov")
        try FileManager.default.createSymbolicLink(atPath: at("Movies/alias"), withDestinationPath: other)
        // the page's server "s" (two workspaces), another signed-in server "studio.tiny.test:8443", one with no sign-in left
        MediaFiles.setServerFolders([.init(id: "f1", path: mine, workspaces: ["a"], use: "media"), .init(id: "f2", path: other, workspaces: ["b"], use: "media"),
                                     .init(id: "f3", path: waiting, workspaces: ["a"], use: "media")], server: "s")
        MediaFiles.setServerFolders([.init(id: "f4", path: studio, workspaces: ["*"], use: "media")], server: "studio.tiny.test:8443")
        MediaFiles.setServerFolders([.init(id: "f9", path: at("Downloads"), workspaces: ["*"], use: "media")], server: "gone")
        MediaFiles.allow(mine, server: "s")
        let media = MediaFiles.signedInMediaFolders(signedIn: { $0 != "gone" })
        XCTAssertEqual(Set(media), [mine, other, waiting, studio])
        let a = try write("Downloads/A001.mov"), b = try write("Downloads/B.mov")
        let pairs = [ImportPair(from: clip, to: mine + "/Imports/x/clip.mov"), ImportPair(from: at("Movies/alias/clip.mov"), to: mine + "/Imports/x/clip 2.mov"),
                     ImportPair(from: studioClip, to: mine + "/Imports/x/studio.mov"), ImportPair(from: a, to: waiting + "/Imports/x/A001.mov"),
                     ImportPair(from: b, to: mine + "/Imports/x/B.mov")]
        let reply = Imports().copy(id: "g1", pairs, sources: [at("Movies"), at("Downloads"), at("Studio")], destinations: Imports.copyDestinations(server: "s"),
                                   waiting: MediaFiles.importsFolders(server: "s", allowed: false), media: media) { _ in }
        XCTAssertEqual((reply["failed"] as? [[String: String]])?.map { $0["error"] ?? "" }, [
            "\(clip) is in the Media folder \(other): drop the folder with the footage itself",
            "\(at("Movies/alias/clip.mov")) is in the Media folder \(other): drop the folder with the footage itself",
            "\(studioClip) is in the Media folder \(studio): drop the folder with the footage itself",   // another server's
            "Allow Waiting on this Mac in Settings → Folders first.",
        ])
        // an IPv6 server keys as "fd00::5:8443" and its token by host "fd00::5": its folders still count
        MediaFiles.setServerFolders([.init(id: "f6", path: at("Six"), workspaces: ["*"], use: "media")], server: "fd00::5:8443")
        XCTAssertTrue(MediaFiles.signedInMediaFolders(signedIn: { $0 == "fd00::5" }).contains(at("Six")))
        // a path this window wasn't given: the same answer whether or not it is in a library (nothing to probe)
        let probe = Imports().copy(id: "g2", [ImportPair(from: studioClip, to: mine + "/Imports/x/s.mov"), ImportPair(from: at("Nowhere/x.mov"), to: mine + "/Imports/x/n.mov")],
                                   sources: [], destinations: Imports.copyDestinations(server: "s"), media: media) { _ in }
        XCTAssertEqual((probe["failed"] as? [[String: String]])?.map { $0["error"] ?? "" }, Array(repeating: "Not a file from a drop or a pick in this window.", count: 2))
        // Downloads is a Media folder only of a server this Mac left: it blocks nothing
        XCTAssertEqual((reply["copied"] as? [[String: String]])?.map { $0["to"] }, [mine + "/Imports/x/B.mov"])
    }

    /// A Blur faces workspace's footage never reaches another server's page by a drag or a pick: refused with one line.
    /// Its own server's page is its own gate's; a normal workspace's folder, and a server with no sign-in, block nothing.
    func testBlurredFootageNeverGoesToAnotherServer() throws {
        let suite = "import-tests-\(UUID().uuidString)"
        let was = MediaFiles.defaults
        MediaFiles.defaults = UserDefaults(suiteName: suite)!
        defer { MediaFiles.defaults.removePersistentDomain(forName: suite); MediaFiles.defaults = was }
        let footage = at("Tiny/FOOTAGE"), vlogs = at("Tiny/Vlogs"), old = at("Old/Media"), gone = at("Gone/Media")
        let clip = try write("Tiny/FOOTAGE/Shoot/clip.mov"), vlog = try write("Tiny/Vlogs/v.mov"), oldClip = try write("Old/Media/o.mov"), goneClip = try write("Gone/Media/g.mov")
        try FileManager.default.createSymbolicLink(atPath: at("alias"), withDestinationPath: footage)
        MediaFiles.setServerFolders([.init(id: "f1", path: footage, workspaces: ["ws_classes"], use: "media", guarded: ["Tiny Classes"]),
                                     .init(id: "f2", path: vlogs, workspaces: ["ws_vlogs"], use: "media", guarded: []),
                                     .init(id: "f3", path: at("Tiny/EXPORTS"), workspaces: ["ws_classes"], use: "exports")], server: "studio.tiny.test")
        MediaFiles.setServerFolders([.init(id: "f4", path: old, workspaces: ["*"], use: "media")], server: "old.tiny.test")   // says nothing
        MediaFiles.setServerFolders([.init(id: "f5", path: gone, workspaces: ["*"], use: "media", guarded: ["Gone"])], server: "gone.tiny.test")
        let signedIn = { (host: String) in host != "gone.tiny.test" }
        let check = { (paths: [String], page: String) in MediaFiles.blurredElsewhere(paths, server: page, signedIn: signedIn) }
        // onto another server's page: refused, by a link too, and a dropped folder holding it
        XCTAssertEqual(check([clip], "ct.tiny.test"), "\(clip) is in Tiny Classes's Media folder on studio.tiny.test: blurred footage only leaves through Tiny Classes")
        XCTAssertEqual(check([at("alias/Shoot/clip.mov")], "ct.tiny.test"), "\(at("alias/Shoot/clip.mov")) is in Tiny Classes's Media folder on studio.tiny.test: blurred footage only leaves through Tiny Classes")
        XCTAssertEqual(check([at("Tiny")], "ct.tiny.test"), "\(at("Tiny")) holds Tiny Classes's Media folder on studio.tiny.test: blurred footage only leaves through Tiny Classes")
        // onto its own server's page (the P2 gate's), a normal workspace's footage, an Exports folder: nothing refused
        XCTAssertNil(check([clip], "studio.tiny.test"))
        XCTAssertNil(check([clip], "STUDIO.tiny.test"))
        XCTAssertNil(check([vlog, at("Tiny/EXPORTS/final.mp4")], "ct.tiny.test"))
        // a server that doesn't say which workspaces blur: fails closed; one this Mac left: nothing
        XCTAssertEqual(check([oldClip], "ct.tiny.test"), "\(oldClip) is in a Media folder on old.tiny.test that hasn't said whether it must be blurred: add it from that server's own page")
        XCTAssertNil(check([goneClip], "ct.tiny.test"))
        // the whole disk dropped holds it too
        XCTAssertTrue(check(["/"], "ct.tiny.test")?.hasPrefix("/ holds ") == true)   // whichever guarded folder it finds first
        // a NAS that doesn't answer is compared by name, never waited on
        XCTAssertNotNil(MediaFiles.blurredElsewhere([clip], server: "ct.tiny.test", signedIn: signedIn, reachable: { _ in false }))
    }

    func testScanFindsMediaOnlyInGrantedFolders() throws {
        try write("Footage/A001.MOV")
        try write("Footage/Day 2/song.mp3")
        try write("Footage/Day 2/still.heic")
        try write("Footage/notes.txt")
        try write("Footage/.hidden.mov")
        try write("Footage/.cache/C.mov")
        try write("Footage/Tool.app/Contents/D.mov")
        try write("Other/E.mov")
        try FileManager.default.createSymbolicLink(atPath: at("Footage/link.mov"), withDestinationPath: at("Other/E.mov"))
        try FileManager.default.createSymbolicLink(atPath: at("Footage/OtherLink"), withDestinationPath: at("Other"))
        let reply = Imports.scan(at("Footage"), granted: [at("Footage")])
        let found = Set((reply["files"] as? [[String: Any]] ?? []).compactMap { $0["path"] as? String })
        XCTAssertEqual(found, [at("Footage/A001.MOV"), at("Footage/Day 2/song.mp3"), at("Footage/Day 2/still.heic")])
        XCTAssertNotNil(Imports.scan(at("Other"), granted: [at("Footage")])["error"])
        XCTAssertEqual((Imports.scan(at("Footage"), granted: [at("Footage")], max: 1)["files"] as? [Any])?.count, 1)
    }

    /// The same bytes and hashes as node's crypto (sha256 of String(size), the first MiB, the last MiB over 2 MiB).
    func testQuickPrintMatchesThePage() throws {
        let vectors: [(Int, String)] = [
            (10, "1c1f758fd6518ebea3430d680ad66cd1ec082267822301d3ec2b79f768ad32ad"),
            (1_500_000, "7db8075b05d28821a7b9684f93988550e0e6c5d54669241da2a8bc12d5a234a5"),
            (3 * (1 << 20) + 5, "0b278b3a924fefb72630a3220cfa132a13070a87f6f177aee8e38b81443ea522"),
        ]
        for (size, hex) in vectors {
            let bytes = Data((0..<size).map { UInt8(($0 * 7 + 3) % 251) })
            XCTAssertEqual(Imports.quickPrint(try write("p\(size).mov", bytes)), hex, "size \(size)")
        }
        XCTAssertNil(Imports.quickPrint(at("missing.mov")))
    }

    func testPicturesServed() throws {
        try write("Drop/still.jpg")
        if case .file(_, let type) = MediaFiles.gate(at("Drop/still.jpg"), granted: [at("Drop")]) { XCTAssertEqual(type, "image/jpeg") } else { XCTFail("not served") }
        XCTAssertTrue(MediaFiles.isMedia("/a/B.TIFF"))
        XCTAssertFalse(MediaFiles.isMedia("/a/b.txt"))
    }

    // setup's Library folder (11-19): the folder names in a picked folder, and its missing folders made on Done

    func testMakeAskParsed() {
        XCTAssertEqual(importAsk(#"import:make:{"in":"/Volumes/Tiny/Lib","names":["Source media"]}"#), .make(in: "/Volumes/Tiny/Lib", names: ["Source media"]))
        XCTAssertEqual(importAsk(#"import:make:{"in":"~/Movies/Creator Toolset/Tiny","names":[]}"#), .make(in: NSHomeDirectory() + "/Movies/Creator Toolset/Tiny", names: []))
        XCTAssertNil(importAsk(#"import:make:{"in":"/a","names":["1","2","3","4","5","6","7","8","9","10","11"]}"#))
    }

    func testSubfoldersAreFolderNamesOnlyNoHiddenSortedAndCapped() throws {
        for name in ["FOOTAGE", "EXPORTS", ".cache", "b", "a", "c"] {
            try FileManager.default.createDirectory(atPath: at("lib/\(name)"), withIntermediateDirectories: true)
        }
        try write("lib/notes.txt")
        XCTAssertEqual(Imports.subfolders(at("lib")), ["a", "b", "c", "EXPORTS", "FOOTAGE"])
        XCTAssertEqual(Imports.subfolders(at("lib"), limit: 2), ["a", "b"])
        XCTAssertEqual(Imports.subfolders(at("not-there")), [])
    }

    func testMakeCreatesOnlyTheMissingFoldersAndSaysWhatIsThere() throws {
        try FileManager.default.createDirectory(atPath: at("lib/FOOTAGE"), withIntermediateDirectories: true)
        var granted: [String] = []
        let r = Imports.make(in: at("lib"), names: ["FOOTAGE", "Project files", "Final exports"], allowed: [at("lib")], grant: { granted.append($0) })
        XCTAssertEqual(r["made"] as? [String], [at("lib/Project files"), at("lib/Final exports")])
        XCTAssertEqual((r["failed"] as? [[String: String]])?.count, 0)
        XCTAssertEqual(r["children"] as? [String], ["Final exports", "FOOTAGE", "Project files"])
        XCTAssertEqual(granted, [at("lib/Project files"), at("lib/Final exports")])
        // made again: nothing new
        XCTAssertEqual(Imports.make(in: at("lib"), names: ["Project files"], allowed: [at("lib")], grant: { _ in })["made"] as? [String], [])
    }

    func testMakeIntoTheFolderBesideAPickAndIntoANewDefaultPlace() throws {
        try FileManager.default.createDirectory(atPath: at("moo/FOOTAGE"), withIntermediateDirectories: true)
        // existing folders: FOOTAGE was picked, PROJECTS goes in the folder it is in
        let beside = Imports.make(in: at("moo"), names: ["Project files"], allowed: [at("moo/FOOTAGE")], grant: { _ in })
        XCTAssertEqual(beside["made"] as? [String], [at("moo/Project files")])
        // the library's default place, not there yet, inside an allowed root
        let fresh = Imports.make(in: at("root/Tiny"), names: ["Source media"], allowed: [at("root")], grant: { _ in })
        XCTAssertEqual(fresh["made"] as? [String], [at("root/Tiny/Source media")])
    }

    func testMakeRefusesAFolderNotAllowedAndNamesThatArePaths() throws {
        try FileManager.default.createDirectory(atPath: at("lib"), withIntermediateDirectories: true)
        XCTAssertNotNil(Imports.make(in: at("lib"), names: ["x"], allowed: [at("elsewhere")], grant: { _ in })["error"])
        let r = Imports.make(in: at("lib"), names: ["../out", ".hidden", ""], allowed: [at("lib")], grant: { _ in })
        XCTAssertEqual((r["failed"] as? [[String: String]])?.count, 3)
        XCTAssertFalse(FileManager.default.fileExists(atPath: at("out")))
    }

    /// A 40×20 picture written as `type` (a PNG or a HEIC), turned by EXIF `orientation`.
    private func picture(_ path: String, type: UTType, orientation: Int = 1) throws {
        let ctx = CGContext(data: nil, width: 40, height: 20, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(red: 0.2, green: 0.6, blue: 0.4, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: 40, height: 20))
        try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        let dest = try XCTUnwrap(CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, type.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(dest, ctx.makeImage()!, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
    }

    func testThumbAskParsed() {
        XCTAssertEqual(importAsk(#"import:thumb:{"path":"/Volumes/Tiny/a.heic","max":480}"#), .thumb(path: "/Volumes/Tiny/a.heic", max: 480))
        XCTAssertEqual(importAsk(#"import:thumb:{"path":"/a.jpg"}"#), .thumb(path: "/a.jpg", max: 480))
        XCTAssertEqual(importAsk(#"import:thumb:{"path":"/a.jpg","max":99999}"#), .thumb(path: "/a.jpg", max: 2048))
        XCTAssertNil(importAsk(#"import:thumb:{"max":480}"#))
    }

    func testThumbMakesAJpegOfAPictureMacOSReadsTurnedAndOnlyInsideAllowedFolders() throws {
        try picture(at("lib/side.heic"), type: .heic, orientation: 6) // a phone's picture taken on its side
        let r = Imports.thumb(at("lib/side.heic"), max: 480, allowed: [at("lib")])
        let jpeg = try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(r["thumb"] as? String)))
        XCTAssertEqual(Array(jpeg.prefix(2)), [0xFF, 0xD8])
        XCTAssertEqual(r["width"] as? Int, 20) // turned: the 40×20 picture stands 20×40
        XCTAssertEqual(r["height"] as? Int, 40)
        try picture(at("other/a.png"), type: .png)
        XCTAssertNotNil(Imports.thumb(at("other/a.png"), max: 480, allowed: [at("lib")])["error"])
        FileManager.default.createFile(atPath: at("lib/not-a-picture.heic"), contents: Data("x".utf8))
        XCTAssertNotNil(Imports.thumb(at("lib/not-a-picture.heic"), max: 480, allowed: [at("lib")])["error"])
    }
}
