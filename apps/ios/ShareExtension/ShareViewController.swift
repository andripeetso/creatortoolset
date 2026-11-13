import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// Share sheet → "Creator Toolset": first checks whether the link is one of the person's
/// own posts (then it is linked to its Workshop session), else asks why the link
/// is kept (Content, Format or Know-how), sends it to the Content Analyzer on the
/// server the app has in use and closes itself once the server has it.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.close = { [weak self] in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }
        let host = UIHostingController(rootView: ShareCard(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
        model.load(extensionContext?.inputItems as? [NSExtensionItem] ?? [])
    }
}

@MainActor
final class ShareModel: ObservableObject {
    enum Step: Equatable {
        case checking
        case choosing
        case sending
        /// One of your own posts: which Workshop session it is.
        case ownPost(ShareLink.OwnPost)
        case linking
        case saved(String)
        case failed(String)
        /// Your own post, already linked to this session.
        case linked(String)
        case notConnected

        /// The steps that still offer "Cancel" (the usual question and the own-post choice).
        var picking: Bool {
            switch self {
            case .checking, .choosing, .ownPost: true
            default: false
            }
        }
    }

    @Published var step = Step.choosing
    /// The website's projects (brands) and the one this share goes into. Instagram's
    /// share hands over only the link, so which account shared it can't be seen: the card starts on the project picked
    /// last time, or the one that owns the post when it's one of yours, and can be changed.
    @Published var projects: [ShareLink.Workspace.Project] = []
    @Published var projectId: String?
    private static let lastProject = "shareProjectId"
    var close: () -> Void = {}
    private var link: ShareLink?
    private var text: Task<String, Never>?

    /// Reads the shared items while the picker is up, and checks for your own post.
    func load(_ items: [NSExtensionItem]) {
        link = ShareLink.saved()
        if link == nil { step = .notConnected }
        text = Task { await Self.sharedText(items) }
        guard let link else { return }
        step = .checking
        Task { await checkOwnPost() }
        Task {
            guard let ws = try? await link.workspace() else { return }
            projects = ws.projects
            let last = UserDefaults.standard.string(forKey: Self.lastProject)
            if projectId == nil {
                projectId = ws.projects.contains { $0.id == last } ? last : ws.currentProjectId
            }
        }
    }

    /// Your own post (the server finds it from the link): linked already, or the
    /// sessions it could be. Anything else, or an error, is the usual question.
    private func checkOwnPost() async {
        let shared = await text?.value ?? ""
        if let link, !shared.isEmpty, let own = try? await link.ownPost(shared), own.own {
            if let id = own.projectId { projectId = id }
            step = own.linked.map { .linked($0.title) } ?? .ownPost(own)
        } else {
            step = .choosing
        }
    }

    /// Links one of the candidate sessions to the post; then the usual one-line close.
    func attach(_ candidate: ShareLink.OwnPost.Candidate, to post: ShareLink.OwnPost) async {
        guard let link, let url = post.url else { return }
        step = .linking
        do {
            let title = try await link.link(session: candidate.id, to: url)
            step = .saved("Linked to \(title) · Published")
            try? await Task.sleep(for: .seconds(1.2))
            close()
        } catch {
            step = .failed(error.localizedDescription)
        }
    }

    func send(_ keep: ShareLink.Keep) async {
        guard let link else {
            step = .notConnected
            return
        }
        step = .sending
        let text = await self.text?.value ?? ""
        guard !text.isEmpty else {
            step = .failed("There was no link in what you shared.")
            return
        }
        do {
            if let projectId { UserDefaults.standard.set(projectId, forKey: Self.lastProject) }
            step = .saved(try await link.share(text, keep: keep, projectId: projectId))
            try? await Task.sleep(for: .seconds(1.2))
            close()
        } catch let failure as ShareLink.Failure where failure.needsSignIn {
            step = .notConnected
        } catch {
            step = .failed(error.localizedDescription)
        }
    }

    /// Every shared URL and text, one per line; the server picks out the links.
    static func sharedText(_ items: [NSExtensionItem]) async -> String {
        var parts: [String] = []
        for provider in items.flatMap({ $0.attachments ?? [] }) {
            if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                parts.append(url.absoluteString)
            } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                      let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                parts.append(text)
            }
        }
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

struct ShareCard: View {
    @ObservedObject var model: ShareModel
    /// The app's AccentColor (the extension has no asset catalog of its own).
    private static let brand = Color(red: 0xE8 / 255, green: 0x5D / 255, blue: 0x75 / 255)

