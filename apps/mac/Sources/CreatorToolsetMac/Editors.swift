// Open in <editor> for an AI Editor draft: the page's `editors` and `open-editor:{…}` asks on the thisMac handler
// (src/lib/thisMac.ts editorsOnMac / openInEditor). `editors` lists the video editors this Mac has. `open-editor` fetches
// the draft from the window's server in the file that editor reads, then opens it there and starts the editor when it
// is closed: Final Cut Pro imports the FCPXML, Premiere Pro opens the FCP 7 XML as a new project, DaVinci Resolve
// Studio takes the OTIO as a new timeline through its script runner (ResolveBridge). Free Resolve takes no scripts and
// Media Composer reads none of these files: they are started, the file is shown in Finder, and the reply says how to import it.
import AppKit
import Foundation

struct VideoEditor: Equatable {
    /// work-prefs' ids (contracts/work-prefs.ts EDITORS): resolve-studio, resolve, final-cut, premiere, avid
    let id: String
    /// the app's own name, as Finder shows it
    let name: String
    let version: String?
    let app: URL

    /// The draft's export format this editor opens (`?format=` of the export route); nil: no file it can read.
    var format: String? {
        switch id {
        case "resolve-studio", "resolve": "otio"
        case "final-cut": "fcpxml"
        case "premiere": "xml"
        default: nil
        }
    }

    var reply: [String: Any] { ["id": id, "name": name, "version": version ?? NSNull()] }
}

/// The open-editor ask's parts: the edit and version (ids that go into a URL), the editor, and what Resolve names.
struct OpenEditorAsk: Equatable {
    let edit: String
    let draft: String
    let editor: String
    /// the timeline's name and the editor project it goes in (Resolve)
    var name = "Draft"
    var project = ""
    var fps: String?
    var width: Int?
    var height: Int?
}

func isEditorAsk(_ ask: String) -> Bool { ask == "editors" || ask.hasPrefix("open-editor:") }

