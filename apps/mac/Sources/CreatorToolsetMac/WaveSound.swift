// What the chat-mode wave sounds like (ChatWave.swift): light and silly, never a boom. While the button is held, a soft
// round "oooo" made here sample by sample, rising as the screen is drawn in and wobbling a little as it goes wild (owner,
// 11-15: "it sounds like it's literally me making the sound into the microphone"). When it pops, a soft "weee" that
// slides down and fades out (wave-wee.wav: a voice made with a text-to-speech model from a written description, not a
// recording of anyone): the oooo glides to the wee's first note and hands over to it within a tenth of a second, so the
// two sound like one voice. The longer the hold, the louder and longer the wee. A click draws nothing in and makes no
// sound. It follows the wave's own switch (Settings → Appearance → Chat mode) and the Mac's volume.
import AVFoundation
import os

/// The sound itself, one sample at a time: told how deep the screen is drawn in while the button is held, and when it
/// pops. Everything it is told it follows over a few milliseconds, so it never steps.
struct WaveSynth {
    let rate: Float
    /// How deep the screen is drawn in while the button is held (WaveMoment.pull; 0 once let go), and how wild it is.
    var held: Float = 0
    var wild: Float = 0
    /// The wee (samples at `weeRate`, already faded out at its end); empty: the pop makes no sound.
    var wee: [Float] = []
    var weeRate: Float = 24000
    /// The wee's first note (Hz): where the oooo glides to as it hands over.
    static let weeStarts: Float = 521

    /// The tone's loudness and pitch follow what is held (the pitch only upward: let go, the tone fades where it is).
    private var h: Float = 0, pitch: Float = 0, w: Float = 0, t: Float = 0, tone: Float = 0
    /// The tone's pitch and loudness on the last sample, where the handover to the wee starts from.
    private var freq: Float = 220, amp: Float = 0
    private var popAge: Float = 10, from: (freq: Float, amp: Float) = (220, 0), weeLoud: Float = 0, weeEnd: Float = 0

    init(rate: Float) { self.rate = rate }

    /// The wee as the app carries it (Contents/Resources/wave-wee.wav), or nil.
    static func loadWee(_ url: URL?) -> (samples: [Float], rate: Float)? {
        guard let url, let file = try? AVAudioFile(forReading: url),
              let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)),
              (try? file.read(into: buf)) != nil, let data = buf.floatChannelData else { return nil }
        return (Array(UnsafeBufferPointer(start: data[0], count: Int(buf.frameLength))), Float(file.processingFormat.sampleRate))
    }

    /// It pops: `drawnIn` is how deep the screen was drawn in when the button was let go (0 for a click: silent).
    mutating func pop(drawnIn: Float) {
        let x = min(max((drawnIn - 0.05) / 0.75, 0), 1)
        let loud = x * x * (3 - 2 * x)
        guard loud > 0, !wee.isEmpty else { return }
        // the deeper it was drawn in, the louder and longer the wee (the longest hold: all of it)
        let size = min(drawnIn / 3.6, 1)
        weeLoud = loud * (0.6 + 0.4 * size)
        weeEnd = Float(wee.count) / weeRate * (0.5 + 0.5 * size)
        from = (freq, amp)
        h = 0
        popAge = 0
    }

    mutating func next() -> Float {
        let dt = 1 / rate, tau = 2 * Float.pi
        t += dt
        let follow = 1 - exp(-dt / 0.04)
        h += (held - h) * follow
        if held > pitch { pitch += (held - pitch) * follow }
        if held == 0 && h < 0.001 { pitch = 0 }
        w += (wild - w) * follow
        var out: Float = 0, bridge: Float = 0
        let vibrato = 1 + (0.006 + 0.025 * w) * sin(t * tau * 5.5)
        // handing over: the wee comes in from 40 to 100 ms after the pop as the oooo, gliding to its first note, goes
        // (equal power, so the sum neither dips nor swells)
        let into = popAge < 1 ? sin(Float.pi / 2 * min(max((popAge - 0.04) / 0.06, 0), 1)) : 1
        if popAge < 0.1 {
            let g = min(popAge / 0.04, 1), glide = g * g * (3 - 2 * g)
            freq = from.freq + (Self.weeStarts - from.freq) * glide
            tone += tau * freq * vibrato * dt
            if tone > tau { tone -= tau }
            // and swells over 30 ms from the oooo's loudness to the wee's (a little under its opening, so it leads in)
            let r = min(popAge / 0.03, 1), swell = r * r * (3 - 2 * r)
            let loud = 0.48 * from.amp + (0.135 * weeLoud - 0.48 * from.amp) * swell
            bridge = loud * sqrt(max(1 - into * into, 0)) * (sin(tone) + 0.12 * sin(2 * tone))
        } else {
            // while held: the oooo, a soft round tone rising as the screen is drawn in, wobbling a little as it goes wild
            let level = min(h / 3.6, 1), rise = min(pitch / 3.6, 1)
            amp = 0
            if level > 0.0005 {
                freq = 220 * pow(2, 1.25 * rise)
                tone += tau * freq * vibrato * dt
                if tone > tau { tone -= tau }
                amp = 0.22 * (0.2 * level + 0.8 * level * level) * (1 - 0.35 * w * (0.5 + 0.5 * sin(t * tau * 8)))
                out += amp * (sin(tone) + 0.12 * sin(2 * tone))
            }
        }
        var voice: Float = 0
        if popAge < weeEnd {
            let at = popAge * weeRate, i = Int(at)
            if i + 1 < wee.count {
                let s = wee[i] + (wee[i + 1] - wee[i]) * (at - Float(i))
                // a shorter wee fades out over its second half
                let cut = Float(wee.count) / weeRate
                let f = weeEnd < cut ? min(max((popAge - 0.5 * weeEnd) / (0.5 * weeEnd), 0), 1) : 0
                let fade = cos(f * Float.pi / 2)
                voice = 0.17 * weeLoud * into * fade * fade * s
            }
        }
        if popAge < 10 { popAge += dt }
        // (the oooo peaks about as loud as the Mac's own "Pop"; the wee only a little louder: owner, 11-15, 5 dB louder
        // than now was "a bit too loud compared to the ooh")
        return tanh(out * 1.2) * 0.4 + bridge + voice
    }
}

