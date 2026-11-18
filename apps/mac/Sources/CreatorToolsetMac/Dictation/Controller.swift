import Foundation

/// The microphone side of the loop, a protocol so the loop is tested without one.
@MainActor
protocol Capturing: AnyObject {
    func start() throws
    func finish() throws -> [Float]
    @discardableResult func stop() -> [Float]
}

extension AudioCapture: Capturing {}

/// Where a finished transcript goes, a protocol so the loop is tested without pasting.
@MainActor
protocol Delivering: AnyObject {
    func deliver(_ text: String, focusAtStart: FocusSnapshot?) throws
}

extension TextDelivery: Delivering {}

/// The dictation loop: press → capture → transcribe → deliver.
///
/// Owns the state machine and nothing else. Features plug in as a
/// `DictationObserver` (reacting to the loop), not as branches here.
///
/// Edge cases:
/// - A press always tries to start capture, even while an earlier capture is
///   still transcribing. That transcription still delivers, and its
///   `dictationFinished` reaches observers while the new recording runs.
/// - A press whose capture fails to start logs and notifies `dictationFailed`
///   with the capture error; the state does not change.
/// - A release always stops capture and notifies `dictationTranscribing`,
///   even with nothing recorded; an empty capture then fails with
///   `DictationError.noAudio`.
/// - A transcript that does not reach the cursor (a secure field, or focus
///   moved since the press) fails with its `DeliveryError`.
@MainActor
final class DictationController {
    enum State: Equatable {
        case idle
        case recording
        case transcribing
    }

    private(set) var state: State = .idle

    private let capture: Capturing
    /// Replaced by `replaceTranscriber` when the model changes.
    private(set) var transcriber: Transcriber
    /// The person's own speech server, tried before `transcriber`; nil when none is set.
    var remote: Transcriber?
    private let observers: [DictationObserver]
    private let delivery: Delivering
    /// Where recordings are saved before they are transcribed.
    private let recordings: DictationRecordings
    /// What to tell the transcriber about each dictation (the languages),
    /// asked once per release.
    private let context: @MainActor () -> TranscriptionContext
    /// Transcriptions started and not yet finished or failed.
    private var inFlight = 0
    /// Numbers each transcription; those at or below `discardedThrough` were
    /// cancelled by `discard` and deliver nothing when they finish.
    private var lastStarted = 0
    private var discardedThrough = 0
    /// The newest transcription's delivery; the next one waits for it.
    private var lastDelivery: Task<Void, Never>?
    /// What had focus when the current recording started.
    private var focusAtStart: FocusSnapshot?

    init(
        capture: Capturing,
        transcriber: Transcriber,
        observers: [DictationObserver],
        delivery: Delivering,
        recordings: DictationRecordings,
        context: @escaping @MainActor () -> TranscriptionContext = { TranscriptionContext() }
    ) {
        self.capture = capture
        self.transcriber = transcriber
        self.observers = observers
        self.delivery = delivery
        self.recordings = recordings
        self.context = context
    }

    /// Uses `transcriber` from the next release on. A transcription already
    /// running finishes with the one it started with.
    func replaceTranscriber(_ transcriber: Transcriber) {
        self.transcriber = transcriber
    }

    /// Starts recording. `announce` false: the pill and the start sound wait
    /// for `announce()`, so a stray tap on a held key shows and plays nothing.
    func press(announce: Bool = true) {
        do {
            try capture.start()
        } catch {
            DictationLog.error("capture failed: \(error)")
            observers.forEach { $0.dictationFailed(error) }
            return
        }
        focusAtStart = focus()
        DictationLog.info("● recording")
        state = .recording
        if announce { observers.forEach { $0.dictationStarted() } }
    }

    /// Shows a recording started with `press(announce: false)`.
    func announce() {
        guard state == .recording else { return }
        observers.forEach { $0.dictationStarted() }
    }

