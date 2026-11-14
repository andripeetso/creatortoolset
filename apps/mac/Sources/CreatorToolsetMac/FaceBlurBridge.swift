// Face Blur in the Mac app (apps/captions/editor-steps/blur-faces/README.md): the plug-in's page sends `faceblur:*` asks
// on the thisMac handler (TitleBar.swift, main frame only) and this Mac finds and covers the faces with the engine in
// FaceBlur/. Only files the page got from this app (its open panel or a drop on the window) are taken, and the covered
// copy goes beside the original. One item is worked on at a time, off the main thread; the page polls the state.
import AppKit
import Foundation

/// The asks from the page; any other `faceblur:` text is answered with a problem.
enum FaceBlurAsk: Equatable {
    enum Mode: String { case all, some }
    case hello
    case start(files: [String], mode: Mode, look: CoverLook)
    case state(job: String)
    /// `error`: the faces could not be chosen (the AI failed); the item ends as failed with it and nothing is written
    case choose(job: String, path: String, blur: [String], error: String? = nil)
    case cancel(job: String)
    case show(path: String)
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
        guard let files = json?["files"] as? [String], !files.isEmpty,
              let mode = (json?["mode"] as? String).flatMap(FaceBlurAsk.Mode.init(rawValue:)),
              let look = (json?["look"] as? String).flatMap(CoverLook.init(rawValue:)) else { return nil }
        return .start(files: files, mode: mode, look: look)
    case "choose":
        guard let job = json?["job"] as? String, let path = json?["path"] as? String, let blur = json?["blur"] as? [String] else { return nil }
        let error = (json?["error"] as? String).map { String($0.prefix(300)) }.flatMap { $0.isEmpty ? nil : $0 }
        return .choose(job: job, path: path, blur: blur, error: error)
    case "state": return rest.isEmpty ? nil : .state(job: rest)
    case "cancel": return rest.isEmpty ? nil : .cancel(job: rest)
    case "show": return rest.isEmpty ? nil : .show(path: rest)
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
            return ["ok": true, "version": 1]
        case let .start(files, mode, look):
            if let problem = Self.refusal(files, allowed: allowed) { return ["problem": problem] }
            let job = Job(mode: mode, preset: LookPreset(look: look), files: files)
            jobs.append(job)
            let finished = jobs.filter { j in j !== job && !busy(j) }
            if finished.count > Self.keep { jobs.removeAll { j in finished.prefix(finished.count - Self.keep).contains { $0 === j } } }
            queue += job.items.indices.map { (job, $0, .scan) }
            pump()
            return ["job": job.id]
        case let .state(id):
            guard let job = job(id) else { return ["problem": "That Face Blur job is gone. Start again."] }
            return ["done": !busy(job), "items": job.items.map(Self.reply)]
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

    static func reply(_ item: Item) -> [String: Any] {
        var out: [String: Any] = ["path": item.path, "name": (item.path as NSString).lastPathComponent,
                                  "stage": item.stage.rawValue, "progress": item.progress]
        if let scan = item.scan {
            out["faces"] = scan.faces.map { ["id": $0.id, "picture": $0.picture, "note": $0.note, "blur": item.blur.contains($0.id)] }
        }
        if let file = item.out { out["out"] = file }
        if let error = item.error { out["error"] = error }
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
                let out = job.items[i].out.map(URL.init(fileURLWithPath:)) ?? CoverPipeline.outputURL(for: source, kind: scan.kind)
                try await CoverPipeline.write(scan, from: source, blur: job.items[i].blur, to: out, progress: progress)
                job.items[i].out = out.path
                job.items[i].progress = 1
                job.items[i].stage = .done
                job.items[i].error = nil
            }
        } catch {
            fail(job, i, job.cancelled || error is CancellationError ? "Stopped." : error.localizedDescription)
        }
    }
}
