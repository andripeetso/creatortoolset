import AppKit
import Foundation
import SwiftUI
import UniformTypeIdentifiers

/// Every dictation is written here before transcription (plus a .txt transcript
/// once it succeeds), so History can list recent ones and failures can be retried.
final class DictationRecordings: @unchecked Sendable {
    let directory: URL
    /// How many are kept; set from Settings.
    var keep = 10

    init(directory: URL) {
        self.directory = directory
    }

    /// Posted whenever a recording or transcript is added or removed.
    static let changed = Notification.Name("dictation.recordingsChanged")

    private static let nameFormat = "yyyy-MM-dd_HH-mm-ss"

    /// The saved file, or nil if writing failed (transcription still proceeds).
    func save(_ samples: [Float], at date: Date = Date()) -> URL? {
        let formatter = DateFormatter()
        formatter.dateFormat = Self.nameFormat
        var url = directory.appendingPathComponent("\(formatter.string(from: date)).wav")
        // two in the same second (a dropped file and a dictation): the second gets a suffix
        var n = 2
        while FileManager.default.fileExists(atPath: url.path) {
            url = directory.appendingPathComponent("\(formatter.string(from: date))-\(n).wav")
            n += 1
        }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            try WAVWriter.data(samples: samples, sampleRate: Int(AudioCapture.targetSampleRate)).write(to: url)
            DictationLog.info("  saved \(url.lastPathComponent)")
            prune()
            notify()
            return url
        } catch {
            DictationLog.error("  recording save failed: \(error)")
            return nil
        }
    }

    static func transcriptURL(for wav: URL) -> URL {
        wav.deletingPathExtension().appendingPathExtension("txt")
    }

    func saveTranscript(_ text: String, for wav: URL) {
        try? text.write(to: Self.transcriptURL(for: wav), atomically: true, encoding: .utf8)
        notify()
    }

    static func date(of wav: URL) -> Date? {
        let formatter = DateFormatter()
        formatter.dateFormat = nameFormat
        return formatter.date(from: String(wav.deletingPathExtension().lastPathComponent.prefix(19)))
    }

    /// Length in seconds, from the size of the 16 kHz 16-bit mono WAV we write.
    static func duration(of wav: URL) -> TimeInterval {
        let bytes = (try? wav.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 44
        return Double(max(bytes - 44, 0)) / (AudioCapture.targetSampleRate * 2)
    }

    /// Newest first. `text` is nil when no transcript exists (failed or still running).
    func recent() -> [(wav: URL, text: String?)] {
        let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "wav" }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
            .map { ($0, try? String(contentsOf: Self.transcriptURL(for: $0), encoding: .utf8)) }
    }

    /// Keeps only the newest `keep` recordings (and their transcripts).
    func prune() {
        let old = recent().dropFirst(max(1, keep))
        for (wav, _) in old {
            try? FileManager.default.removeItem(at: wav)
            try? FileManager.default.removeItem(at: Self.transcriptURL(for: wav))
        }
        if !old.isEmpty { notify() }
    }

    func clear() {
        try? FileManager.default.removeItem(at: directory)
        notify()
    }

    private func notify() {
        DispatchQueue.main.async { NotificationCenter.default.post(name: Self.changed, object: nil) }
    }
}

/// A transcription that failed after its audio was saved (or couldn't be).
struct TranscriptionFailed: UserFacingError {
    let underlying: Error
    let saved: URL?

    var userMessage: String {
        saved == nil ? "Transcription failed" : "Transcription failed · saved in History"
    }
}

/// A window listing the last few dictations: copy any transcript, or
/// transcribe recordings that failed.
@MainActor
enum DictationHistory {
    static let model = HistoryModel()
    private static var window: NSWindow?
    /// The app in front before History opened; it gets focus back on close.
    private static var previousApp: NSRunningApplication?

