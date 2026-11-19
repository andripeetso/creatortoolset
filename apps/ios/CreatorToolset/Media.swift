import AVKit
import SwiftUI
import VisionKit
import WebKit

/// A picture from the server (a thumbnail, a cover), loaded with the sign-in cookie and kept in memory.
struct RemoteImage: View {
    let path: String
    @EnvironmentObject private var servers: Servers
    @State private var image: UIImage?

    private static let cache = NSCache<NSString, UIImage>()

    var body: some View {
        ZStack {
            Color.secondary.opacity(0.15)
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            }
        }
        .clipped()
        .task(id: path) { await load() }
    }

    private func load() async {
        guard let api = servers.api else { return }
        let key = "\(api.cacheKey)\(path)" as NSString
        if let hit = Self.cache.object(forKey: key) { return image = hit }
        guard let data = try? await api.data(api.request(path)), let loaded = UIImage(data: data) else { return }
        Self.cache.setObject(loaded, forKey: key)
        image = loaded
    }
}

extension API {
    /// A player for a media path. The cookie is scoped to the server's host, so a redirect to a bucket never gets it.
    /// A DPoP session's player carries a media ticket in a cookie (`TicketPlayer`).
    func player(_ path: String) -> AVPlayer {
        needsTicket ? TicketPlayer(api: self, path: path) : AVPlayer(playerItem: AVPlayerItem(asset: playerAsset(path)))
    }

    /// The asset for a media path: its URL as it is, never a credential in it (URLs end up in access logs).
    func playerAsset(_ path: String, ticket: String? = nil) -> AVURLAsset {
        AVURLAsset(url: url(path), options: playerOptions(ticket: ticket))
    }

    /// The player's range requests: the cookie (or a DPoP session's media ticket as a cookie), and the workspace as a
    /// header (a header option is not scoped to the host, so neither cookie ever rides in it).
    func playerOptions(ticket: String? = nil) -> [String: Any] {
        var cookies: [HTTPCookie] = []
        if let cookie, let host = server.host(),
           let c = HTTPCookie(properties: [.name: "cap_auth", .value: cookie, .domain: host, .path: "/"]) {
            cookies.append(c)
        }
        if let ticket, let c = MediaTicket.cookie(ticket, for: server) { cookies.append(c) }
        var options: [String: Any] = [AVURLAssetHTTPCookiesKey: cookies]
        var fields: [String: String] = [:]
        // a paired route's bearer token; a DPoP session's proof is good for one request, so its players carry a ticket
        if cookie == nil, let credential, credential.kind == .bearer { fields = credential.headers(method: "GET", url: server) }
        if let workspace { fields[WorkspacePick.header] = workspace }
        if !fields.isEmpty { options["AVURLAssetHTTPHeaderFieldsKey"] = fields }
        return options
    }
}

/// A DPoP session's player: its item comes once its media ticket is in, a moment later, playing if `play()` was already
/// asked. A ticket lives 5 minutes, so an item that played and then fails (its range request got a 401) is loaded
/// again with a new ticket from where it was. One that fails before it ever played stays failed (no loop).
final class TicketPlayer: AVPlayer {
    private let api: API
    private let path: String
    private var watch: NSKeyValueObservation?
    /// The current item got to play once.
    private var played = false

    init(api: API, path: String) {
        self.api = api
        self.path = path
        super.init()
        load(at: .zero, playing: false)
    }

    private func load(at time: CMTime, playing: Bool) {
        Task { @MainActor [weak self] in
            guard let self,
                  let ticket = try? await api.mediaTicket(api.url(path).path(percentEncoded: false)) else { return }
            let item = AVPlayerItem(asset: api.playerAsset(path, ticket: ticket))
            watch = item.observe(\.status) { [weak self] item, _ in
                DispatchQueue.main.async {
                    guard let self, item === self.currentItem else { return }
                    if item.status == .readyToPlay { self.played = true }
                    if item.status == .failed, self.played {
                        self.load(at: item.currentTime(), playing: self.rate != 0 || self.timeControlStatus != .paused)
                    }
                }
            }
            played = false
            replaceCurrentItem(with: item)
            if time != .zero { await seek(to: time, toleranceBefore: .zero, toleranceAfter: .zero) }
            if playing { play() }
        }
    }
}

