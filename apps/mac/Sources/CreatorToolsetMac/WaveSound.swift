// What the chat-mode wave sounds like (ChatWave.swift), made here sample by sample (no sound files). While the button is
// held: air rushing in toward it, rising and louder the deeper the screen is drawn in, a low tone spooling up under it,
// throbbing and straining as it goes wild. When it pops: a thump falling in pitch and a rush of air going out, bigger the
// longer it was held; after a long hold a boom under them. A click draws nothing in and makes no sound. It follows the
// wave's own switch (Settings → Appearance → Chat mode) and the Mac's volume. Owner, 2026-11-14: "can there be sound
// effects of like sucking in and then letting go ... a building sound effect that reacts to how long it's being held".
import AVFoundation
import os

/// The sound itself, one sample at a time: told how deep the screen is drawn in while the button is held, and when it
/// pops. Everything it is told it follows over a few milliseconds, so it never steps.
struct WaveSynth {
    let rate: Float
    /// How deep the screen is drawn in while the button is held (WaveMoment.pull; 0 once let go), and how wild it is.
    var held: Float = 0
    var wild: Float = 0

    private var h: Float = 0, w: Float = 0, t: Float = 0
    private var seed: UInt32 = 0x9E37_79B9
    private var low: Float = 0, band: Float = 0, tone: Float = 0
    private var popAge: Float = 10, popLoud: Float = 0, popSize: Float = 0, popWild: Float = 0
    private var thump: Float = 0, sub: Float = 0, air: Float = 0

    init(rate: Float) { self.rate = rate }

    /// It pops: `drawnIn` is how deep the screen was drawn in when the button was let go (0 for a click: silent).
    mutating func pop(drawnIn: Float, wild: Float) {
        let x = min(max((drawnIn - 0.05) / 0.75, 0), 1)
        popLoud = x * x * (3 - 2 * x)
        popSize = min(drawnIn / 2.6, 1.4)
        popWild = wild
        popAge = 0
        thump = 0
        sub = 0
    }

    private mutating func noise() -> Float {
        seed ^= seed << 13
        seed ^= seed >> 17
        seed ^= seed << 5
        return Float(seed) / Float(UInt32.max) * 2 - 1
    }

    mutating func next() -> Float {
        let dt = 1 / rate, tau = 2 * Float.pi
        t += dt
        let follow = 1 - exp(-dt / 0.03)
        h += (held - h) * follow
        w += (wild - w) * follow
        var out: Float = 0
        // air rushing in: noise through a band that rises with the pull, a low tone spooling up under it; louder and
        // higher all the way to the longest hold
        let level = min(h / 3.6, 1)
        let n = noise()
        let f = 260 * pow(2, 2.6 * level) * (1 + 0.04 * w * sin(t * tau * 7))
        let q = 1.6 + 2.2 * w
        let fc = 2 * sin(Float.pi * min(f, rate / 6) / rate)
        low += fc * band
        band += fc * (n - low - band / q)
        tone += tau * 62 * pow(2, 1.6 * level) * (1 + 0.03 * w * sin(t * tau * 11)) * dt
        if tone > tau { tone -= tau }
        let throb = 1 - 0.5 * w * (0.5 + 0.5 * sin(t * tau * (9 + 5 * w)))
        let loud = 0.35 * level + 0.65 * level * level
        out += (1.1 * band / q + 0.22 * sin(tone)) * loud * throb
        // the pop: a thump falling in pitch, air rushing out and darkening; after a long hold a boom under them
        if popAge < 3 && popLoud > 0 {
            popAge += dt
            let a = popAge
            thump += tau * (48 + (150 - 40 * popSize) * exp(-a / 0.045)) * dt
            if thump > tau { thump -= tau }
            let cut = 300 + 4200 * exp(-a / (0.06 + 0.15 * popSize))
            air += (n - air) * (1 - exp(-tau * cut * dt))
            sub += tau * 36 * dt
            if sub > tau { sub -= tau }
            let attack = min(a / 0.004, 1)
            out += popLoud * attack * (0.55 * sin(thump) * exp(-a / (0.07 + 0.18 * popSize + 0.15 * popWild))
                + 0.45 * air * exp(-a / (0.12 + 0.3 * popSize + 0.3 * popWild)))
            out += 0.4 * popLoud * popWild * sin(sub) * exp(-a / 0.4) * min(a / 0.02, 1)
        }
        // (a half-second hold's pop peaks about as loud as the Mac's own "Pop", the longest hold's about as its "Tink")
        return tanh(out * 1.3) * 0.4
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
