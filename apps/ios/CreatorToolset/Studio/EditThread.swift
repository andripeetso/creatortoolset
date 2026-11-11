import SwiftUI

/// An AI Editor edit's own thread. Until it is built: the edit's page, signed in.
struct EditThreadView: View {
    let id: String

    init(id: String) { self.id = id }

    var body: some View { PageView(path: "/editor/\(id)") }
}
