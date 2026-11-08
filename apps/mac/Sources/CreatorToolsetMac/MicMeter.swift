import AVFoundation
import Foundation

/// Maps loudness onto the meter's 0...1 scale: -60 dB (silence) to 0 dB (full scale).
enum MicLevel {
    static let floorDB: Float = -60

    static func fromDecibels(_ db: Float) -> Float {
        min(1, max(0, (db - floorDB) / -floorDB))
    }

    /// Root mean square of samples in full scale (1 = 0 dB). Zero maps to 0.
    static func fromRMS(_ rms: Float) -> Float {
        rms > 0 ? fromDecibels(20 * log10(rms)) : 0
    }
}

/// Live microphone level for the toolbar. It runs its own capture session, so `stop()` must return
/// before a recording opens the same microphone. Don't call `stop()` from the level callback.
final class MicMeter: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    enum MeterError: Error { case cannotUseDevice }

    private let session = AVCaptureSession()
    // start and stop run here: startRunning blocks, and stop() waits for the session to halt
    private let sessionQueue = DispatchQueue(label: "mic-meter.session")
    // sample buffers arrive here
    private let sampleQueue = DispatchQueue(label: "mic-meter.samples")
    private var onLevel: (@Sendable (Float) -> Void)?
    private var lastSent: CFAbsoluteTime = 0    // sampleQueue only; caps updates at about 20/s

    func start(device: AVCaptureDevice, level: @escaping @Sendable (Float) -> Void) throws {
        stop()
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        onLevel = level
        try sessionQueue.sync {
            session.beginConfiguration()
            guard session.canAddInput(input), session.canAddOutput(output) else {
                session.commitConfiguration()
                throw MeterError.cannotUseDevice
            }
            session.addInput(input)
            session.addOutput(output)
            session.commitConfiguration()
            output.setSampleBufferDelegate(self, queue: sampleQueue)
            session.startRunning()
        }
    }

    /// Returns once the session has stopped and the device is released.
    func stop() {
        sessionQueue.sync {
            session.stopRunning()
            session.beginConfiguration()
            session.inputs.forEach { session.removeInput($0) }
            session.outputs.forEach { session.removeOutput($0) }
            session.commitConfiguration()
        }
        sampleQueue.sync {}    // a callback already in flight finishes before stop returns
        onLevel = nil
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let onLevel else { return }
        let now = CFAbsoluteTimeGetCurrent()
        guard now - lastSent >= 0.05 else { return }
        guard let rms = Self.rms(sampleBuffer) else { return }
        lastSent = now
        onLevel(MicLevel.fromRMS(rms))
    }

    /// RMS over every sample in the buffer, layout-agnostic. Handles 32-bit float and 16-bit integer PCM.
    static func rms(_ buffer: CMSampleBuffer) -> Float? {
        guard let format = CMSampleBufferGetFormatDescription(buffer),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee,
              let block = CMSampleBufferGetDataBuffer(buffer) else { return nil }
        let isFloat = asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0
        guard (isFloat && asbd.mBitsPerChannel == 32) || (!isFloat && asbd.mBitsPerChannel == 16) else { return nil }
        let length = CMBlockBufferGetDataLength(block)
        guard length > 0 else { return nil }
        var bytes = [UInt8](repeating: 0, count: length)
        guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &bytes) == kCMBlockBufferNoErr else {
            return nil
        }
        var sum = 0.0
        var count = 0
        bytes.withUnsafeBytes { raw in
            if isFloat {
                for offset in stride(from: 0, through: length - 4, by: 4) {
                    let v = Double(raw.loadUnaligned(fromByteOffset: offset, as: Float.self))
                    sum += v * v
                    count += 1
                }
            } else {
                for offset in stride(from: 0, through: length - 2, by: 2) {
                    let v = Double(raw.loadUnaligned(fromByteOffset: offset, as: Int16.self)) / 32768
                    sum += v * v
                    count += 1
                }
            }
        }
        return count > 0 ? Float((sum / Double(count)).squareRoot()) : nil
    }
}