/// Plays the wave's sound: started with a held wave (off the main thread: starting the Mac's audio can take a moment),
/// stopped a little after the wave is over. A Mac with no way to play sound gets the wave with none.
final class WaveSound {
    private struct Told {
        var held: Float = 0, wild: Float = 0, at: CFTimeInterval = 0
        var pop: Float?
    }
    private let told = OSAllocatedUnfairLock(initialState: Told())
    private let queue = DispatchQueue(label: "chat-wave-sound")
    private var engine: AVAudioEngine?
    private var stopping: DispatchWorkItem?

    func begin() {
        stopping?.cancel()
        told.withLock { $0 = Told() }
        queue.async { [self] in
            if engine?.isRunning == true { return }
            let e = engine ?? AVAudioEngine()
            if engine == nil {
                // (no way to play sound reports 0 Hz or no channels, and the engine would raise an exception Swift cannot
                // catch: then the wave makes none)
                let output = e.outputNode.outputFormat(forBus: 0)
                guard output.sampleRate > 0, output.channelCount > 0,
                      let mono = AVAudioFormat(standardFormatWithSampleRate: output.sampleRate, channels: 1) else { return }
                let rate = output.sampleRate
                var synth = WaveSynth(rate: Float(rate))
                if let wee = WaveSynth.loadWee(Bundle.main.url(forResource: "wave-wee", withExtension: "wav")) {
                    synth.wee = wee.samples
                    synth.weeRate = wee.rate
                }
                let node = AVAudioSourceNode(format: mono) { [told] _, _, frames, buffers in
                    if let now = told.withLockIfAvailable({ s -> Told in
                        let t = s
                        s.pop = nil
                        return t
                    }) {
                        // nothing heard from the wave for a moment (its window hidden): what is held lets go
                        synth.held = CACurrentMediaTime() - now.at < 0.15 ? now.held : 0
                        synth.wild = now.wild
                        if let p = now.pop { synth.pop(drawnIn: p) }
                    }
                    guard let out = UnsafeMutableAudioBufferListPointer(buffers).first?.mData?.assumingMemoryBound(to: Float.self) else { return noErr }
                    for i in 0 ..< Int(frames) { out[i] = synth.next() }
                    return noErr
                }
                e.attach(node)
                e.connect(node, to: e.mainMixerNode, format: mono)
                engine = e
            }
            try? e.start()
        }
    }

    /// While the button is held: how deep the screen is drawn in, how wild it is (every frame drawn).
    func hold(pull: Float, wild: Float) {
        told.withLock {
            $0.held = pull
            $0.wild = wild
            $0.at = CACurrentMediaTime()
        }
    }

    func pop(drawnIn: Float) {
        told.withLock {
            $0.held = 0
            $0.pop = drawnIn
        }
    }

    /// The wave is over: what is still sounding (the wee) dies away, then the audio stops.
    func end() {
        told.withLock { $0.held = 0 }
        let stop = DispatchWorkItem { [weak self] in self?.queue.async { self?.engine?.stop() } }
        stopping = stop
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: stop)
    }
}
