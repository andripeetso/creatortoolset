// Face Blur in the Mac app (apps/captions/editor-steps/blur-faces/README.md): the plug-in's page sends `faceblur:*` asks
// on the thisMac handler (TitleBar.swift, main frame only) and this Mac finds and covers the faces with the engine in
// FaceBlur/. Only files the page got from this app (its open panel or a drop on the window) are taken, and the covered
// copy goes beside the original. One item is worked on at a time, off the main thread; the page polls the state.
import AppKit
import CryptoKit
import Foundation

/// The asks from the page; any other `faceblur:` text is answered with a problem.
enum FaceBlurAsk: Equatable {
    enum Mode: String { case all, some }
    case hello
    /// `style`: the look and its adjustments (look, strength, softness, size, color; the ones missing keep their defaults)
    case start(files: [String], mode: Mode, style: LookPreset)
    /// the items without their face pictures (polled twice a second)
    case state(job: String)
    /// one item's faces with their pictures, read once
    case faces(job: String, path: String)
    /// `error`: the faces could not be chosen (the AI failed); the item ends as failed with it and nothing is written
    case choose(job: String, path: String, blur: [String], error: String? = nil)
    case cancel(job: String)
    case show(path: String)
    /// Choose files: this app's own open panel, on any server (answered by the window, Shell.swift faceBlurPick)
    case pick
    /// A preview or a test run, written nowhere: `picture` (a JPEG or PNG as base64, the example) or `path` (a file picked
    /// here), covered in `style`. `blur`: the faces to cover (nil = all); `facesOnly`: just the faces, no pictures of the
    /// result (the first half of an "Only some faces" run). Answered off the main thread (Shell.swift, FaceBlurTrial).
    case trial(picture: String?, path: String?, style: LookPreset, blur: [String]?, facesOnly: Bool)
}

func isFaceBlurAsk(_ ask: String) -> Bool { ask.hasPrefix("faceblur:") }

/// "faceblur:<verb>[:<rest>]" as an ask; nil when it is not one this app knows.
func faceBlurAsk(_ ask: String) -> FaceBlurAsk? {
    guard isFaceBlurAsk(ask) else { return nil }
    let body = ask.dropFirst("faceblur:".count)
    let verb = String(body.prefix { $0 != ":" })
    let rest = body.count > verb.count ? String(body.dropFirst(verb.count + 1)) : ""
    let json = (try? JSONSerialization.jsonObject(with: Data(rest.utf8))) as? [String: Any]
    switch verb {
    case "hello": return rest.isEmpty ? .hello : nil
    case "start":
        guard let json, let files = json["files"] as? [String], !files.isEmpty,
              let mode = (json["mode"] as? String).flatMap(FaceBlurAsk.Mode.init(rawValue:)),
              let look = (json["look"] as? String).flatMap(CoverLook.init(rawValue:)) else { return nil }
        return .start(files: files, mode: mode, style: LookPreset(look: look, values: json))
    case "try":
        guard let json, let look = (json["look"] as? String).flatMap(CoverLook.init(rawValue:)) else { return nil }
        let picture = json["picture"] as? String, path = json["path"] as? String
        guard (picture == nil) != (path == nil) else { return nil }
        return .trial(picture: picture, path: path, style: LookPreset(look: look, values: json), blur: json["blur"] as? [String],
                      facesOnly: json["facesOnly"] as? Bool ?? false)
    case "choose":
        guard let job = json?["job"] as? String, let path = json?["path"] as? String, let blur = json?["blur"] as? [String] else { return nil }
        let error = (json?["error"] as? String).map { String($0.prefix(300)) }.flatMap { $0.isEmpty ? nil : $0 }
        return .choose(job: job, path: path, blur: blur, error: error)
    case "faces":
        guard let job = json?["job"] as? String, let path = json?["path"] as? String else { return nil }
        return .faces(job: job, path: path)
    case "state": return rest.isEmpty ? nil : .state(job: rest)
    case "cancel": return rest.isEmpty ? nil : .cancel(job: rest)
    case "show": return rest.isEmpty ? nil : .show(path: rest)
    case "pick": return rest.isEmpty ? .pick : nil
    default: return nil
    }
}

/// Face Blur's jobs on this Mac. Main actor; the engine's work runs off it.
@MainActor
final class FaceBlurJobs {
    static let shared = FaceBlurJobs()
    nonisolated static let maxFiles = 200
    /// finished jobs kept for the page to read
    static let keep = 20

    enum Stage: String { case queued, scanning, choosing, writing, done, failed }

    struct Item {
        let path: String
        var stage = Stage.queued
        var progress = 0.0
        var scan: FaceScan?
        var blur: Set<String> = []
        var out: String?
        var error: String?
        /// a done item that wrote nothing ("No face found, nothing written")
        var note: String?
    }

    final class Job {
        let id = UUID().uuidString
        let mode: FaceBlurAsk.Mode
        let preset: LookPreset
        var items: [Item]
        var cancelled = false
        init(mode: FaceBlurAsk.Mode, preset: LookPreset, files: [String]) {
            self.mode = mode
            self.preset = preset
            items = files.map { Item(path: $0) }
        }
    }

