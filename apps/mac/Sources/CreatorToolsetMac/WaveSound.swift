// What the chat-mode wave sounds like (ChatWave.swift), made here sample by sample (no sound files): light and round, as
// on a phone, never a boom (owner, 11-14: "more like social media ... a bubble bop ... smoother sounds", not "like an
// explosion"). While the button is held: a soft tone rising as the bubble grows, wobbling a little as it goes wild. When
// it pops: a bubble's bop, a short round tone chirping up; a bigger, lower one the longer it was held, and after a long
// hold two small ones after it. A click draws nothing in and makes no sound. It follows the wave's own switch
// (Settings → Appearance → Chat mode) and the Mac's volume.
import AVFoundation
import os

/// The sound itself, one sample at a time: told how deep the screen is drawn in while the button is held, and when it
/// pops. Everything it is told it follows over a few milliseconds, so it never steps.
struct WaveSynth {
    let rate: Float
    /// How deep the screen is drawn in while the button is held (WaveMoment.pull; 0 once let go), and how wild it is.
    var held: Float = 0
    var wild: Float = 0

    /// The tone's loudness and pitch follow what is held (the pitch only upward: let go, the tone fades where it is).
    private var h: Float = 0, pitch: Float = 0, w: Float = 0, t: Float = 0, tone: Float = 0
    /// The bubbles of the pop: when each starts after the pop (s), its pitch (Hz), how loud, how quickly it dies away (s),
    /// and where its wave is.
    private var bubbles: [(at: Float, f: Float, loud: Float, dies: Float, phase: Float)] = []
    private var popAge: Float = 10

    init(rate: Float) { self.rate = rate }

    /// It pops: `drawnIn` is how deep the screen was drawn in when the button was let go (0 for a click: silent).
    mutating func pop(drawnIn: Float, wild: Float) {
        let x = min(max((drawnIn - 0.05) / 0.75, 0), 1)
        let loud = x * x * (3 - 2 * x)
        guard loud > 0 else { return }
        // the deeper it was drawn in, the bigger the bubble: lower, a little longer
        let size = min(drawnIn / 2.6, 1.2)
        let f = 560 - 160 * size, dies = 0.045 + 0.035 * size
        bubbles = [(0, f, loud, dies, 0)]
        if wild > 0 {
            bubbles.append((0.075, f * 1.55, 0.5 * loud * wild, dies * 0.8, 0))
            bubbles.append((0.14, f * 2.05, 0.32 * loud * wild, dies * 0.7, 0))
        }
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
        var out: Float = 0
        // while held: a soft round tone rising as the bubble grows, wobbling a little as it goes wild
        let level = min(h / 3.6, 1), rise = min(pitch / 3.6, 1)
        if level > 0.0005 {
            tone += tau * 220 * pow(2, 1.25 * rise) * (1 + (0.006 + 0.025 * w) * sin(t * tau * 5.5)) * dt
            if tone > tau { tone -= tau }
            let wobble = 1 - 0.35 * w * (0.5 + 0.5 * sin(t * tau * 8))
            out += 0.22 * (0.2 * level + 0.8 * level * level) * wobble * (sin(tone) + 0.12 * sin(2 * tone))
        }
        // the pop: each bubble a round tone chirping up, there at once and gone within a moment
        if popAge < 1 {
            popAge += dt
            for i in bubbles.indices {
                let a = popAge - bubbles[i].at
                guard a > 0 else { continue }
                bubbles[i].phase += tau * bubbles[i].f * (1 + 1.3 * (1 - exp(-a / 0.02))) * dt
                if bubbles[i].phase > tau { bubbles[i].phase -= tau }
                out += 0.9 * bubbles[i].loud * min(a / 0.0015, 1) * exp(-a / bubbles[i].dies) * sin(bubbles[i].phase)
            }
        }
        // (its pop peaks about as loud as the Mac's own "Pop")
        return tanh(out * 1.2) * 0.4
    }
}

/// Plays the wave's sound: started with a held wave (off the main thread: starting the Mac's audio can take a moment),
/// stopped a little after the wave is over. A Mac with no way to play sound gets the wave with none.
final class WaveSound {
    private struct Told {
        var held: Float = 0, wild: Float = 0, at: CFTimeInterval = 0
        var pop: (drawnIn: Float, wild: Float)?
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
                let node = AVAudioSourceNode(format: mono) { [told] _, _, frames, buffers in
                    if let now = told.withLockIfAvailable({ s -> Told in
                        let t = s
                        s.pop = nil
                        return t
                    }) {
                        // nothing heard from the wave for a moment (its window hidden): what is held lets go
                        synth.held = CACurrentMediaTime() - now.at < 0.15 ? now.held : 0
                        synth.wild = now.wild
                        if let p = now.pop { synth.pop(drawnIn: p.drawnIn, wild: p.wild) }
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

    func pop(drawnIn: Float, wild: Float) {
        told.withLock {
            $0.held = 0
            $0.pop = (drawnIn, wild)
        }
    }

    /// The wave is over: what is still sounding (a long hold's boom) dies away, then the audio stops.
    func end() {
        told.withLock { $0.held = 0 }
        let stop = DispatchWorkItem { [weak self] in self?.queue.async { self?.engine?.stop() } }
        stopping = stop
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: stop)
    }
}
