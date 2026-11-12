import SwiftUI

/// The one look for "is this in the library?", on every thumbnail: green check = in the library, a ring = uploading,
/// red ! = needs a look, orange clock = waiting to start. A clip not in the library and not on its way has none.
struct StatusBadge: View {
    enum Kind: Equatable {
        case none
        case waiting
        /// 0…1
        case uploading(Double)
        case uploaded
        case failed
    }

    let kind: Kind

    var body: some View {
        switch kind {
        case .none:
            EmptyView()
        case .waiting:
            // one shape: the clock is orange and its hands show the white behind
            symbol("clock.fill", .orange, mark: .orange)
        case .uploading(let share):
            ZStack {
                Circle().fill(.black.opacity(0.55))
                Circle().stroke(.white.opacity(0.3), lineWidth: 3)
                Circle().trim(from: 0, to: max(0.04, share))
                    .stroke(.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
                Image(systemName: "arrow.up").font(.system(size: 10, weight: .heavy)).foregroundStyle(.white)
            }
            .frame(width: 24, height: 24)
        case .uploaded:
            symbol("checkmark.circle.fill", .green)
        case .failed:
            symbol("exclamationmark.circle.fill", .red)
        }
    }

    private func symbol(_ name: String, _ color: Color, mark: Color = .white) -> some View {
        Image(systemName: name)
            .font(.system(size: 22, weight: .semibold))
            .foregroundStyle(mark, color)
            .background(Circle().fill(.white).padding(3))
            .shadow(color: .black.opacity(0.4), radius: 2)
    }

    static func kind(for item: UploadItem, sent: Int64) -> Kind {
        switch item.state {
        case .picked, .preparing: .waiting
        case .sending: .uploading(item.size > 0 ? min(1, Double(sent) / Double(item.size)) : 0)
        case .finishing, .confirming: .uploading(1)
        case .done: .uploaded
        case .failed: .failed
        }
    }

    /// A camera-roll clip: its upload's state when this phone sent it, the check when the library has it from
    /// anywhere, nothing otherwise.
    static func kind(for item: UploadItem?, sent: Int64, inLibrary: Bool) -> Kind {
        if let item { return kind(for: item, sent: sent) }
        return inLibrary ? .uploaded : .none
    }
}

/// The ring of a clip on its way. It follows the bytes itself, so a tick redraws this ring and not the roll around it.
struct LiveRing: View {
    let key: String
    /// What the roll worked out, drawn when this phone's uploads don't hold the clip (a debug build's made-up uploads).
    let drawn: StatusBadge.Kind
    @EnvironmentObject private var store: UploadStore

    var body: some View {
        StatusBadge(kind: store.byAsset[key].map { StatusBadge.kind(for: $0, sent: store.sentBytes($0)) } ?? drawn)
    }
}
