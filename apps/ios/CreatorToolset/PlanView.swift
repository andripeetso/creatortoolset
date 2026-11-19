import SwiftUI

/// Plan: the workspace's ideas and scripts as cards, by stage, the one closest to filming first (Ready, Writing, Idea),
/// Shelved folded at the bottom. A card opens the script reader, where Record (the prompter) is the big button.
struct PlanView: View {
    @ObservedObject private var model = WorkshopModel.shared
    @ObservedObject private var access = ToolsetAccess.shared
    @AppStorage("plan.shelved.open") private var shelvedOpen = false
    @State private var query = ""

    /// The stages Plan holds, in the order they are listed.
    static let stages: [WorkshopStatus] = [.ready, .writing, .draft]

    var body: some View {
        if access.me != nil, !access.uses(.plan) {
            TabNote(text: "The Workshop is off for this account", systemImage: "lightbulb").navigationTitle("Plan")
        } else {
            list
        }
    }

    private var list: some View {
        let words = query.trimmingCharacters(in: .whitespaces).lowercased()
        let sessions = Self.cards(model.sessions).filter { words.isEmpty || $0.title.lowercased().contains(words) }
        let shelved = sessions.filter { $0.status == .shelved }
        return List {
            if model.needsSignIn {
                SignInAgainButton { await model.load(force: true) }.listRowSeparator(.hidden)
            } else if let error = model.error {
                Problem(text: error).listRowSeparator(.hidden)
            }
            ForEach(Self.stages, id: \.self) { stage in
                let cards = sessions.filter { $0.status == stage }
                if !cards.isEmpty {
                    Section {
                        ForEach(cards, content: card)
                    } header: {
                        Text(stage.label).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
            }
            if !shelved.isEmpty {
                ShelfHeader(title: "Shelved", count: shelved.count, open: $shelvedOpen)
                if shelvedOpen || !words.isEmpty { ForEach(shelved, content: card) }
            }
        }
        .listStyle(.plain)
        .overlay {
            if model.loading && model.sessions.isEmpty {
                ProgressView()
            } else if sessions.isEmpty, model.error == nil, !model.needsSignIn {
                Text(words.isEmpty ? "No ideas yet" : "No match").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Plan")
        .searchable(text: $query, prompt: "Search")
        .task { await model.load() }
        .refreshable { await model.load(force: true) }
    }

    /// Plan's pieces, newest first.
    static func cards(_ sessions: [WorkshopSession]) -> [WorkshopSession] {
        sessions.filter { $0.status.tab == .plan && $0.status != .unknown }.sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
    }

    private func card(_ session: WorkshopSession) -> some View {
        Button { AppNavigator.shared.open(.session(session.id)) } label: { PlanCard(session: session) }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

/// An idea or a script as a card: its kind letter, its title, its kind and when it was last worked on.
struct PlanCard: View {
    let session: WorkshopSession

    var body: some View {
        HStack(spacing: 12) {
            Text(session.letter)
                .font(.headline.monospaced())
                .frame(width: 40, height: 40)
                .background(Color("AccentColor").opacity(0.22), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title).font(.body.weight(.semibold)).lineLimit(2)
                let line = [session.kindLabel, session.updatedAt.map { shortAgo(Date(timeIntervalSince1970: $0 / 1000)) }]
                    .compactMap { $0 }.joined(separator: " · ")
                if !line.isEmpty { Text(line).font(.footnote).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 8)
            if session.toFilm {
                Image(systemName: "record.circle").foregroundStyle(.red).accessibilityLabel("Ready to film")
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
        .contentShape(RoundedRectangle(cornerRadius: 18))
        .opacity(session.status == .shelved ? 0.6 : 1)
    }
}

/// Why a tab is empty, in one line: the account can't use what it holds.
struct TabNote: View {
    let text: String
    let systemImage: String

    var body: some View {
        ContentUnavailableView(text, systemImage: systemImage)
    }
}
