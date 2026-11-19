import SwiftUI

/// Projects: every Workshop project of the workspace, grouped as the computer's Content Workshop lists them (Ideas &
/// writing, Ready & in production, Published, then Shelved folded), with a type filter and search. A project opens its
/// page; the edits and Review videos of no project are last, under Other edits.
struct ProjectsView: View {
    @ObservedObject private var model = WorkshopModel.shared
    @ObservedObject private var chats = ChatsModel.shared
    @ObservedObject private var access = ToolsetAccess.shared
    @AppStorage("projects.shelved.open") private var shelvedOpen = false
    /// The type filter: "" All, else a kind ("reel", "carousel").
    @AppStorage("projects.kind") private var kind = ""
    @State private var query = ""
    /// `-newEdit YES` opens New edit at launch (simulator screenshots).
    @State private var newEdit = UserDefaults.standard.bool(forKey: "newEdit")
    @State private var askDismissAll = false
    @State private var deleting: ChatRow?
    @State private var stopped: ChatRow?

    static let kinds = [("All", ""), ("Reel", "reel"), ("Carousel", "carousel")]

    var body: some View {
        if access.me != nil, !access.uses(.projects) {
            TabNote(text: "Projects are off for this account", systemImage: "folder").navigationTitle("Projects")
        } else {
            list
        }
    }

    private var list: some View {
        let words = query.trimmingCharacters(in: .whitespaces).lowercased()
        let edits = chats.rows.filter { !$0.route.isAssistant }
        let sessions = model.sessions.filter { $0.shows(kind: kind.isEmpty ? nil : kind, words: words) }
        let others = ChatList.others(edits, sessions: model.sessions).filter { words.isEmpty || $0.title.lowercased().contains(words) }
        let reviews = edits.filter { $0.shelf == .active && $0.status == .review }
        return List {
            header
            if !model.sessions.isEmpty {
                Picker("Type", selection: $kind) {
                    ForEach(Self.kinds, id: \.1) { Text($0.0).tag($0.1) }
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)
            }
            ForEach(WorkshopSession.grouped(sessions), id: \.group) { part in
                if part.group == .shelved {
                    ShelfHeader(title: part.group.title, count: part.sessions.count, open: $shelvedOpen)
                    if shelvedOpen || !words.isEmpty { ForEach(part.sessions) { card($0, edits: edits) } }
                } else {
                    Section {
                        ForEach(part.sessions) { card($0, edits: edits) }
                    } header: {
                        Text("\(part.group.title) (\(part.sessions.count))").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
            }
            if !others.isEmpty {
                Section {
                    EditRows(rows: others, searching: !words.isEmpty, deleting: $deleting, stopped: $stopped)
                } header: {
                    Text("Other edits").font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
                }
            }
        }
        .listStyle(.plain)
        .overlay {
            if model.loading && model.sessions.isEmpty {
                ProgressView()
            } else if sessions.isEmpty, others.isEmpty, model.error == nil, !model.needsSignIn {
                Text(words.isEmpty && kind.isEmpty ? "No projects yet" : "No match").foregroundStyle(.secondary)
            }
        }
        .navigationTitle("Projects")
        .searchable(text: $query, prompt: "Search")
        .toolbar {
            if access.allows("editor") {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("New edit") { newEdit = true }
                }
            }
            // everything that waits for his review, in one go
            if reviews.count > 1 {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Dismiss all \(reviews.count) reviews", systemImage: "checkmark") { askDismissAll = true }
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .confirmationDialog("Dismiss all \(reviews.count) reviews?", isPresented: $askDismissAll, titleVisibility: .visible) {
                        Button("Dismiss all") { Task { await chats.dismiss(reviews) } }
                    }
                }
            }
        }
        .editDialogs(deleting: $deleting, stopped: $stopped)
        .sheet(isPresented: $newEdit) { NewEditView() }
        .task { if access.allows("workshop") { await model.load() } }
        .refreshable {
            async let edits: Void = chats.load()
            if access.allows("workshop") { await model.load(force: true) }
            await edits
        }
    }

