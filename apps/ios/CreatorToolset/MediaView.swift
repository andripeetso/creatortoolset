import SwiftUI

/// Media: the workspace's Media Library, searched, with this phone's uploads on top (what is on its way and what
/// failed; a tap opens Activity) and Upload, which opens the camera roll to pick clips from.
struct MediaView: View {
    @EnvironmentObject private var servers: Servers
    @ObservedObject private var access = ToolsetAccess.shared
    @State private var query = ""
    @State private var uploading = debugArg("MakeUpload") != nil
    @State private var activity = false

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
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) { UploadStrip(since: nil) { activity = true } }
                .padding(.horizontal, 16)
                // only as tall as the strip: an empty one draws nothing
                .background(.bar, ignoresSafeAreaEdges: [])
        }
        .environment(\.libraryQuery, query)
        .environment(\.hidesUploadSegments, true)
        // the website's own line for its Media Library page; a plug-in's catalog keeps its own
        .searchable(text: $query, prompt: LibraryBrowse.catalog(ServerPlugins.shared, access) ? "Search footage" : "Search clips and transcripts")
        .navigationTitle("Media")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Upload") { uploading = true }
            }
        }
        .workspaceSwitcher()
        .sheet(isPresented: $activity) { ActivityView() }
        .navigationDestination(isPresented: $uploading) { UploadMediaView() }
    }
}

/// Upload media: the camera roll, picked clips going to the workspace's Media Library. Media's Upload button and the
/// first row of Tools open it.
struct UploadMediaView: View {
    var body: some View {
        UploadView().environment(\.hidesUploadSegments, true)
    }
}

/// Publish: what is ready to post and every final, as one screen (`FinalsView`).
struct PublishView: View {
    @ObservedObject private var access = ToolsetAccess.shared

    var body: some View {
        Group {
            if access.me != nil, !access.uses(.publish) {
                TabNote(text: "Finals are off for this account", systemImage: "paperplane").navigationTitle("Publish")
            } else {
                FinalsView()
            }
        }
        .workspaceSwitcher()
    }
}