    /// What has focus now; replaced in tests, which have no Accessibility.
    var focus: () -> FocusSnapshot? = { FocusSnapshot.capture() }

    func release() {
        let samples: [Float]
        do {
            samples = try capture.finish()
        } catch {
            DictationLog.error("capture failed: \(error)")
            focusAtStart = nil
            state = inFlight > 0 ? .transcribing : .idle
            // The mic went away mid-recording: what it caught is kept in History, never pasted.
            if case CaptureError.routeChanged(let captured) = error, !captured.isEmpty {
                let failure = TranscriptionFailed(underlying: error, saved: recordings.save(captured))
                observers.forEach { $0.dictationFailed(failure) }
            } else {
                observers.forEach { $0.dictationFailed(error) }
            }
            return
        }
        let focus = focusAtStart
        focusAtStart = nil
        state = .transcribing
        observers.forEach { $0.dictationTranscribing() }

        let seconds = Double(samples.count) / AudioCapture.targetSampleRate
        DictationLog.info(String(format: "○ captured %.2fs · rms %.3f", seconds, computeRMS(samples)))

        guard !samples.isEmpty else {
            settle()
            observers.forEach { $0.dictationFailed(DictationError.noAudio) }
            return
        }

        inFlight += 1
        lastStarted += 1
        let id = lastStarted
        let transcriber = self.transcriber
        let remote = self.remote
        let context = self.context()
        let recordings = self.recordings
        // On disk before transcription, so a failure can be retried from History.
        let saved = recordings.save(samples)
        let previous = lastDelivery
        lastDelivery = Task {
            let started = CFAbsoluteTimeGetCurrent()
            let outcome: Result<Transcript, Error>
            do {
                // The transcriber is an actor; this await runs off the main actor.
                let transcript = try await transcribe(samples, context: context, local: transcriber, remote: remote, id: id)
                // Never log the transcript itself: the agent's log is a file on disk.
                DictationLog.info(String(format: "→ %.2fs · %d chars", CFAbsoluteTimeGetCurrent() - started, transcript.text.count))
                if let saved { recordings.saveTranscript(transcript.text, for: saved) }
                outcome = .success(transcript)
            } catch {
                DictationLog.error("transcription failed: \(error)")
                outcome = .failure(error)
            }
            // Delivered in release order: a short dictation never pastes before a longer one released earlier.
            if id > discardedThrough { await previous?.value }
            // Still in History, in case the cancel was a mistake. `discard` already stopped counting it.
            guard id > discardedThrough else { return }
            inFlight -= 1
            settle()
            switch outcome {
            case .success(let transcript):
                do {
                    try delivery.deliver(transcript.text, focusAtStart: focus)
                    observers.forEach { $0.dictationFinished() }
                } catch {
                    observers.forEach { $0.dictationFailed(error) }
                }
            case .failure(let error):
                let failure = TranscriptionFailed(underlying: error, saved: saved)
                observers.forEach { $0.dictationFailed(failure) }
            }
        }
    }

    /// The speech server first when there is one, then the on-device model, which gets one more try before the
    /// dictation fails. A model still loading is waited for, and the pill says so instead of counting seconds.
    private func transcribe(
        _ samples: [Float], context: TranscriptionContext, local: Transcriber, remote: Transcriber?, id: Int
    ) async throws -> Transcript {
        if let remote {
            do {
                return try await remote.transcribe(samples, context: context)
            } catch {
                DictationLog.warning("speech server didn't answer (\(error.localizedDescription)), using \(local.modelID)")
            }
        }
        if let model = local as? LoadingTranscriber {
            // with a server and no model on this Mac, nothing downloads by itself: the recording waits in History
            if remote != nil, !model.onDisk { throw SpeechServerDown() }
            if !(await model.loaded()) {
                tell(id) { $0.dictationWaitingForModel() }
                try await model.load()
                tell(id) { $0.dictationTranscribing() }
            }
        }
        do {
            return try await local.transcribe(samples, context: context)
        } catch {
            // the server's engine is not asked twice: a second wait on the network would double the first
            if local is ServerTranscriber { throw error }
            DictationLog.error("transcription failed: \(error), retrying on-device")
            return try await local.transcribe(samples, context: context)
        }
    }

