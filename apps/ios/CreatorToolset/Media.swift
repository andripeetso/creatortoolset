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
        let key = "\(api.server.absoluteString)\(path)" as NSString
        if let hit = Self.cache.object(forKey: key) { return image = hit }
        guard let data = try? await api.data(api.request(path)), let loaded = UIImage(data: data) else { return }
        Self.cache.setObject(loaded, forKey: key)
        image = loaded
    }
}

extension API {
    /// A player for a media path. The cookie is scoped to the server's host, so a redirect to a bucket never gets it.
    func player(_ path: String) -> AVPlayer {
        var cookies: [HTTPCookie] = []
        if let cookie, let host = server.host(),
           let c = HTTPCookie(properties: [.name: "cap_auth", .value: cookie, .domain: host, .path: "/"]) {
            cookies.append(c)
        }
        return AVPlayer(playerItem: AVPlayerItem(asset: AVURLAsset(url: url(path), options: [AVURLAssetHTTPCookiesKey: cookies])))
    }
}

/// The iPhone's own player: scrubbing, full screen, Picture in Picture, AirPlay, sound with the ring switch on silent.
struct NativePlayer: UIViewControllerRepresentable {
    let player: AVPlayer

    func makeUIViewController(context: Context) -> AVPlayerViewController {
        // playback, not the default ambient: the silent switch mutes ambient sound
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        let controller = AVPlayerViewController()
        controller.player = player
        controller.allowsPictureInPicturePlayback = true
        return controller
    }

    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        if controller.player !== player { controller.player = player }
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

/// The server's own web app, signed in with this phone's cookie: every tool the app has no screen for.
struct WebAppView: UIViewRepresentable {
    let api: API
    var path = "/"

    func makeUIView(context: Context) -> WKWebView {
        let view = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        view.allowsBackForwardNavigationGestures = true
        view.isOpaque = false
        view.backgroundColor = .black
        let url = api.url(path)
        guard let c = api.webCookie else {
            view.load(URLRequest(url: url))
            return view
        }
        view.configuration.websiteDataStore.httpCookieStore.setCookie(c) { view.load(URLRequest(url: url)) }
        return view
    }

    func updateUIView(_ view: WKWebView, context: Context) {}
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
