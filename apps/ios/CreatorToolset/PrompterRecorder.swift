import AVFoundation
import Photos
import SwiftUI

/// Filming with the script on screen: the camera fills the screen, the script scrolls at the top by the lens, recording starts the scroll and
/// stopping pauses it, and every take goes to Photos.
struct PrompterRecorder: View {
    let docs: [WorkshopDoc]
    @Binding var size: Double
    @Binding var speed: Double
    @Environment(\.dismiss) private var dismiss
    @StateObject private var camera = PrompterCamera()
    @State private var playing = false

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .top) {
                Color.black
                CameraPreview(session: camera.session)
                VStack(spacing: 0) {
                    topBar
                    // by the lens, so the eyes stay near the camera while reading
                    ScriptText(docs: docs, size: CGFloat(size), playing: playing, speed: CGFloat(speed), onCamera: true) {
                        playing = false
                    }
                    .frame(height: geo.size.height * 0.38)
                    .background(LinearGradient(colors: [.black.opacity(0.7), .black.opacity(0.3)], startPoint: .top, endPoint: .bottom))
                    Spacer()
                    bottomBar
                }
                .padding(.top, geo.safeAreaInsets.top)
                .padding(.bottom, geo.safeAreaInsets.bottom)
            }
            .ignoresSafeArea()
        }
        .statusBarHidden()
        .task { await camera.setUp() }
        .onDisappear { camera.tearDown() }
        .onChange(of: camera.recording) { _, on in playing = on }
    }

    private var topBar: some View {
        HStack(spacing: 4) {
            Button { dismiss() } label: { Image(systemName: "xmark").font(.title3.weight(.semibold)).frame(width: 44, height: 44) }
                .accessibilityLabel("Close")
                .disabled(camera.recording)
            Spacer()
            Button { size = max(16, size - 2) } label: { Text("A").font(.system(size: 15, weight: .semibold)).frame(width: 44, height: 44) }
                .accessibilityLabel("Smaller text")
            Button { size = min(44, size + 2) } label: { Text("A").font(.system(size: 24, weight: .semibold)).frame(width: 44, height: 44) }
                .accessibilityLabel("Bigger text")
            Button { camera.flip() } label: { Image(systemName: "arrow.triangle.2.circlepath.camera").font(.title3).frame(width: 44, height: 44) }
                .accessibilityLabel("Switch camera")
                .disabled(camera.recording)
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 10)
        .padding(.vertical, 4)
        .background(.black.opacity(0.7))
    }

    private var bottomBar: some View {
        VStack(spacing: 12) {
            if let message = camera.message {
                Text(message)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(.black.opacity(0.6), in: Capsule())
            }
            HStack {
                RoundControl(label: playing ? "Pause scrolling" : "Scroll the script") { playing.toggle() } content: {
                    Image(systemName: playing ? "pause.fill" : "play.fill")
                }
                Spacer()
                Button { camera.toggleRecording() } label: { RecordMark(recording: camera.recording) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(camera.recording ? "Stop recording" : "Record")
                    .disabled(!camera.ready)
                Spacer()
                SpeedControl(speed: $speed)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 40)
        }
        .padding(.bottom, 24)
    }
}

/// The camera, the microphone and one movie output; each take is written to a file, then saved to Photos.
@MainActor
final class PrompterCamera: NSObject, ObservableObject, AVCaptureFileOutputRecordingDelegate {
    let session = AVCaptureSession()
    @Published private(set) var recording = false
    @Published private(set) var ready = false
    @Published private(set) var message: String?
    private let output = AVCaptureMovieFileOutput()
    private var video: AVCaptureDeviceInput?
    private var front = true
    private var takes = 0
    private let queue = DispatchQueue(label: "prompter.camera")

    func setUp() async {
        guard !ready else { return }
        guard await AVCaptureDevice.requestAccess(for: .video) else {
            message = "Camera access is off: Settings → Creator Toolset → Camera"
            return
        }
        let mic = await AVCaptureDevice.requestAccess(for: .audio)
        session.beginConfiguration()
        session.sessionPreset = .high
        useCamera(front: front)
        if mic, let device = AVCaptureDevice.default(for: .audio), let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) {
            session.addInput(input)
        }
        if session.canAddOutput(output) { session.addOutput(output) }
        session.commitConfiguration()
        if !mic { message = "Microphone access is off: takes will have no sound" }
        let session = self.session
        queue.async { session.startRunning() }
        ready = true
    }

    func tearDown() {
        if output.isRecording { output.stopRecording() }
        let session = self.session
        queue.async { session.stopRunning() }
    }

    func flip() {
        guard !output.isRecording else { return }
        front.toggle()
        session.beginConfiguration()
        useCamera(front: front)
        session.commitConfiguration()
    }

    private func useCamera(front: Bool) {
        if let video { session.removeInput(video) }
        let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: front ? .front : .back)
        guard let device, let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) else {
            message = "No camera"
            return
        }
        session.addInput(input)
        video = input
    }

    func toggleRecording() {
        if output.isRecording {
            output.stopRecording()
            return
        }
        // portrait, as filmed: never mirrored, so text in the room reads the right way round
        if let c = output.connection(with: .video) {
            if c.isVideoRotationAngleSupported(90) { c.videoRotationAngle = 90 }
            if c.isVideoMirroringSupported {
                c.automaticallyAdjustsVideoMirroring = false
                c.isVideoMirrored = false
            }
        }
        let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].appendingPathComponent("Takes", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        output.startRecording(to: dir.appendingPathComponent("take-\(UUID().uuidString).mov"), recordingDelegate: self)
        recording = true
        message = nil
    }

    nonisolated func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo url: URL, from connections: [AVCaptureConnection], error: Error?) {
        // a take cut short (a call, the app left) still has its file when AVFoundation says it finished
        let ok = error == nil || (error as NSError?)?.userInfo[AVErrorRecordingSuccessfullyFinishedKey] as? Bool == true
        let failure = error?.localizedDescription
        Task { @MainActor in await self.finished(url, ok: ok, failure: failure) }
    }

    private func finished(_ url: URL, ok: Bool, failure: String?) async {
        recording = false
        guard ok else {
            message = "The take didn't record: \(failure ?? "unknown error")"
            try? FileManager.default.removeItem(at: url)
            return
        }
        let access = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard access == .authorized || access == .limited else {
            message = "Photos access is off, so the take stays in the app: Settings → Creator Toolset → Photos"
            return
        }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: url)
            }
            // only once Photos has it: a failed save keeps the file
            try? FileManager.default.removeItem(at: url)
            takes += 1
            message = "Take \(takes) saved to Photos"
        } catch {
            message = "Couldn't save to Photos: \(error.localizedDescription)"
        }
    }
}

/// The camera's live picture, filling the screen.
private struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var preview: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.preview.session = session
        view.preview.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ view: PreviewView, context: Context) {}
}
