import AVFoundation
import AVKit
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Story Splitter, on the phone: a video from Photos →
/// stories of about 20 s, each saved back to Photos as its own MP4. The same
/// cuts as the website's /stories (`StorySplit`), read and cut with
/// AVFoundation; nothing is uploaded.
struct StorySplitterView: View {
    /// A video already on the phone (a Finals piece, a Ready-to-post file): opened
    /// at once. Nil: the Photos picker.
    var file: URL?
    @StateObject private var model = StorySplitterModel()
    @State private var item: PhotosPickerItem?

    var body: some View {
        content
            .navigationTitle("Story Splitter")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if model.player != nil {
                    ToolbarItem(placement: .topBarTrailing) {
                        PhotosPicker("Another video", selection: $item, matching: .videos,
                                     preferredItemEncoding: .current)
                    }
                }
            }
            .onChange(of: item) { _, picked in
                guard let picked else { return }
                item = nil // so the same video can be picked again
                model.open { try await picked.loadTransferable(type: PickedVideo.self) }
            }
            .onDisappear { model.player?.pause() }
            .task {
                guard let file, model.player == nil, !model.loading else { return }
                model.open { PickedVideo(url: file, name: file.lastPathComponent) }
            }
    }

    @ViewBuilder private var content: some View {
        if let player = model.player {
            VStack(spacing: 0) {
                NativePlayer(player: player)
                    .frame(height: 300)
                    .background(.black)
                List {
                    if let error = model.error { errorRow(error) }
                    if let p = model.analysing {
                        Section {
                            VStack(alignment: .leading, spacing: 8) {
                                HStack {
                                    Text("Finding cuts, pauses and beats")
                                    Spacer()
                                    Text("\(Int(p * 100))%").monospacedDigit().foregroundStyle(.secondary)
                                }
                                .font(.subheadline)
                                ProgressView(value: p)
                            }
                            .padding(.vertical, 4)
                        }
                    } else if let analysis = model.analysis {
                        controls(analysis)
                        stories
                    }
                }
            }
            .safeAreaInset(edge: .bottom) {
                if model.analysis != nil { saveBar }
            }
        } else if model.loading {
            ProgressView("Getting the video…")
        } else {
            ContentUnavailableView {
                Label("Story Splitter", systemImage: "scissors")
            } description: {
                Text("Pick a video to split it into stories of about 20 seconds. It cuts on the edit's own cuts, in pauses and on the beat. Nothing is uploaded.")
                if let error = model.error { Text(error).foregroundStyle(.red) }
            } actions: {
                PhotosPicker("Choose a video", selection: $item, matching: .videos, preferredItemEncoding: .current)
                    .buttonStyle(.borderedProminent)
            }
        }
    }

    private func errorRow(_ error: String) -> some View {
        Section {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline)
                .foregroundStyle(.red)
        }
    }

    private func controls(_ analysis: StorySplit.Analysis) -> some View {
        Section {
            Timeline(analysis: analysis, cuts: model.cuts, now: model.now) { model.seek($0) }
                .listRowInsets(EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12))
            HStack {
                Button { model.cutHere() } label: { Label("Cut here", systemImage: "scissors") }
                Spacer()
                Button { model.autoSplit() } label: { Label("Auto split", systemImage: "wand.and.stars") }
            }
            .buttonStyle(.borderless)
            HStack(spacing: 12) {
                Text("About \(Int(model.target)) s").monospacedDigit().frame(width: 84, alignment: .leading)
                Slider(value: $model.target, in: 8...45, step: 1).accessibilityLabel("Story length")
            }
        } footer: {
            Text("\(plural(analysis.shots, "cut")) in the edit · \(plural(analysis.pauses, "pause")) · "
                 + (analysis.bpm.map { "a steady beat, \($0) BPM" } ?? "no steady beat"))
        }
    }

    private var stories: some View {
        Section {
            ForEach(model.stories) { story in
                Button { model.play(story) } label: { StoryRow(story: story) }
                    .listRowBackground(model.isCurrent(story) ? Color(.systemGray5) : nil)
                    .swipeActions {
                        if story.cut != nil {
                            Button("Join with next") { model.removeCut(after: story) }.tint(.orange)
                        }
                    }
            }
        } footer: {
            Text(model.stories.count > 1 ? "Tap a story to play it. Swipe one to join it with the next."
                                         : "Tap the story to play it.")
        }
    }

    private var saveBar: some View {
        let n = model.stories.count
        return VStack(spacing: 8) {
            if let saving = model.saving {
                ProgressView(value: min(1, (Double(saving.story) + saving.p) / Double(max(1, n)))) {
                    Text("Saving story \(saving.story + 1) of \(n)").font(.footnote)
                }
            }
            if let done = model.done {
                Label(done, systemImage: "checkmark.circle.fill")
                    .font(.headline)
                    .foregroundStyle(.green)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
            } else {
                Button {
                    Task { await model.save() }
                } label: {
                    Label("Save \(plural(n, "story", "stories")) to Photos", systemImage: "square.and.arrow.down")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 6)
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.saving != nil)
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 10)
        .background(.bar)
    }
}

