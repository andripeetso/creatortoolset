import SwiftUI

/// Make: the workspace's edits and Review videos (Edits) or its Media Library (Media), one control on top that stays
/// where it is whichever side shows.
struct MakeView: View {
    @ObservedObject private var nav = AppNavigator.shared
    @ObservedObject private var access = ToolsetAccess.shared

    var body: some View {
        Group {
            switch nav.makeSide {
            case .edits:
                if access.me != nil, !access.uses(.make) {
                    TabNote(text: "Edits are made by the workspace's owner", systemImage: "film.stack")
                } else {
                    ChatsView(edits: true)
                }
            case .media:
                MediaView()
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            Picker("Show", selection: $nav.makeSide) {
                ForEach(MakeSide.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
            .background(.bar)
        }
        .navigationTitle("Make")
        // inline: the control under it stays put, and the title shows over both sides
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// Make's Media side: the workspace's Media Library (the header names the workspace), searched, and Upload, which opens
/// the camera roll to pick clips from.
struct MediaView: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var access = ToolsetAccess.shared
    @State private var query = ""
    @State private var uploading = debugArg("MakeUpload") != nil

    var body: some View {
        Group {
            if !access.allows("media") {
                TabNote(text: "The Media Library is off for this account", systemImage: "photo.on.rectangle")
            } else if servers.api == nil {
                SignInAgainButton {}.padding(.horizontal, 24).frame(maxHeight: .infinity)
            } else {
                LibraryBrowse(segment: .constant(.library))
            }
        }
        .environment(\.libraryQuery, query)
        .environment(\.hidesUploadSegments, true)
        // the website's own line for its Media Library page; a plug-in's catalog keeps its own
        .searchable(text: $query, prompt: LibraryBrowse.catalog(ServerPlugins.shared, access) ? "Search footage" : "Search clips and transcripts")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Upload") { uploading = true }
            }
        }
        .navigationDestination(isPresented: $uploading) {
            UploadView().environment(\.hidesUploadSegments, true)
        }
    }
}

/// Distribute: what is ready to post and every final, as one screen (`FinalsView`).
struct DistributeView: View {
    @ObservedObject private var access = ToolsetAccess.shared

    var body: some View {
        Group {
            if access.me != nil, !access.uses(.distribute) {
                TabNote(text: "Finals are off for this account", systemImage: "paperplane").navigationTitle("Distribute")
            } else {
                FinalsView()
            }
        }
        .workspaceSwitcher()
    }
}