    private enum Work { case scan, write }
    private var jobs: [Job] = []
    private var queue: [(job: Job, index: Int, work: Work)] = []
    private var running: (job: Job, task: Task<Void, Never>)?

    /// The answer to one ask. `allowed`: the paths the page got from this app (its open panel and drops).
    func answer(_ text: String, allowed: Set<String>) -> [String: Any] {
        guard let ask = faceBlurAsk(text) else { return ["problem": "This Mac app doesn't know that Face Blur ask. Update the app."] }
        switch ask {
        case .hello:
            // 2: styles (start's adjustments) and test runs (try)
            return ["ok": true, "version": 2]
        case .pick, .trial:
            // the window answers these (an open panel; work off the main thread); this is only reached with no window
            return ["problem": "This Mac app can't do that here. Update the app."]
        case let .start(files, mode, style):
            if let problem = Self.refusal(files, allowed: allowed) { return ["problem": problem] }
            let job = Job(mode: mode, preset: style, files: files)
            jobs.append(job)
            let finished = jobs.filter { j in j !== job && !busy(j) }
            if finished.count > Self.keep { jobs.removeAll { j in finished.prefix(finished.count - Self.keep).contains { $0 === j } } }
            queue += job.items.indices.map { (job, $0, .scan) }
            pump()
            return ["job": job.id]
        case let .state(id):
            guard let job = job(id) else { return ["problem": "That Face Blur job is gone. Start again."] }
            return ["done": !busy(job), "items": job.items.map { Self.reply($0) }]
        case let .faces(id, path):
            guard let item = job(id)?.items.first(where: { $0.path == path }), item.scan != nil else {
                return ["problem": "That file has no faces to show. Start again."]
            }
            return ["faces": Self.reply(item, pictures: true)["faces"] ?? []]
        // a done item is written again (to the same copy), a failed write tried again
        case let .choose(id, path, blur, error):
            guard let job = job(id), let i = job.items.firstIndex(where: { $0.path == path }), job.items[i].scan != nil,
                  [.choosing, .done, .failed].contains(job.items[i].stage), !job.cancelled else {
                return ["problem": "That file isn't waiting for its faces. Start again."]
            }
            if let error {
                fail(job, i, error)
                return ["ok": true]
            }
            job.items[i].blur = Set(blur)
            job.items[i].stage = .writing
            job.items[i].progress = 0
            queue.append((job, i, .write))
            pump()
            return ["ok": true]
        case let .cancel(id):
            guard let job = job(id) else { return ["ok": true] }
            job.cancelled = true
            queue.removeAll { $0.job === job }
            if running?.job === job { running?.task.cancel() }
            for i in job.items.indices where ![.done, .failed].contains(job.items[i].stage) { fail(job, i, "Stopped.") }
            return ["ok": true]
        case let .show(path):
            let ours = jobs.contains { $0.items.contains { $0.out == path } }
            guard ours || allowed.contains(path), FileManager.default.fileExists(atPath: path) else {
                return ["problem": "That file isn't there any more."]
            }
            NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
            return ["ok": true]
        }
    }

    /// Why these files can't be taken, in one sentence; nil when every one can.
    nonisolated static func refusal(_ files: [String], allowed: Set<String>) -> String? {
        if files.count > maxFiles { return "Pick at most \(maxFiles) files at a time." }
        for path in files {
            let name = (path as NSString).lastPathComponent
            guard allowed.contains(path) else { return "Pick \(name) in this app first: Face Blur takes only files chosen or dropped here." }
            var folder: ObjCBool = false
            guard FileManager.default.fileExists(atPath: path, isDirectory: &folder), !folder.boolValue,
                  FileManager.default.isReadableFile(atPath: path) else { return "\(name) can't be read." }
            guard CoverPipeline.kind(of: URL(fileURLWithPath: path)) != nil else { return "\(name) isn't a photo or a video." }
        }
        return nil
    }

    /// An item as the page reads it; the face pictures (up to 200 KB each) only with `pictures`, for the `faces` ask.
    static func reply(_ item: Item, pictures: Bool = false) -> [String: Any] {
        var out: [String: Any] = ["path": item.path, "name": (item.path as NSString).lastPathComponent,
                                  "stage": item.stage.rawValue, "progress": item.progress]
        if let scan = item.scan {
            out["faces"] = scan.faces.map { face -> [String: Any] in
                var f: [String: Any] = ["id": face.id, "note": face.note, "blur": item.blur.contains(face.id)]
                if pictures { f["picture"] = face.picture }
                return f
            }
        }
        if let file = item.out { out["out"] = file }
        if let error = item.error { out["error"] = error }
        if let note = item.note { out["note"] = note }
        return out
    }

    private func job(_ id: String) -> Job? { jobs.first { $0.id == id } }

    private func busy(_ job: Job) -> Bool {
        running?.job === job || queue.contains { $0.job === job } || job.items.contains { $0.stage == .choosing }
    }

    private func fail(_ job: Job, _ i: Int, _ why: String) {
        job.items[i].stage = .failed
        job.items[i].error = why
    }