private func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String {
    "\(n) \(n == 1 ? one : many ?? one + "s")"
}

private func storyClock(_ t: Double) -> String {
    String(format: "%d:%04.1f", Int(t) / 60, t.truncatingRemainder(dividingBy: 60))
}

private struct StoryRow: View {
    let story: StorySplitterModel.Story

    var body: some View {
        let len = story.end - story.start
        HStack(spacing: 12) {
            Text("\(story.index + 1)")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(Color("AccentColor"))
                .frame(width: 30, height: 30)
                .background(Color("AccentColor").opacity(0.18), in: RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("\(storyClock(story.start)) – \(storyClock(story.end))").foregroundStyle(Color.primary)
                    Text(String(format: "%.1f s", len)).foregroundStyle(len > StorySplit.maxStory ? Color.red : Color.secondary)
                }
                .font(.subheadline)
                .monospacedDigit()
                if len > StorySplit.maxStory {
                    Label("Over 60 s, too long for one story", systemImage: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.red)
                }
                if let cut = story.cut {
                    HStack(spacing: 6) {
                        Circle().fill(tone(cut.spot.score)).frame(width: 6, height: 6)
                        Text("ends \(cut.spot.why.text)\(cut.mine ? " · yours" : "")")
                    }
                    .font(.caption)
                    .foregroundStyle(Color.secondary)
                }
            }
            Spacer()
            Image(systemName: "play.fill").font(.caption).foregroundStyle(Color.secondary)
        }
        .contentShape(Rectangle())
    }

    private func tone(_ score: Double) -> Color { score >= 0.6 ? .green : score >= 0.2 ? .yellow : .red }
}

/// The whole video: loudness, the edit's cuts (ticks on top), the story cuts
/// (yellow = yours) and the playhead. Tap or drag to move the playhead.
private struct Timeline: View {
    let analysis: StorySplit.Analysis
    let cuts: [StorySplitterModel.Cut]
    let now: Double
    let seek: (Double) -> Void

    var body: some View {
        GeometryReader { geo in
            Canvas { ctx, size in
                let d = max(analysis.duration, 0.001)
                func x(_ t: Double) -> CGFloat { CGFloat(t / d) * size.width }
                func line(_ t: Double, _ width: CGFloat, _ height: CGFloat, _ color: Color) {
                    ctx.fill(Path(CGRect(x: x(t) - width / 2, y: 0, width: width, height: height)), with: .color(color))
                }
                let bounds = [0] + cuts.map(\.t) + [d]
                for i in stride(from: 1, to: bounds.count - 1, by: 2) {
                    ctx.fill(Path(CGRect(x: x(bounds[i]), y: 0, width: x(bounds[i + 1]) - x(bounds[i]), height: size.height)),
                             with: .color(Color("AccentColor").opacity(0.12)))
                }
                let e = analysis.energy
                if !e.isEmpty {
                    let cols = max(1, Int(size.width / 2)), mid = size.height / 2
                    var wave = Path()
                    for c in 0..<cols {
                        let a = c * e.count / cols, b = max(a + 1, (c + 1) * e.count / cols)
                        let peak = CGFloat(e[a..<min(b, e.count)].max() ?? 0)
                        let h = 2 + (mid - 6) * peak
                        wave.addRect(CGRect(x: CGFloat(c) * 2, y: mid - h, width: 1.5, height: 2 * h))
                    }
                    ctx.fill(wave, with: .color(.secondary.opacity(0.45)))
                }
                for s in analysis.spots where s.why.isShot { line(s.t, 1, 8, .white.opacity(0.7)) }
                for c in cuts { line(c.t, 2, size.height, c.mine ? .yellow : Color("AccentColor")) }
                line(now, 1.5, size.height, .white)
            }
            .contentShape(Rectangle())
            .gesture(DragGesture(minimumDistance: 0).onChanged { drag in
                seek(min(1, max(0, drag.location.x / max(1, geo.size.width))) * analysis.duration)
            })
        }
        .frame(height: 64)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 8))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .accessibilityLabel("Timeline")
    }
}