    /// What is off, when something is.
    @ViewBuilder private var header: some View {
        if model.needsSignIn {
            SignInAgainButton { await model.load(force: true) }.listRowSeparator(.hidden)
        } else if let error = model.error {
            Problem(text: error).listRowSeparator(.hidden)
        }
        if let notice = chats.notice { QuietNotice(text: notice).listRowSeparator(.hidden) }
        if chats.couldNotRead > 0 { QuietNotice(text: "Some things could not be read. Update the app.").listRowSeparator(.hidden) }
    }

    /// A project's card, with the badge of its edit that waits on the person, when one does.
    private func card(_ session: WorkshopSession, edits: [ChatRow]) -> some View {
        let waits = edits.first { $0.status.waitsOnYou && ChatList.belongs($0, to: session) }?.status
        return Button { AppNavigator.shared.open(.session(session.id)) } label: { ProjectCard(session: session, waits: waits) }
            .buttonStyle(.plain)
            .listRowInsets(EdgeInsets(top: 5, leading: 16, bottom: 5, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }
}

/// A project as a card: its kind letter, its title, its kind, its stage and when it was last worked on; the badge of
/// an edit of it that waits on the person.
struct ProjectCard: View {
    let session: WorkshopSession
    var waits: RowStatus?

    var body: some View {
        HStack(spacing: 12) {
            Text(session.letter)
                .font(.headline.monospaced())
                .frame(width: 40, height: 40)
                .background(Color("AccentColor").opacity(0.22), in: RoundedRectangle(cornerRadius: 10))
            VStack(alignment: .leading, spacing: 3) {
                Text(session.title).font(.body.weight(.semibold)).lineLimit(2)
                let line = [session.kindLabel, session.status == .unknown ? nil : session.status.label,
                            session.updatedAt.map { shortAgo(Date(timeIntervalSince1970: $0 / 1000)) }]
                    .compactMap { $0 }.joined(separator: " · ")
                if !line.isEmpty { Text(line).font(.footnote).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 8)
            if let waits {
                RowBadge(status: waits)
            } else if session.toFilm {
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

/// A project's page: its script (read big, and filmed with it on screen), its edits and Review videos, and its finals.
struct ProjectView: View {
    let session: WorkshopSession
    @ObservedObject private var chats = ChatsModel.shared
    @ObservedObject private var workshop = WorkshopModel.shared
    @ObservedObject private var plugins = ServerPlugins.shared
    @ObservedObject private var access = ToolsetAccess.shared
    @StateObject private var finals = FinalsModel()
    @State private var deleting: ChatRow?
    @State private var stopped: ChatRow?

    private var studio: Bool { FinalsModel.usesStudio(plugins, access) }

    var body: some View {
        let edits = chats.rows.filter { ChatList.belongs($0, to: session) }
        let all = finals.data?.stacks ?? []
        let made = FinalsSessions(pieces: all, sessions: workshop.sessions, links: finals.links, edits: finals.edits)
        let pieces = all.filter { made.session(of: $0)?.id == session.id }
        List {
            Section {
                NavigationLink { ScriptReaderView(session: session) } label: {
                    Label("Script", systemImage: "doc.text")
                }
            } header: {
                Text([session.kindLabel, session.status == .unknown ? nil : session.status.label].compactMap { $0 }.joined(separator: " · "))
            }
            if !edits.isEmpty {
                Section("Edits") {
                    EditRows(rows: edits, deleting: $deleting, stopped: $stopped)
                }
            }
            if !pieces.isEmpty {
                Section("Finals") {
                    // fixed widths in a row: a grid that sizes itself inside a list row never settles
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(alignment: .top, spacing: 8) {
                            ForEach(pieces) { piece in
                                NavigationLink {
                                    FinalDetailView(piece: piece, link: finals.links.link(of: piece.id), made: session,
                                                    sure: made.sure(of: piece), api: finals.api)
                                } label: {
                                    FinalCell(piece: piece, api: finals.api).frame(width: 120)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                    .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
                    .listRowSeparator(.hidden)
                }
            }
        }
        // plain, as on Projects: the edits' cards stand out from it
        .listStyle(.plain)
        .navigationTitle(session.title)
        .navigationBarTitleDisplayMode(.inline)
        .editDialogs(deleting: $deleting, stopped: $stopped)
        .task(id: studio) { if access.allows("finals") { await finals.load(studio: studio) } }
        .refreshable {
            async let edits: Void = chats.load()
            if access.allows("finals") { await finals.load(studio: studio, force: true) }
            await edits
        }
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