    var body: some View {
        VStack(spacing: 14) {
            Spacer()
            switch model.step {
            case .checking, .linking:
                ProgressView().controlSize(.large)
                Text(model.step == .checking ? "Checking the post…" : "Linking…").font(.headline)
            case .ownPost(let post):
                ownPost(post)
            case .linked(let title):
                Image(systemName: "checkmark.seal.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(.green)
                Text("Already linked to \(title)").font(.headline).multilineTextAlignment(.center)
            case .choosing:
                if model.projects.count > 1 { projectPicker }
                Text("Save to the Analyzer").font(.title3.bold())
                Text("Why are you keeping it?").font(.subheadline).foregroundStyle(.secondary)
                VStack(spacing: 10) {
                    ForEach(ShareLink.Keep.allCases, id: \.self) { keep in
                        KeepButton(keep: keep) { Task { await model.send(keep) } }
                    }
                }
                .padding(.top, 8)
            case .sending:
                ProgressView().controlSize(.large)
                Text("Saving to the Analyzer…").font(.headline)
            case .saved(let message):
                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(.green)
                Text(message).font(.headline).multilineTextAlignment(.center)
                Text(["Content Analyzer", project?.name].compactMap { $0 }.joined(separator: " · "))
                    .font(.subheadline).foregroundStyle(.secondary)
            case .failed(let message):
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.orange)
                Text("Couldn't save it").font(.headline)
                Text(message).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            case .notConnected:
                Image(systemName: "link.circle.fill")
                    .font(.system(size: 52))
                    .foregroundStyle(Self.brand)
                Text("Sign in first").font(.headline)
                Text("Open Creator Toolset and sign in to your computer, then share again.")
                    .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
            }
            Spacer()
            if model.step.picking {
                Button("Cancel") { model.close() }
                    .foregroundStyle(.secondary)
            } else if model.step != .sending && model.step != .linking {
                Button { model.close() } label: {
                    Text(isDone ? "Done" : "Close").bold().frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
            }
        }
        .padding(28)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
        .tint(Self.brand)
    }

    private var project: ShareLink.Workspace.Project? {
        model.projects.first { $0.id == model.projectId }
    }

    /// Which project the post goes into: tap to change.
    private var projectPicker: some View {
        Menu {
            ForEach(model.projects) { p in
                Button {
                    model.projectId = p.id
                } label: {
                    if p.id == model.projectId { Label(p.name, systemImage: "checkmark") } else { Text(p.name) }
                }
            }
        } label: {
            HStack(spacing: 8) {
                Circle().fill(Self.color(project?.color)).frame(width: 10, height: 10)
                Text(project?.name ?? "Pick a project").font(.headline).foregroundStyle(.primary)
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(Capsule().fill(Color(.secondarySystemBackground)))
        }
        .padding(.bottom, 6)
    }

    /// The website's project colours (PROJECT_COLORS in the web app, Tailwind 500s).
    static func color(_ key: String?) -> Color {
        let hex: [String: UInt32] = [
            "violet": 0x8B5CF6, "sky": 0x0EA5E9, "emerald": 0x10B981, "amber": 0xF59E0B,
            "rose": 0xF43F5E, "orange": 0xF97316, "teal": 0x14B8A6, "pink": 0xEC4899,
            "blue": 0x3B82F6, "indigo": 0x6366F1, "fuchsia": 0xD946EF, "red": 0xEF4444,
            "lime": 0x84CC16, "cyan": 0x06B6D4, "yellow": 0xEAB308, "slate": 0x64748B,
        ]
        let v = hex[key ?? ""] ?? 0x8B5CF6
        return Color(red: Double(v >> 16 & 0xFF) / 255, green: Double(v >> 8 & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
    }

    private var isDone: Bool {
        switch model.step {
        case .saved, .linked: true
        default: false
        }
    }

    /// "Your post on @handle", its first caption line, and the sessions it could be.
    private func ownPost(_ post: ShareLink.OwnPost) -> some View {
        VStack(spacing: 12) {
            Text(post.handle.map { "Your post on \($0.hasPrefix("@") ? $0 : "@" + $0)" } ?? "Your post")
                .font(.title3.bold())
                .multilineTextAlignment(.center)
            if let line = post.caption?.split(whereSeparator: \.isNewline).first {
                Text(String(line)).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Text("Which session is it?").font(.subheadline).foregroundStyle(.secondary).padding(.top, 4)
            let candidates = post.candidates ?? []
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(candidates, id: \.id) { candidate in
                        Button {
                            Task { await model.attach(candidate, to: post) }
                        } label: {
                            HStack {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(candidate.title).font(.headline).lineLimit(1)
                                    Text(ShareLink.statusLabel(candidate.status)).font(.caption).opacity(0.8)
                                }
                                Spacer()
                                Image(systemName: "chevron.right").font(.caption).opacity(0.6)
                            }
                            .padding(12)
                            .frame(maxWidth: .infinity)
                            .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                    }
                    if candidates.isEmpty {
                        Text("No open session matches it.").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            }
            Button("Save as research instead") { model.step = .choosing }
                .buttonStyle(.bordered)
        }
    }
}

/// One "Kept for" choice: Content is the usual one, so it stands out.
private struct KeepButton: View {
    let keep: ShareLink.Keep
    let action: () -> Void

    var body: some View {
        let label = VStack(spacing: 2) {
            Text(keep.label).font(.headline)
            Text(keep.hint).font(.caption).opacity(0.8)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        if keep == .content {
            Button(action: action) { label }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
        } else {
            Button(action: action) { label }
                .buttonStyle(.bordered)
                .controlSize(.large)
        }
    }
}