// MARK: - Model

@MainActor
final class StorySplitterModel: ObservableObject {
    struct Cut: Equatable {
        var t: Double
        /// Added by hand ("Cut here"): kept when the rest is split again.
        var mine: Bool
    }

    struct Story: Identifiable {
        let index: Int
        let start: Double
        let end: Double
        /// The cut it ends on; nil for the last story.
        let cut: (spot: StorySplit.Spot, mine: Bool)?
        var id: Double { start }
    }

    struct Failure: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }

    @Published private(set) var player: AVPlayer?
    @Published private(set) var loading = false
    /// Reading the video: 0...1.
    @Published private(set) var analysing: Double?
    @Published private(set) var analysis: StorySplit.Analysis?
    @Published private(set) var cuts: [Cut] = [] { didSet { done = nil } }
    @Published var target = 20.0 {
        didSet { if target != oldValue { autoSplit() } }
    }
    @Published private(set) var now = 0.0
    @Published private(set) var saving: (story: Int, p: Double)?
    @Published private(set) var done: String?
    @Published private(set) var error: String?

    private var source: PickedVideo?
    private var run = 0
    private var task: Task<Void, Never>?
    private var observer: Any?
    /// A story played on its own stops at its end.
    private var playing: Story?

    nonisolated static let folder = FileManager.default.temporaryDirectory.appendingPathComponent("story-splitter", isDirectory: true)

    var stories: [Story] {
        guard let analysis else { return [] }
        let bounds = [0] + cuts.map(\.t) + [analysis.duration]
        return (0..<(bounds.count - 1)).map { i in
            Story(index: i, start: bounds[i], end: bounds[i + 1],
                  cut: i < cuts.count ? (StorySplit.spotAt(analysis, cuts[i].t), cuts[i].mine) : nil)
        }
    }

    func isCurrent(_ story: Story) -> Bool { now >= story.start && now < story.end }

    /// A new video: `load` fetches it (from Photos: a copy on disk).
    func open(_ load: @escaping () async throws -> PickedVideo?) {
        run += 1
        let run = self.run
        setPlayer(nil)
        source = nil
        analysis = nil
        cuts = []
        error = nil
        analysing = nil
        loading = true
        task?.cancel()
        task = Task {
            do {
                guard let picked = try await load() else {
                    throw Failure(message: "Couldn't read that video.")
                }
                guard run == self.run else { return }
                source = picked
                setPlayer(AVPlayer(url: picked.url))
                loading = false
                analysing = 0
                let analysis = try await StorySignals.analyse(picked.url) { p in
                    Task { @MainActor [weak self] in
                        if let self, self.run == run, self.analysing != nil { self.analysing = p }
                    }
                }
                guard run == self.run else { return }
                self.analysis = analysis
                cuts = plan(analysis, pinned: [])
            } catch {
                if run == self.run { self.error = error.localizedDescription }
            }
            if run == self.run {
                loading = false
                analysing = nil
            }
        }
    }

    /// Places the cuts again, keeping the ones added by hand.
    func autoSplit() {
        guard let analysis else { return }
        cuts = plan(analysis, pinned: cuts.filter(\.mine).map(\.t))
    }

    private func plan(_ analysis: StorySplit.Analysis, pinned: [Double]) -> [Cut] {
        StorySplit.planCuts(analysis, target: target, pinned: pinned).map { Cut(t: $0, mine: pinned.contains($0)) }
    }

    /// A cut about here: the best moment within 2.5 s of the playhead.
    func cutHere() {
        guard let analysis, let player else { return }
        let at = StorySplit.snapCut(analysis, player.currentTime().seconds)
        guard at > 0.3, at < analysis.duration - 0.3, !cuts.contains(where: { abs($0.t - at) < 0.5 }) else { return }
        cuts = (cuts + [Cut(t: at, mine: true)]).sorted { $0.t < $1.t }
    }

    func removeCut(after story: Story) {
        guard story.index < cuts.count else { return }
        cuts.remove(at: story.index)
    }

    // MARK: Playing

    func seek(_ t: Double) {
        playing = nil
        now = t
        player?.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func play(_ story: Story) {
        guard let player else { return }
        seek(story.start)
        playing = story
        player.play()
    }

    private func setPlayer(_ new: AVPlayer?) {
        if let observer { player?.removeTimeObserver(observer) }
        player?.pause()
        observer = nil
        now = 0
        playing = nil
        player = new
        observer = new?.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 20), queue: .main) { [weak self] time in
            MainActor.assumeIsolated { self?.tick(time.seconds) }
        }
    }

    private func tick(_ t: Double) {
        guard t.isFinite else { return }
        now = t
        guard let story = playing else { return }
        if t >= story.end {
            player?.pause()
            playing = nil
        } else if t < story.start - 0.5 {
            playing = nil // scrubbed away
        }
    }

    // MARK: Saving

    /// Each story as its own MP4 (re-encoded, so every cut is frame exact),
    /// then all of them into Photos.
    func save() async {
        guard let source, let analysis, saving == nil else { return }
        player?.pause()
        error = nil
        let bounds = [0] + cuts.map(\.t) + [analysis.duration]
        let folder = Self.folder.appendingPathComponent("out-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        saving = (0, 0)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let asset = AVURLAsset(url: source.url)
            let base = baseName(source.name)
            var files: [URL] = []
            for i in 0..<(bounds.count - 1) {
                let file = folder.appendingPathComponent(String(format: "%@-%02d.mp4", base, i + 1))
                try await export(asset, from: bounds[i], to: bounds[i + 1], into: file) { [weak self] p in
                    self?.saving = (i, p)
                }
                files.append(file)
                saving = (i + 1, 0)
            }
            try await SaveToPhotos.add(files)
            done = "Saved \(plural(files.count, "story", "stories")) to Photos"
        } catch {
            self.error = error.localizedDescription
        }
        saving = nil
    }

    private func export(_ asset: AVAsset, from: Double, to: Double, into file: URL,
                        progress: @escaping @MainActor (Double) -> Void) async throws {
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetHighestQuality) else {
            throw Failure(message: "This phone can't make stories from this video.")
        }
        session.timeRange = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600),
                                        end: CMTime(seconds: to, preferredTimescale: 600))
        if #available(iOS 18, *) {
            let watch = Task { @MainActor in
                for await state in session.states(updateInterval: 0.2) {
                    if case .exporting(let p) = state { progress(p.fractionCompleted) }
                }
            }
            defer { watch.cancel() }
            try await session.export(to: file, as: .mp4)
        } else {
            session.outputURL = file
            session.outputFileType = .mp4
            await session.export()
            if let error = session.error { throw error }
            guard session.status == .completed else { throw Failure(message: "Couldn't make a story.") }
        }
    }

    /// The video's name as a file name stem, like the website's.
    private func baseName(_ name: String) -> String {
        let stem = ((name as NSString).deletingPathExtension)
            .replacingOccurrences(of: "[^A-Za-z0-9_.-]+", with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        return stem.isEmpty ? "story" : String(stem.prefix(60))
    }
}

