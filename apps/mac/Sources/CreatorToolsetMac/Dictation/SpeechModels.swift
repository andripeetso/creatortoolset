// This Mac as one of the person's computers that run speech models (Settings → AI → Voice, "Models on your
// computers"). Its claim (Relay.swift, TranscribeJob.swift) says which dictation models it has and is downloading, and
// the server answers with the ones its owner wants here. There is one Download and one Remove (Dictation `fetch` and
// `remove`): pressed in Settings' Dictation row they run here at once and the next claim tells the server
// (`asked`, or the model is gone); pressed on the Voice page they reach this Mac as the server's wish (`want`).
// The earlier dictation app's folder is only ever read: a model there that is removed is set aside, never deleted.
import Foundation
import WhisperKit

@MainActor
final class SpeechModels {
    static let shared = SpeechModels()

    /// After a model came, went or started downloading: the relay claims, so the server knows at once. Set by the Shell.
    var onChange: (() -> Void)?
    /// The server's wishes waiting for a download (one runs at a time), and the ones whose download failed, with when.
    private var queue: [String] = []
    private var failed: [String: Date] = [:]
    /// A failed download is tried again this long after, when it is still wanted.
    nonisolated static let retry: TimeInterval = 300

    private static let askedKey = "dictation.asked"
    nonisolated private static let asideKey = "dictation.setAside"

    func changed() { onChange?() }

    /// The person got `id` on this Mac (Settings, a first dictation): the next claim asks the server to keep it.
    func asked(_ id: String) {
        let d = UserDefaults.standard
        d.set(Array(Set((d.stringArray(forKey: Self.askedKey) ?? []) + [id])).sorted(), forKey: Self.askedKey)
    }

    func finished(_ id: String, ok: Bool) {
        failed[id] = ok ? nil : Date()
        // reported as getting meanwhile, so the server does not ask again on every poll; then a claim asks it again
        if !ok { DispatchQueue.main.asyncAfter(deadline: .now() + Self.retry + 1) { SpeechModels.shared.changed() } }
        changed()
        startNext()
    }

    /// The models here, by catalog id (ModelRegistry ids are contracts/voice.ts STT_MODELS ids).
    static func held() -> [String] {
        ModelRegistry.shared.filter { $0.whisperKitID.flatMap { ModelFiles.base(holding: $0) } != nil }.map(\.id)
    }

    /// The claim's fields: what it has, what it is getting (downloading, waiting, or failed a little while ago, so the
    /// server does not ask again on every poll), and what its person got here since the last claim.
    func claim() -> [String: Any] {
        let held = Self.held()
        let getting = ([Dictation.shared.download?.id].compactMap { $0 } + queue + failed.keys.sorted()).filter { !held.contains($0) }
        return ["models": held, "getting": Array(NSOrderedSet(array: getting)) as? [String] ?? getting,
                "asked": UserDefaults.standard.stringArray(forKey: Self.askedKey) ?? []]
    }

    /// The server took the claim that carried `sent`: its asked ones are the server's now.
    func claimed(_ sent: [String: Any]) {
        let told = Set(sent["asked"] as? [String] ?? [])
        guard !told.isEmpty else { return }
        let d = UserDefaults.standard
        d.set((d.stringArray(forKey: Self.askedKey) ?? []).filter { !told.contains($0) }, forKey: Self.askedKey)
    }

    /// What the owner wants here: each model here that is not wanted goes (Remove), each wanted one that is missing is
    /// downloaded, one at a time. Ids this Mac doesn't run are left alone. True when something changed at once.
    func want(_ wanted: [String], now: Date = Date()) -> Bool {
        let plan = Self.plan(wanted: wanted, held: Self.held(), downloading: Dictation.shared.download?.id, queue: queue, failed: failed, now: now)
        plan.remove.forEach { Dictation.shared.remove($0) }
        let changed = !plan.remove.isEmpty || plan.queue != queue || plan.failed != failed
        queue = plan.queue
        failed = plan.failed
        startNext()
        return changed
    }