    static func show(retrying wav: URL? = nil) {
        if let front = NSWorkspace.shared.frontmostApplication, front != .current { previousApp = front }
        if window == nil {
            let host = NSHostingController(rootView: HistoryView(model: model))
            host.sizingOptions = []  // let setContentSize win over SwiftUI's minimum size
            let w = NSWindow(contentViewController: host)
            w.title = "Dictation History"
            w.setContentSize(NSSize(width: 540, height: 600))
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        model.reload()
        if let wav { model.retry(wav) }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()  // a shortcut can't activate an accessory app on macOS 14+
    }

    /// The History key: open History, or close it if it's already in front.
    static func toggle() {
        if let window, window.isKeyWindow {
            close()
        } else {
            show()
        }
    }

    /// Hides History and hands focus back, so a copied transcript pastes
    /// straight into the app it came from.
    static func close() {
        window?.orderOut(nil)
        previousApp?.activate()
    }
}

@MainActor
final class HistoryModel: ObservableObject {
    struct Item: Identifiable {
        let wav: URL
        let text: String?
        var id: URL { wav }
    }

    @Published private(set) var items: [Item] = []
    @Published private(set) var busy: Set<URL> = []
    @Published private(set) var errors: [URL: String] = [:]
    @Published private(set) var copied: URL?
    /// Set at startup to the on-device transcriber.
    var transcribe: (URL) async throws -> String = { _ in throw TranscriberError.notLoaded }

    init() {
        NotificationCenter.default.addObserver(forName: DictationRecordings.changed, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.reload() }
        }
    }

    func reload() {
        Dictation.recordings.prune()
        items = Dictation.recordings.recent().map { Item(wav: $0.wav, text: $0.text) }
    }

    func retry(_ wav: URL) {
        guard !busy.contains(wav) else { return }
        busy.insert(wav)
        errors[wav] = nil
        Task {
            do {
                Dictation.recordings.saveTranscript(try await transcribe(wav), for: wav)
            } catch {
                errors[wav] = error.localizedDescription
            }
            busy.remove(wav)
        }
    }

    func copy(_ item: Item) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(item.text ?? "", forType: .string)
        copied = item.wav
        DictationHistory.close()
        Task {
            try? await Task.sleep(for: .seconds(1.5))
            if copied == item.wav { copied = nil }
        }
    }
}

struct HistoryView: View {
    @ObservedObject var model: HistoryModel
    @State private var confirmingClear = false

    var body: some View {
        Group {
            if model.items.isEmpty {
                ContentUnavailableView(
                    "No recordings yet",
                    systemImage: "waveform",
                    description: Text("Your last \(Dictation.recordings.keep) dictations show up here.")
                )
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(model.items) { RecordingCard(item: $0, model: model) }
                    }
                    .padding(14)
                }
            }
        }
        .frame(minWidth: 420, minHeight: 320)
        .toolbar {
            Button(role: .destructive) {
                confirmingClear = true
            } label: {
                Label("Clear History", systemImage: "trash")
            }
            .disabled(model.items.isEmpty)
            Button {
                try? FileManager.default.createDirectory(at: Dictation.recordings.directory, withIntermediateDirectories: true)
                NSWorkspace.shared.open(Dictation.recordings.directory)
            } label: {
                Label("Show in Finder", systemImage: "folder")
            }
        }
        .confirmationDialog("Delete all recordings and transcripts?", isPresented: $confirmingClear) {
            Button("Clear History", role: .destructive) { Dictation.recordings.clear() }
        }
    }
}