func openEditorAsk(_ ask: String) -> OpenEditorAsk? {
    guard ask.hasPrefix("open-editor:"),
          let json = (try? JSONSerialization.jsonObject(with: Data(ask.dropFirst("open-editor:".count).utf8))) as? [String: Any],
          let edit = json["edit"] as? String, let draft = json["draft"] as? String, let editor = json["editor"] as? String,
          [edit, draft, editor].allSatisfy({ id in !id.isEmpty && id.count <= 80 && id.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") } })
    else { return nil }
    let fps = (json["fps"] as? Double).map { $0 == $0.rounded() ? String(Int($0)) : String($0) }
    return OpenEditorAsk(edit: edit, draft: draft, editor: editor, name: (json["name"] as? String) ?? "Draft",
                         project: (json["project"] as? String) ?? "", fps: fps, width: json["width"] as? Int, height: json["height"] as? Int)
}

enum Editors {
    /// The editor an app is, by its bundle's name: nil for every other app (DaVinci's helpers, an Adobe installer…).
    static func id(appName stem: String, bundleID: String?) -> String? {
        let n = stem.lowercased()
        func named(_ base: String) -> Bool {
            n == base || n.range(of: "^\(base) (studio|trial|\\d{4}|\\(beta\\))$", options: .regularExpression) != nil
        }
        // the free Resolve's bundle id ends in Lite; its app is named as Studio's is
        if named("davinci resolve") { return bundleID?.hasSuffix("Lite") == true ? "resolve" : "resolve-studio" }
        if named("final cut pro") { return "final-cut" }
        if named("adobe premiere pro") { return "premiere" }
        if named("avid media composer") || n == "avidmediacomposer" { return "avid" }
        return nil
    }

    /// The editors in `folder` and the folders right inside it (Resolve, Premiere and Media Composer install in one of
    /// their own), one per editor: the newest when several are there (Premiere Pro 2025 before 2024).
    static func installed(in folder: URL = URL(fileURLWithPath: "/Applications")) -> [VideoEditor] {
        let fm = FileManager.default
        let top = (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
        let apps = top.flatMap { url -> [URL] in
            if url.pathExtension == "app" { return [url] }
            return ((try? fm.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? []).filter { $0.pathExtension == "app" }
        }
        var found: [String: VideoEditor] = [:]
        for app in apps.sorted(by: { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedDescending }) {
            let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist")) as? [String: Any]
            let stem = app.deletingPathExtension().lastPathComponent
            guard let id = id(appName: stem, bundleID: info?["CFBundleIdentifier"] as? String), found[id] == nil else { continue }
            found[id] = VideoEditor(id: id, name: stem, version: info?["CFBundleShortVersionString"] as? String, app: app)
        }
        let order = ["resolve-studio", "resolve", "final-cut", "premiere", "avid"]
        return found.values.sorted { order.firstIndex(of: $0.id)! < order.firstIndex(of: $1.id)! }
    }

    /// Where a draft fetched for an editor is written: the system's temporary folder (the editors import it).
    static func file(for ask: OpenEditorAsk, format: String) throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("Timelines", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let base = ask.name.replacingOccurrences(of: "[^A-Za-z0-9 ._-]+", with: "_", options: .regularExpression).trimmingCharacters(in: .whitespaces)
        return dir.appendingPathComponent("\(base.isEmpty || base.hasPrefix(".") ? ask.draft : base).\(format)")
    }

    /// Opens the draft in the editor; the reply is { ok, note? } or { problem }.
    static func open(_ ask: OpenEditorAsk, site: Site) async -> [String: Any] {
        guard let editor = installed().first(where: { $0.id == ask.editor }) else { return ["problem": "Editor not found on this Mac"] }
        guard let format = editor.format else {
            await start(editor.app)
            return ["ok": true, "note": "\(editor.name) can't import this timeline: use the OTIO, FCPXML or ZIP download"]
        }
        let file: URL
        do {
            file = try Self.file(for: ask, format: format)
            try await site.data("/api/editor/\(ask.edit)/drafts/\(ask.draft)/export?format=\(format)").write(to: file, options: .atomic)
        } catch {
            return ["problem": "Could not get the timeline"]
        }
        switch editor.id {
        case "final-cut", "premiere":
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            do { _ = try await NSWorkspace.shared.open([file], withApplicationAt: editor.app, configuration: config) } catch {
                return ["problem": "Could not open the timeline in \(editor.name)"]
            }
            return ["ok": true]
        case "resolve-studio":
            let request = ResolveRequest(otioPath: file.path, name: ask.name, project: ask.project, frameRate: ask.fps, width: ask.width, height: ask.height)
            let runner = editor.app.appendingPathComponent("Contents/Libraries/Fusion/fuscript")
            let launched = !running(editor.app)
            if launched { await start(editor.app) }
            do {
                // Resolve takes scripts only once it has loaded: up to two minutes after it was started, else one try
                let reply = try await ResolveBridge.untilOpen(waiting: launched ? 120 : 0) {
                    try await ResolveBridge.run(request, runner: runner, timeout: ResolveBridge.defaultTimeout)
                }
                switch reply {
                case .opened: return ["ok": true]
                case .failed(let why):
                    NSWorkspace.shared.activateFileViewerSelecting([file])
                    return ["problem": why]
                }
            } catch {
                NSWorkspace.shared.activateFileViewerSelecting([file])
                return ["problem": "Could not open the timeline in Resolve: in Resolve, File → Import → Timeline, and pick the file shown in Finder"]
            }
        default:   // the free Resolve: started, the file shown
            await start(editor.app)
            NSWorkspace.shared.activateFileViewerSelecting([file])
            return ["ok": true, "note": "In Resolve: File → Import → Timeline, and pick \(file.lastPathComponent) (shown in Finder)"]
        }
    }

    private static func running(_ app: URL) -> Bool {
        NSWorkspace.shared.runningApplications.contains { $0.bundleURL?.standardizedFileURL == app.standardizedFileURL }
    }

    private static func start(_ app: URL) async {
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        _ = try? await NSWorkspace.shared.openApplication(at: app, configuration: config)
    }
}