    /// What `want` does, as data. Pure, so it is tested: a model here that is not wanted goes (not one downloading); a
    /// wish no longer wanted leaves the queue and the failed list; a wanted one that is missing is queued, unless its
    /// download failed under `retry` ago. Ids this Mac doesn't run are left alone.
    /// ponytail: a download already running finishes even when its wish was cancelled; the next claim removes it.
    nonisolated static func plan(wanted: [String], held: [String], downloading: String?, queue: [String], failed: [String: Date], now: Date)
        -> (remove: [String], queue: [String], failed: [String: Date]) {
        let remove = held.filter { !wanted.contains($0) && $0 != downloading }
        var queue = queue.filter { wanted.contains($0) }
        var failed = failed.filter { wanted.contains($0.key) }
        for id in wanted where ModelRegistry.find(id) != nil && !held.contains(id) && !queue.contains(id) && id != downloading {
            if let at = failed[id], now.timeIntervalSince(at) < retry { continue }
            failed[id] = nil
            queue.append(id)
        }
        return (remove, queue, failed)
    }

    private func startNext() {
        while Dictation.shared.download == nil, !queue.isEmpty {
            let id = queue.removeFirst()
            if let m = ModelRegistry.find(id) { Dictation.shared.fetch(m, asked: false) }
        }
    }

    // MARK: the earlier app's folder: read, never changed

    nonisolated static func isSetAside(_ variant: String) -> Bool {
        UserDefaults.standard.stringArray(forKey: asideKey)?.contains(variant) == true
    }

    /// Stops using the earlier app's copy of `variant` (Remove), leaving its files where they are.
    nonisolated static func setAside(_ variant: String, earlier: URL = DictationPaths.earlier) {
        guard ModelFiles.isComplete(ModelFiles.folder(variant, in: earlier)), !isSetAside(variant) else { return }
        let d = UserDefaults.standard
        d.set((d.stringArray(forKey: asideKey) ?? []) + [variant], forKey: asideKey)
    }

    /// Download of a model set aside: the earlier app's copy is used again, with nothing fetched. True when it was.
    nonisolated static func restore(_ variant: String, earlier: URL = DictationPaths.earlier) -> Bool {
        guard isSetAside(variant) else { return false }
        let d = UserDefaults.standard
        d.set((d.stringArray(forKey: asideKey) ?? []).filter { $0 != variant }, forKey: asideKey)
        return ModelFiles.isComplete(ModelFiles.folder(variant, in: earlier))
    }

    // MARK: the relay's side (its own threads)

    /// What the relay is given (RelayRunner `speech`): the claim's fields and the server's wishes, on the main actor,
    /// and transcripts, on the relay's own thread.
    nonisolated static var link: SpeechLink {
        SpeechLink(
            claim: { DispatchQueue.main.sync { MainActor.assumeIsolated { SpeechModels.shared.claim() } } },
            answered: { sent, wanted in
                DispatchQueue.main.sync {
                    MainActor.assumeIsolated {
                        SpeechModels.shared.claimed(sent)
                        return SpeechModels.shared.want(wanted)
                    }
                }
            },
            transcribe: { model, languages, samples in try transcript(model: model, languages: languages, samples: samples) }
        )
    }

    /// A transcript with a model on this Mac (never downloaded for it: the server sends only models this Mac said it has).
    /// ponytail: no heartbeat of its own; the long poll keeps the Mac online, which needs a free slot (four AI requests
    /// at once could hold every one past 40 s, and the server takes the transcript back); beat like CardJob if that shows.
    /// ponytail: it loads its own copy of the model beside dictation's (twice the memory while both are in), so a
    /// dictation never waits behind an hour of transcript; share one pipeline if memory gets tight.
    nonisolated static func transcript(model id: String, languages: [String], samples: [Float]) throws -> (words: [HeardWord], language: String?) {
        guard let m = ModelRegistry.find(id), let variant = m.whisperKitID, ModelFiles.base(holding: variant) != nil else {
            throw TranscribeRefused(why: "This Mac does not have \(ModelRegistry.find(id)?.displayName ?? id).")
        }
        guard !samples.isEmpty else { return ([], nil) }
        let engine = WhisperKitTranscriber(model: m, tuning: .words)
        let done = DispatchSemaphore(value: 0)
        let answer = Heard()
        Task.detached {
            do { answer.result = .success(try await engine.words(samples, languages: languages)) } catch { answer.result = .failure(error) }
            await engine.unload()
            done.signal()
        }
        done.wait()
        return try answer.result!.get()
    }
}

private final class Heard: @unchecked Sendable {
    var result: Result<(words: [HeardWord], language: String?), Error>?
}