    /// Starts the next piece of work when none runs.
    private func pump() {
        guard running == nil, !queue.isEmpty else { return }
        let (job, i, work) = queue.removeFirst()
        let task = Task { [weak self] in
            await self?.run(job, i, work)
            self?.running = nil
            self?.pump()
        }
        running = (job, task)
    }

    private func run(_ job: Job, _ i: Int, _ work: Work) async {
        let source = URL(fileURLWithPath: job.items[i].path)
        let progress: @Sendable (Double) -> Void = { p in
            Task { @MainActor in
                guard !job.cancelled, [.scanning, .writing].contains(job.items[i].stage) else { return }
                job.items[i].progress = p
            }
        }
        do {
            switch work {
            case .scan:
                job.items[i].stage = .scanning
                let scan = try await CoverPipeline.scan(source, preset: job.preset, progress: progress)
                job.items[i].scan = scan
                job.items[i].progress = 1
                // "some" waits for the page's choice; a file with no face has nothing to choose
                if job.mode == .some && !scan.faces.isEmpty {
                    job.items[i].stage = .choosing
                } else {
                    job.items[i].blur = Set(scan.faces.map(\.id))
                    job.items[i].stage = .writing
                    job.items[i].progress = 0
                    queue.insert((job, i, .write), at: 0)
                }
            case .write:
                guard let scan = job.items[i].scan else { return }
                job.items[i].stage = .writing
                job.items[i].note = nil
                let out = job.items[i].out.map(URL.init(fileURLWithPath:)) ?? CoverPipeline.outputURL(for: source, kind: scan.kind)
                try await CoverPipeline.write(scan, from: source, blur: job.items[i].blur, style: job.preset, to: out, progress: progress)
                job.items[i].out = out.path
                job.items[i].progress = 1
                job.items[i].stage = .done
                job.items[i].error = nil
            }
        } catch let nothing as CoverPipeline.NothingToCover {
            // done, with no copy (or the earlier one, as it was)
            job.items[i].stage = .done
            job.items[i].progress = 1
            job.items[i].error = nil
            job.items[i].note = job.items[i].out == nil ? nothing.why : "\(nothing.why), the earlier copy is as it was"
        } catch {
            fail(job, i, job.cancelled || error is CancellationError ? "Stopped." : error.localizedDescription)
        }
    }
}

/// Face Blur's previews and test runs (`faceblur:try`): the faces found and the covered result as pictures, nothing written
/// beside the original. The last file's scan is kept, so moving a slider only draws again.
actor FaceBlurTrial {
    static let shared = FaceBlurTrial()
    /// a picture sent by the page (base64) is at most this
    static let maxPicture = 20_000_000
    private var last: (key: String, source: URL, scan: FaceScan)?
    private let folder = FileManager.default.temporaryDirectory.appendingPathComponent("face-blur-trial", isDirectory: true)

    func answer(_ ask: FaceBlurAsk, allowed: Set<String>) async -> [String: Any] {
        guard case let .trial(picture, path, style, blur, facesOnly) = ask else { return ["problem": "Not a test run."] }
        do {
            let (key, source) = try place(picture: picture, path: path, allowed: allowed)
            let scan: FaceScan
            if let last, last.key == key {
                scan = last.scan
            } else {
                scan = try await CoverPipeline.scan(source, preset: style) { _ in }
                if let old = last?.source, old.path.hasPrefix(folder.path), old != source { try? FileManager.default.removeItem(at: old) }
                last = (key, source, scan)
            }
            let faces = scan.faces.map { ["id": $0.id, "picture": $0.picture, "note": $0.note] }
            if facesOnly { return ["kind": scan.kind.rawValue, "faces": faces, "frames": [String]()] }
            let chosen = blur.map(Set.init) ?? Set(scan.faces.map(\.id))
            let frames = try await CoverPipeline.frames(scan, from: source, blur: chosen, style: style)
            return ["kind": scan.kind.rawValue, "faces": faces, "frames": frames]
        } catch let refused as FaceBlurAutoRefused {
            return ["problem": refused.why]
        } catch {
            return ["problem": (error as? MediaError)?.localizedDescription ?? "This Mac could not try it: \(error.localizedDescription)"]
        }
    }

    /// The file a test run reads, and a key that is the same for the same file: a picture the page sent goes in this app's
    /// temporary folder (by its digest); a path must be one the page got from this app.
    private func place(picture: String?, path: String?, allowed: Set<String>) throws -> (String, URL) {
        if let path {
            if let problem = FaceBlurJobs.refusal([path], allowed: allowed) { throw FaceBlurAutoRefused(why: problem) }
            let modified = (try? FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
            return ("\(path)\n\(modified)", URL(fileURLWithPath: path))
        }
        guard let picture, picture.count <= Self.maxPicture / 3 * 4, let data = Data(base64Encoded: picture) else {
            throw FaceBlurAutoRefused(why: "That picture can't be read.")
        }
        let key = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("trial-\(key.prefix(16)).jpg")
        if !FileManager.default.fileExists(atPath: url.path) { try data.write(to: url) }
        return (key, url)
    }
}
