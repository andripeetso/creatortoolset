import SwiftUI

/// A page of the server's web app the phone has no screen of its own for, signed in as the person. Rare: an
/// assistant card that leads to a scheduled task, say.
struct PageView: View {
    let path: String

    var body: some View {
        if let api = API.current {
            WebAppView(api: api, path: path)
                .ignoresSafeArea(edges: .bottom)
                .navigationBarTitleDisplayMode(.inline)
        } else {
            ContentUnavailableView("Sign in first", systemImage: "person.crop.circle")
        }
    }
}