private struct RecordingCard: View {
    let item: HistoryModel.Item
    @ObservedObject var model: HistoryModel

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if let date = DictationRecordings.date(of: item.wav) {
                    Text(date, format: .dateTime.hour().minute()).font(.headline)
                }
                Text(Duration.seconds(DictationRecordings.duration(of: item.wav)), format: .time(pattern: .minuteSecond))
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
                Spacer()
                ShareLink(item: item.wav) {
                    Label("Share audio", systemImage: "square.and.arrow.up")
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .help("Share the audio file")
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([item.wav])
                } label: {
                    Label("Show in Finder", systemImage: "folder")
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .help("Show the audio file in Finder")
                action
            }
            content
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(nsColor: .separatorColor)))
    }

    @ViewBuilder private var action: some View {
        if item.text != nil {
            Button {
                model.copy(item)
            } label: {
                // Sized for the larger of each pair, so the swap doesn't resize the button.
                let copied = model.copied == item.wav
                Label {
                    ZStack(alignment: .leading) {
                        Text("Copied").hidden()
                        Text(copied ? "Copied" : "Copy")
                    }
                } icon: {
                    ZStack {
                        Image(systemName: "doc.on.doc").hidden()
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                    }
                }
            }
            .disabled(item.text?.isEmpty ?? true)
        } else if model.busy.contains(item.wav) {
            ProgressView().controlSize(.small)
        } else {
            Button {
                model.retry(item.wav)
            } label: {
                Label("Transcribe", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder private var content: some View {
        if let text = item.text {
            Text(text.isEmpty ? "No speech detected" : text)
                .foregroundStyle(text.isEmpty ? .secondary : .primary)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if model.busy.contains(item.wav) {
            Text("Transcribing…").foregroundStyle(.secondary)
        } else {
            Label(model.errors[item.wav] ?? "Not transcribed", systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
    }
}

/// The Transcribe a file key (F15): a drop zone for audio/video files. Each file is transcribed on-device in
/// the background, saved to History, and announced with a toast when done.
@MainActor
enum TranscribeFile {
    static let model = TranscribeFileModel()
    private static var window: NSWindow?

    static func show() {
        if window == nil {
            let w = NSWindow(contentViewController: NSHostingController(rootView: TranscribeFileView(model: model)))
            w.title = "Transcribe Files"
            w.styleMask.remove(.resizable)
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
        window?.orderFrontRegardless()  // a shortcut can't activate an accessory app on macOS 14+
    }

    static func toggle() {
        if let window, window.isKeyWindow {
            window.orderOut(nil)
        } else {
            show()
        }
    }
}

@MainActor
final class TranscribeFileModel: ObservableObject {
    struct Job: Identifiable {
        let id = UUID()
        let name: String
    }

    @Published private(set) var jobs: [Job] = []
    /// Set at startup to the on-device transcriber.
    var transcribe: ([Float]) async throws -> String = { _ in throw TranscriberError.notLoaded }

    func add(_ urls: [URL]) {
        for url in urls {
            guard UTType(filenameExtension: url.pathExtension)?.conforms(to: .audiovisualContent) == true else {
                DictationToast.show(title: "Not an audio or video file", subtitle: url.lastPathComponent)
                continue
            }
            let job = Job(name: url.lastPathComponent)
            jobs.append(job)
            Task {
                do {
                    // Decode + save off main (the key tap runs there). Saving puts it in
                    // History, so a failed transcription can be retried from there.
                    let (samples, wav) = try await Task.detached {
                        let samples = try AudioFileLoader.load(url: url)
                        guard !samples.isEmpty else { throw AudioFileLoader.LoaderError.invalidFormat }
                        return (samples, Dictation.recordings.save(samples))
                    }.value
                    let text = try await transcribe(samples)
                    if let wav { Dictation.recordings.saveTranscript(text, for: wav) }
                    DictationToast.show(title: "Transcription ready", subtitle: job.name, text: text)
                } catch {
                    DictationToast.show(title: "Couldn't transcribe", subtitle: "\(job.name): \(error.localizedDescription)")
                }
                jobs.removeAll { $0.id == job.id }
            }
        }
    }

    func choose() {
        let panel = NSOpenPanel()
        panel.prompt = "Transcribe"
        panel.allowsMultipleSelection = true
        panel.allowedContentTypes = [.audiovisualContent]
        guard panel.runModal() == .OK else { return }
        add(panel.urls)
    }
}

private struct TranscribeFileView: View {
    @ObservedObject var model: TranscribeFileModel
    @State private var targeted = false

    var body: some View {
        VStack(spacing: 12) {
            VStack(spacing: 8) {
                Image(systemName: "waveform.badge.plus")
                    .font(.system(size: 34))
                    .foregroundStyle(targeted ? Color.accentColor : .secondary)
                Text("Drop audio or video here").font(.headline)
                Text("Transcribed on this Mac in the background").font(.caption).foregroundStyle(.secondary)
                Button("Choose File…") { model.choose() }
                    .padding(.top, 4)
            }
            .frame(maxWidth: .infinity, minHeight: 180)
            .background(RoundedRectangle(cornerRadius: 12).fill(targeted ? Color.accentColor.opacity(0.08) : .clear))
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .strokeBorder(style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
                    .foregroundStyle(targeted ? Color.accentColor : Color.secondary.opacity(0.5))
            )
            .dropDestination(for: URL.self) { urls, _ in
                model.add(urls)
                return true
            } isTargeted: { targeted = $0 }

            ForEach(model.jobs) { job in
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(job.name).lineLimit(1).truncationMode(.middle)
                    Spacer()
                    Text("Transcribing…").font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .padding(16)
        .frame(width: 380)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// Small top-right toast for a transcribed file, with Copy.
@MainActor
enum DictationToast {
    private static var panel: NSPanel?
    private static var hideTask: Task<Void, Never>?

    static func show(title: String, subtitle: String, text: String? = nil) {
        let panel = self.panel ?? {
            let p = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.level = .floating
            p.isOpaque = false
            p.backgroundColor = .clear
            p.hasShadow = true
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            self.panel = p
            return p
        }()
        let host = NSHostingController(rootView: DictationToastView(title: title, subtitle: subtitle, text: text))
        panel.contentViewController = host
        let size = host.view.fittingSize
        if let screen = NSScreen.main?.visibleFrame {
            panel.setFrame(NSRect(x: screen.maxX - size.width - 16, y: screen.maxY - size.height - 16,
                                  width: size.width, height: size.height), display: true)
        }
        panel.orderFrontRegardless()
        NSSound(named: "Glass")?.play()

        hideTask?.cancel()
        hideTask = Task {
            try? await Task.sleep(for: .seconds(text == nil ? 5 : 12))
            if !Task.isCancelled { hide() }
        }
    }

    static func hide() {
        hideTask?.cancel()
        panel?.orderOut(nil)
    }
}

private struct DictationToastView: View {
    let title: String
    let subtitle: String
    let text: String?
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Text(title).font(.headline)
                Spacer()
                Button { DictationToast.hide() } label: { Image(systemName: "xmark") }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
            }
            Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2).truncationMode(.middle)
            if let text {
                Text(text.isEmpty ? "No speech detected" : text).lineLimit(3)
                HStack {
                    Spacer()
                    Button("Open History") {
                        DictationHistory.show()
                        DictationToast.hide()
                    }
                    Button(copied ? "Copied" : "Copy") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(text, forType: .string)
                        copied = true
                    }
                    .buttonStyle(.borderedProminent)
                    .frame(minWidth: 70)
                }
                .padding(.top, 2)
            }
        }
        .padding(14)
        .frame(width: 340)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// A short sound when recording starts and stops.
@MainActor
final class DictationSounds: DictationObserver {
    /// Set from Settings.
    var enabled = true
    private let start = NSSound(named: "Tink")
    private let stop = NSSound(named: "Pop")

    func dictationStarted() { play(start) }
    func dictationTranscribing() { play(stop) }

    private func play(_ sound: NSSound?) {
        guard enabled, let sound else { return }
        sound.stop()
        sound.play()
    }
}

/// When a transcription fails, says the audio is safe and offers History.
@MainActor
final class FailureAlert: DictationObserver {
    func dictationFailed(_ error: Error) {
        guard let failure = error as? TranscriptionFailed else { return }
        // After this turn, so the overlay and menu bar settle first.
        DispatchQueue.main.async {
            let alert = NSAlert()
            alert.messageText = "Transcription failed"
            alert.alertStyle = .warning
            guard failure.saved != nil else {
                alert.informativeText = "\(failure.underlying.localizedDescription)\n\nThe recording could not be saved."
                alert.runModal()
                return
            }
            alert.informativeText = "\(failure.underlying.localizedDescription)\n\nThe recording is saved in History, where you can transcribe it again."
            alert.addButton(withTitle: "Open History")
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            if alert.runModal() == .alertFirstButtonReturn {
                DictationHistory.show()
            }
        }
    }
}