/// The picked video, copied out of Photos into the app's temporary folder
/// (a file, so a long video never has to fit in memory). The last pick's
/// copy is removed when the next one comes in.
struct PickedVideo: Transferable {
    let url: URL
    let name: String

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let folder = StorySplitterModel.folder.appendingPathComponent("source", isDirectory: true)
            try? FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let name = received.file.lastPathComponent
            let copy = folder.appendingPathComponent(name)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedVideo(url: copy, name: name)
        }
    }
}

// MARK: - Signals

/// What `readSignals` in apps/captions/src/lib/story-split.ts reads, with
/// AVFoundation: every frame at 64×36 and how much its brightness differs from
/// the frame before, and the loudness in dB, 100 values per second.
enum StorySignals {
    static func analyse(_ url: URL, progress: @escaping @Sendable (Double) -> Void) async throws -> StorySplit.Analysis {
        StorySplit.analyse(try await read(url, progress: progress))
    }

    static func read(_ url: URL, progress: @escaping @Sendable (Double) -> Void) async throws -> StorySplit.Signals {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration).seconds
        guard let video = try await asset.loadTracks(withMediaType: .video).first else {
            throw StorySplitterModel.Failure(message: "This file has no video.")
        }
        guard duration.isFinite, duration > 0 else { throw StorySplitterModel.Failure(message: "This video is empty.") }
        let audio = try await asset.loadTracks(withMediaType: .audio).first
        let db = try audio.map { try loudness(asset, $0, duration: duration) } ?? []
        progress(0.1)
        let frames = try frameDiffs(asset, video, duration: duration) { progress(0.1 + 0.9 * $0) }
        return StorySplit.Signals(duration: duration, frames: frames, db: db)
    }

    /// Every decoded frame, scaled to 64×36 by the decoder, as luma 0...1;
    /// its diff is the mean change from the frame before.
    private static func frameDiffs(_ asset: AVAsset, _ track: AVAssetTrack, duration: Double,
                                   progress: (Double) -> Void) throws -> [StorySplit.Frame] {
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: 64,
            kCVPixelBufferHeightKey as String: 36,
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? StorySplitterModel.Failure(message: "Couldn't read this video.") }
        defer { reader.cancelReading() }
        var frames: [StorySplit.Frame] = []
        var last: [Float] = []
        var shown = -1
        while let buffer = output.copyNextSampleBuffer() {
            try Task.checkCancellation()
            guard let pixels = CMSampleBufferGetImageBuffer(buffer) else { continue }
            let t = CMSampleBufferGetPresentationTimeStamp(buffer).seconds
            CVPixelBufferLockBaseAddress(pixels, .readOnly)
            let w = CVPixelBufferGetWidth(pixels), h = CVPixelBufferGetHeight(pixels)
            let row = CVPixelBufferGetBytesPerRow(pixels)
            guard let base = CVPixelBufferGetBaseAddress(pixels)?.assumingMemoryBound(to: UInt8.self) else {
                CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
                continue
            }
            var luma = [Float](repeating: 0, count: w * h), diff = 0.0
            for y in 0..<h {
                let line = base + y * row
                for x in 0..<w {
                    let px = line + x * 4 // B, G, R, A
                    let i = y * w + x
                    luma[i] = Float((0.299 * Double(px[2]) + 0.587 * Double(px[1]) + 0.114 * Double(px[0])) / 255)
                    if last.count == luma.count { diff += abs(Double(luma[i]) - Double(last[i])) }
                }
            }
            CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
            frames.append(StorySplit.Frame(t: t, diff: diff / Double(w * h)))
            last = luma
            let percent = Int(100 * min(1, t / duration))
            if percent != shown { shown = percent; progress(Double(percent) / 100) }
        }
        if reader.status == .failed { throw reader.error ?? StorySplitterModel.Failure(message: "Couldn't read this video.") }
        return frames
    }

    /// Mean square of the mono mix per 10 ms, in dB.
    private static func loudness(_ asset: AVAsset, _ track: AVAssetTrack, duration: Double) throws -> [Float] {
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false,
        ])
        output.alwaysCopiesSampleData = false
        reader.add(output)
        guard reader.startReading() else { return [] }
        defer { reader.cancelReading() }
        let hz = Double(StorySplit.hz)
        let n = Int((duration * hz).rounded(.up))
        var sum = [Double](repeating: 0, count: n), count = [Int](repeating: 0, count: n)
        var samples: [Float] = []
        while let buffer = output.copyNextSampleBuffer() {
            try Task.checkCancellation()
            guard let block = CMSampleBufferGetDataBuffer(buffer),
                  let format = CMSampleBufferGetFormatDescription(buffer),
                  let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { continue }
            let channels = max(1, Int(asbd.mChannelsPerFrame)), rate = asbd.mSampleRate
            let start = CMSampleBufferGetPresentationTimeStamp(buffer).seconds
            let length = CMBlockBufferGetDataLength(block)
            samples = [Float](repeating: 0, count: length / 4)
            guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: samples.count * 4,
                                             destination: &samples) == kCMBlockBufferNoErr else { continue }
            for j in 0..<(samples.count / channels) {
                let k = Int(((start + Double(j) / rate) * hz).rounded(.down))
                if k < 0 || k >= n { continue }
                var v = 0.0
                for c in 0..<channels { v += Double(samples[j * channels + c]) }
                v /= Double(channels)
                sum[k] += v * v
                count[k] += 1
            }
        }
        return (0..<n).map { Float(10 * log10(sum[$0] / Double(max(1, count[$0])) + 1e-10)) }
    }
}
