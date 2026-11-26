import SwiftUI

/// Upload details: what needs a look (and why), what is on its way, and what finished lately.
struct ActivityView: View {
    @EnvironmentObject private var store: UploadStore
    @EnvironmentObject private var engine: UploadEngine
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var intake = IntakeWatch.shared
    @Environment(\.dismiss) private var dismiss
    @State private var signingIn = false
    /// A clip on its way asked to be removed: asked before it is stopped.
    @State private var stopping: UploadItem?

    var body: some View {
        let items = UploadFakes.items(over: PhotoLibrary.shared.assets, server: servers.currentId)
            ?? UploadSums.tab(store.items, server: servers.currentId)
        NavigationStack {
            List {
                if servers.signedOut {
                    HStack {
                        Label("Signed out", systemImage: "person.crop.circle.badge.exclamationmark").foregroundStyle(.orange)
                        Spacer()
                        Button("Sign in") { signingIn = true }.buttonStyle(.borderedProminent)
                    }
                }
                let failed = items.filter { $0.state == .failed }
                if !failed.isEmpty {
                    Section("Needs a look") { ForEach(failed) { row($0) } }
                }
                let working = items.filter { $0.isWorking || $0.state == .picked }
                if !working.isEmpty {
                    Section {
                        ForEach(working) { row($0) }
                    } header: {
                        Text("Uploading")
                    } footer: {
                        Text("Keeps going with the phone locked or the app closed.")
                    }
                }
                let recent = items.filter(\.isFinished)
                    .sorted { ($0.finishedAt ?? .distantPast) > ($1.finishedAt ?? .distantPast) }
                    .prefix(30)
                if !recent.isEmpty {
                    Section("Recently uploaded") { ForEach(Array(recent)) { row($0) } }
                }
                if failed.isEmpty && working.isEmpty && recent.isEmpty {
                    Text("Nothing uploading").foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Activity")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
            .refreshable { await engine.reconcile() }
            // the files the server holds for their blur: how far each is, read from the library's intake
            .task(id: items.compactMap(\.intake)) {
                for (library, held) in Dictionary(grouping: items.filter { $0.intake != nil }, by: { $0.intake!.library }) {
                    intake.watch(held.map { $0.intake!.asset }, library: library, api: engine.api(for: held[0]))
                }
            }
            .confirmationDialog("Stop this upload?", isPresented: Binding(get: { stopping != nil }, set: { if !$0 { stopping = nil } }),
                                titleVisibility: .visible, presenting: stopping) { item in
                Button("Stop and remove", role: .destructive) { engine.remove(item.id) }
            }
            .sheet(isPresented: $signingIn, onDismiss: { engine.kick() }) { SignInAgainView() }
        }
    }

    private func row(_ item: UploadItem) -> some View {
        HStack(spacing: 12) {
            Group {
                if let asset = item.assetId {
                    AssetThumbnail(assetId: asset, side: 56)
                } else {
                    Image(systemName: "doc").font(.title2).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Color(.secondarySystemBackground))
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .overlay(alignment: .topTrailing) {
                StatusBadge(kind: StatusBadge.kind(for: item, sent: store.sentBytes(item))).scaleEffect(0.75).offset(x: 6, y: -6)
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text(item.filename).font(.subheadline.bold()).lineLimit(1)
                    Spacer()
                    if item.size > 0 {
                        Text(ByteCountFormatter.string(fromByteCount: item.size, countStyle: .file)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                let step = item.intake.flatMap { intake.steps[$0.asset] }
                Text(Self.status(item, sent: store.sentBytes(item), intake: step)).font(.caption)
                    .foregroundStyle(step?.isFailed == true ? .red : step?.line != nil ? .secondary : color(item))
                if item.state == .sending && item.size > 0 {
                    ProgressView(value: Double(min(store.sentBytes(item), item.size)), total: Double(item.size))
                }
                if item.state == .failed {
                    Button("Try again", systemImage: "arrow.clockwise") { engine.retry(item.id) }
                        .buttonStyle(.bordered)
                        .padding(.top, 2)
                }
                if let step, step.isFailed, let held = item.intake, let api = engine.api(for: item) {
                    Button("Retry", systemImage: "arrow.clockwise") {
                        Task { try? await Intake.retry(part: step.failed, library: held.library, asset: held.asset, version: step.versionId, api: api) }
                    }
                    .buttonStyle(.bordered)
                    .padding(.top, 2)
                }
            }
        }
        .swipeActions {
            if item.isWorking {
                // no destructive role: the row stays until the question is answered
                Button("Remove") { stopping = item }.tint(.red)
            } else {
                Button("Remove", role: .destructive) { engine.remove(item.id) }
            }
        }
    }

    /// `intake`: how far a file the server holds for its blur is (the library's intake); its line until it is ready.
    static func status(_ item: UploadItem, sent: Int64, now: Date = Date(), intake: Intake? = nil) -> String {
        switch item.state {
        case .picked:
            return "Not sent yet"
        case .preparing:
            return waiting(item, now: now) ?? item.note ?? "Starting…"
        case .sending:
            if let waiting = waiting(item, now: now) { return waiting }
            if item.size > 0 && sent >= item.size { return "Finishing…" }
            let share = item.size > 0 ? Int(100 * Double(sent) / Double(item.size)) : 0
            return "Uploading · \(share)%" + (item.note.map { " · \($0)" } ?? "")
        case .finishing:
            return waiting(item, now: now) ?? "Finishing…"
        case .confirming:
            return "Sent · the library is fetching it"
        case .done:
            return intake?.line ?? (item.duplicate ? "Already in the library" : "Uploaded")
        case .failed:
            return "Couldn't upload: \(item.note ?? "unknown error")"
        }
    }

    /// "Connection dropped · trying again in 40 s"
    private static func waiting(_ item: UploadItem, now: Date) -> String? {
        guard let next = item.nextAttemptAt, next > now else { return nil }
        let seconds = Int(next.timeIntervalSince(now).rounded(.up))
        return "\(item.note ?? "Waiting") · trying again in \(seconds >= 60 ? "\(seconds / 60) min" : "\(seconds) s")"
    }

    private func color(_ item: UploadItem) -> Color {
        switch item.state {
        case .done: .green
        case .failed: .red
        case .picked: .orange
        default: item.nextAttemptAt.map { $0 > Date() } == true ? .orange : .secondary
        }
    }
}