/// The iPhone's own player (the one Photos uses): scrubbing, ±10 s, speed, full screen, Picture in Picture, AirPlay,
/// sound with the ring switch on silent. Its controls stay hidden until a tap, so a big play button shows until it
/// first plays. `overlay` rides on the video, full screen too (captions drawn over a video); it never takes touches.
struct NativePlayer<Overlay: View>: View {
    let player: AVPlayer
    let overlay: Overlay
    @State private var started = false

    init(player: AVPlayer, @ViewBuilder overlay: () -> Overlay) {
        self.player = player
        self.overlay = overlay()
    }

    var body: some View {
        PlayerController(player: player, overlay: overlay)
            .overlay {
                if !started {
                    Button { player.play() } label: {
                        Image(systemName: "play.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(.white)
                            .frame(width: 68, height: 68)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("Play")
                }
            }
            .onReceive(player.publisher(for: \.timeControlStatus)) { status in
                if status != .paused { started = true }
            }
            .id(ObjectIdentifier(player))   // another video starts with its button again
    }
}

extension NativePlayer where Overlay == EmptyView {
    init(player: AVPlayer) { self.init(player: player) { EmptyView() } }
}

private struct PlayerController<Overlay: View>: UIViewControllerRepresentable {
    let player: AVPlayer
    let overlay: Overlay

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        // playback, not the default ambient: the silent switch mutes ambient sound
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        let controller = AVPlayerViewController()
        controller.player = player
        controller.videoGravity = .resizeAspect
        controller.allowsPictureInPicturePlayback = true
        controller.canStartPictureInPictureAutomaticallyFromInline = true
        controller.entersFullScreenWhenPlaybackBegins = false
        controller.exitsFullScreenWhenPlaybackEnds = true
        if Overlay.self != EmptyView.self, let content = controller.contentOverlayView {
            let host = UIHostingController(rootView: overlay)
            host.safeAreaRegions = []
            host.view.backgroundColor = .clear
            host.view.isUserInteractionEnabled = false
            host.view.frame = content.bounds
            host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            content.addSubview(host.view)
            context.coordinator.host = host
        }
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
        context.coordinator.host?.rootView = overlay
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var host: UIHostingController<Overlay>?
    }
}

extension API {
    /// The sign-in cookie for the web view. Secure only on https: the `.secure` key makes a cookie secure whatever
    /// its value, and a secure cookie is never sent to an http server (the one on the person's own computer).
    var webCookie: HTTPCookie? {
        guard let cookie, let host = server.host() else { return nil }
        var properties: [HTTPCookiePropertyKey: Any] = [.name: "cap_auth", .value: cookie, .domain: host, .path: "/"]
        if server.scheme == "https" { properties[.secure] = "TRUE" }
        return HTTPCookie(properties: properties)
    }
}

/// The server's own web app, signed in as this phone: every tool the app has no screen for.
struct WebAppView: UIViewRepresentable {
    let api: API
    var path = "/"

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.allowsBackForwardNavigationGestures = true
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        let url = api.url(path)
        // the cookie of a session from before pairing, or this device session's ticket (`MediaTicket`), then the page;
        // a ticket lives 5 minutes, so a new one goes in before it runs out while the view is open
        let store = view.configuration.websiteDataStore.httpCookieStore
        context.coordinator.signIn = Task { @MainActor [api] in
            _ = await api.signIn(store)
            view.load(URLRequest(url: url))
            guard api.webNeedsTicket else { return }
            while (try? await Task.sleep(for: MediaTicket.refresh)) != nil { _ = await api.signIn(store) }
        }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}

    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) { coordinator.signIn?.cancel() }

    func makeCoordinator() -> Coordinator { Coordinator() }

    final class Coordinator {
        var signIn: Task<Void, Never>?
    }
}

/// Reads the sign-in code the computer shows (Settings → Computers → Add your phone). In the app, not the
/// Camera app: the code works once, and Safari would spend it.
struct CodeScanner: UIViewControllerRepresentable {
    let found: (String) -> Void

    /// The device can scan. `isAvailable` stays false until camera access is granted, so it is not asked here.
    static var supported: Bool { DataScannerViewController.isSupported }

    /// Camera access, asked the first time.
    static func cameraAllowed() async -> Bool { await AVCaptureDevice.requestAccess(for: .video) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
                                                isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(found: found) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let found: (String) -> Void
        private var done = false
        init(found: @escaping (String) -> Void) { self.found = found }

        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let code) in items {
                guard !done, let text = code.payloadStringValue else { continue }
                done = true
                scanner.stopScanning()
                found(text)
            }
        }
    }
}