    /// Only the newest transcription, still running and not cancelled, changes what the pill says.
    private func tell(_ id: Int, _ call: (DictationObserver) -> Void) {
        guard state == .transcribing, id == lastStarted, id > discardedThrough else { return }
        observers.forEach(call)
    }

    /// A saved recording or a dropped file, on this Mac with the current model.
    func transcribeOnDevice(_ samples: [Float]) async throws -> String {
        try await transcriber.transcribe(samples, context: context()).text
    }

    /// The gesture discarded this recording (a short tap, a chord, or a
    /// hold key switch): stop capture and transcribe nothing.
    func cancel() {
        guard state == .recording else { return }
        capture.stop()
        focusAtStart = nil
        state = inFlight > 0 ? .transcribing : .idle
        DictationLog.info("○ discarded")
        observers.forEach { $0.dictationFailed(DictationError.cancelled) }
    }

    /// The cancel key: throw away the recording in progress, or, when not
    /// recording, every transcription still running, so nothing is pasted.
    func discard() {
        switch state {
        case .idle:
            return
        case .recording:
            capture.stop()
            focusAtStart = nil
            state = inFlight > 0 ? .transcribing : .idle
            DictationLog.info("○ discarded recording")
        case .transcribing:
            discardedThrough = lastStarted
            inFlight = 0
            lastDelivery = nil
            state = .idle
            DictationLog.info("○ discarded transcription")
        }
        observers.forEach { $0.dictationFailed(Discarded()) }
    }

    /// After a transcription ends, return to idle unless a newer recording
    /// or transcription is still running.
    private func settle() {
        if state == .transcribing, inFlight == 0 {
            state = .idle
        }
    }
}

enum DictationError: Error {
    /// The talk key was released with no audio captured.
    case noAudio
    /// The recording was discarded: a short tap, a chord, or a hold key switch.
    case cancelled
}

/// The speech server didn't answer and this Mac has no model to fall back on.
struct SpeechServerDown: UserFacingError {
    var userMessage: String { "Your speech server didn't answer" }
}

/// The cancel key (F16) threw away a recording or a transcription in progress.
struct Discarded: UserFacingError {
    var userMessage: String { "Cancelled" }
}

/// Follows the dictation loop: the pill, the sounds, the menu bar row.
///
/// `DictationController` calls these on the main actor, in the order the
/// observers were registered. Every method has an empty default, so an
/// observer implements only what it needs. New behaviour that reacts to a
/// dictation is an observer, not a branch in the controller.
@MainActor
protocol DictationObserver: AnyObject {
    /// Recording started.
    func dictationStarted()
    /// The hotkey was released; the capture is being transcribed.
    func dictationTranscribing()
    /// The model is still loading (the first time in a new app it takes a few minutes); transcribing comes after.
    func dictationWaitingForModel()
    /// The transcript was delivered.
    func dictationFinished()
    /// Nothing reached the cursor: capture failed (`CaptureError`), no audio
    /// (`DictationError.noAudio`), the transcriber threw, or delivery was
    /// refused (`DeliveryError`).
    func dictationFailed(_ error: Error)
}

extension DictationObserver {
    func dictationStarted() {}
    func dictationTranscribing() {}
    func dictationWaitingForModel() {}
    func dictationFinished() {}
    func dictationFailed(_ error: Error) {}
}

/// An error with a short message the user should see, for example in the
/// pill. Anything else reaching `dictationFailed` is only logged.
protocol UserFacingError: Error {
    /// One line, actionable, never containing transcript text.
    var userMessage: String { get }
}
