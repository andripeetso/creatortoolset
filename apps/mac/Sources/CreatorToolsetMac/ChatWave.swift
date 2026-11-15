// Chat mode switched on or off (apps/captions/src/lib/chat-mode.ts washTo): a wave goes through the window's own
// picture. A page can only move its boxes and paint over them; this bends the picture itself. A view over the web view
// shows a picture of the screen as it was. While the button is held that screen falls toward it, more and more: what is
// near the button shrinks into it, what is further is stretched toward it and turns round it, under a veil of blur and
// a light that grows at the button (the window's edges stay where they are, as a sheet pinned in its frame). When the
// button is let go (or, held long, by itself) it pops: one wave goes out across the window, its front wavering, its
// crest a ridge of glass (lit and shaded, its colours split where it bends most) that pushes the new screen out and lets
// it settle back after one small trough, the higher the longer the button was held. A click only pops. What the front
// has not reached yet is still being drawn in until the front lets it go: nothing stops between the pull and the wave.
// Past the settled wave the live page shows.
import AppKit
import Metal
import MetalKit
import OSLog
import WebKit

/// Each switch's timeline (ms since the press; numbers only), for `log show --predicate 'category == "chat-wave"'`:
/// whether a hold was seen, when the wave came up, when the button was let go and when it popped.
private let waveLog = Logger(subsystem: Bundle.main.bundleIdentifier ?? "CreatorToolsetMac", category: "chat-wave")

/// The page's "chatWave" messages for one web view (AppWebView registers it, for the open server's own page only):
/// - `{start: {x, y, dark, tint, hold}}`: a picture of the screen as it is goes over the page, the button at (x, y) in
///   the page's points, `tint` the project's colour as "r g b", `hold` true when the mouse went down on the button (the
///   wave pops when the mouse button comes up: watched here, as the page is busy drawing the new screen then);
///   answered true once it is up, false when there is no wave (the page then changes at once)
/// - `"drawn"`: the page has changed under the picture; a picture of the new screen is taken. Answered when the wave is
///   over
/// - `"stop"`: chat mode was switched again; the wave goes at once
/// - `"ready"`: the pointer came onto the button; a picture of the screen is taken now, so a press shows the wave at
///   once (on a big window, a picture can take half a second: what a press would wait for)
final class ChatWaveHost {
    private weak var view: WKWebView?
    private var wave: ChatWaveView?
    /// The answer to "drawn", given when the wave is over (or cut short).
    private var drawn: ((Any?, String?) -> Void)?
    /// The page is from before holding (it says nothing of `hold`): its own entrances still run after the switch.
    private var oldPage = false
    /// The sound of a held wave (WaveSound.swift); a click makes none.
    private let sound = WaveSound()
    /// The picture taken when the pointer came onto the button ("ready"), and who waits for one being taken (nil when
    /// none is).
    private var early: (picture: Picture, at: CFTimeInterval)?
    private var earlyWaiting: [(Picture?) -> Void]?
    /// A switch is on its way, from the press until its wave is over: a picture taken meanwhile could be of either
    /// screen, so none is taken or kept.
    private var switching = false

    init(_ view: WKWebView) {
        self.view = view
        // compiled now, so the first switch does not wait for it
        DispatchQueue.global(qos: .utility).async { _ = WaveRenderer.shared }
    }

    func handle(_ body: Any, reply: @escaping (Any?, String?) -> Void) {
        if let start = (body as? [String: Any])?["start"] as? [String: Any] { return begin(start, reply) }
        switch body as? String {
        case "drawn":
            guard let view, let wave else { return reply(true, nil) }
            drawn = reply
            waveLog.notice("new screen drawn at \(Int(wave.elapsed)) ms")
            // (a page from before holding still has its own entrances running: the wave waits for its picture)
            if !oldPage { wave.pageDrawn() }
            // the page has finished its own entrances by now (chat-mode.ts macWash): what it shows is the new screen. A
            // page from before that is given until 420 ms after the press, as it was then (what fades in is there by then)
            let wait = oldPage ? max(0, 420 - wave.elapsed) / 1000 : 0
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak view, weak wave] in
                guard let view, let wave, wave.superview != nil else { return }
                view.takeSnapshot(with: nil) { image, _ in
                    WaveRenderer.shared?.picture(image?.cgImage(forProposedRect: nil, context: nil, hints: nil)) { [weak wave] picture in
                        guard let wave, wave.superview != nil else { return }
                        if let picture { wave.setNew(picture.texture) } else { wave.finish() }
                        waveLog.notice("new screen's picture at \(Int(wave.elapsed)) ms")
                    }
                }
            }
        case "stop":
            wave?.finish()
            reply(true, nil)
        case "ready":
            prepare()
            reply(true, nil)
        default:
            reply(nil, "unknown")
        }
    }

    /// A picture of the screen as it is now, kept for a press in the next few seconds. Taken after the screen's next
    /// update, so with the button's look under the pointer.
    private func prepare() {
        guard !switching, wave == nil, earlyWaiting == nil, let view, let renderer = WaveRenderer.shared else { return }
        // (taking one holds the page still for as long: not again while the last is fresh)
        if let e = early, CACurrentMediaTime() - e.at < 2 { return }
        waveLog.notice("ready: taking the picture early")
        earlyWaiting = []
        view.takeSnapshot(with: nil) { image, _ in
            renderer.picture(image?.cgImage(forProposedRect: nil, context: nil, hints: nil)) { [weak self] picture in
                guard let self else { return }
                let at = CACurrentMediaTime()
                let waiting = self.earlyWaiting ?? []
                self.earlyWaiting = nil
                // kept only for a press still to come: one a press took is of the screen before its switch, and a
                // second quick press showed it, the new screen there before its wave (owner, 11-14: "sometimes when
                // fast clicking the image changes before the shockwave does")
                if let picture, waiting.isEmpty, !self.switching { self.early = (picture, at) }
                waiting.forEach { $0(picture) }
                // (a picture of a big window is large: not kept past its use)
                DispatchQueue.main.asyncAfter(deadline: .now() + 3.1) { [weak self] in
                    if self?.early?.at == at { self?.early = nil }
                }
            }
        }
    }

    /// The screen as it is on show now: the picture taken as the pointer came onto the button when it is recent (or
    /// still being taken: that comes sooner than a new one), else a new one.
    private func screenNow(_ done: @escaping (Picture?, Bool) -> Void) {
        if let e = early, CACurrentMediaTime() - e.at < 3 {
            early = nil
            return done(e.picture, true)
        }
        early = nil
        if earlyWaiting != nil { return earlyWaiting!.append { done($0, true) } }
        // not after the next update: the page changes only once this is answered
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        view?.takeSnapshot(with: config) { image, _ in
            guard let renderer = WaveRenderer.shared else { return done(nil, false) }
            renderer.picture(image?.cgImage(forProposedRect: nil, context: nil, hints: nil)) { done($0, false) }
        }
    }

    private func begin(_ start: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        // the press, as near as the app can tell: the page asks as the mouse goes down
        let pressed = CACurrentMediaTime()
        wave?.finish()
        guard let view, let renderer = WaveRenderer.shared, let x = start["x"] as? Double, let y = start["y"] as? Double else { return reply(false, nil) }
        switching = true
        let rgb = ((start["tint"] as? String) ?? "").split(separator: " ").compactMap { Float($0) }
        let tint = rgb.count == 3 ? SIMD3(rgb[0], rgb[1], rgb[2]) / 255 : SIMD3<Float>(0.49, 0.23, 0.93)
        let dark = start["dark"] as? Bool ?? false
        // (a page from before holding sends none: a click)
        let hold = start["hold"] as? Bool ?? false
        oldPage = start["hold"] == nil
        waveLog.notice("start: hold \(hold), mouse down \(ChatWaveView.mouseDown()), page from before holding \(self.oldPage)")
        if hold { sound.begin() }
        screenNow { [weak self] picture, early in
            let making = CACurrentMediaTime()
            guard let self, let view = self.view, let picture,
                  let wave = try? ChatWaveView(over: view, was: picture, renderer: renderer, origin: CGPoint(x: x * view.pageZoom, y: y * view.pageZoom), tint: tint, dark: dark, hold: hold, pressed: pressed, sound: hold ? self.sound : nil)
            else {
                waveLog.notice("no wave: no picture of the screen")
                self?.sound.end()
                self?.switching = false
                return reply(false, nil)
            }
            self.wave = wave
            wave.onDone = { [weak self] in
                self?.wave = nil
                self?.switching = false
                self?.drawn?(true, nil)
                self?.drawn = nil
            }
            // The page changes once the picture of the screen as it was is on show, not before: the new screen would
            // flash for a frame (a switch to a light page is drawn that quickly). Should no frame come (its window hidden),
            // it changes anyway.
            var answered = false
            let answer = { (shown: Bool) in
                guard !answered else { return }
                answered = true
                waveLog.notice("up at \(Int(wave.elapsed)) ms, picture taken early \(early), made in \(Int((CACurrentMediaTime() - making) * 1000)) ms, first frame on show \(shown)")
                reply(true, nil)
            }
            wave.onShown = { answer(true) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { answer(false) }
        }
    }
}

/// The shader, compiled when the app starts (a Swift package compiles no .metal files).
private let waveShader = """
#include <metal_stdlib>
using namespace metal;

struct V { float4 pos [[position]]; float2 uv; };

vertex V waveVertex(uint id [[vertex_id]]) {
    float2 p = float2((id << 1) & 2, id & 2);
    V v;
    v.pos = float4(p * 2.0 - 1.0, 0.0, 1.0);
    v.uv = float2(p.x, 1.0 - p.y);
    return v;
}

struct U {
    float4 a;   // size of the picture (px), the button (px)
    float4 b;   // how hard the screen is drawn in (0 to 1), how far round the button that reaches (px), turn (radians), veil (px of blur)
    float4 c;   // front (px from the button), its width (px), the wave's height (px), its light (0 to 1)
    float4 d;   // the project's colour (0 to 1), 1 on a dark screen
    float4 e;   // the light at the button (0 to 1), seconds since the press, px a point, colour split
    float4 f;   // how much of the wave is left on the window (1, then down to 0 as it ends), the height its light is for
                // (px), how far behind the front's middle a point is let go by (front widths), how wild a long hold made it
                // (0 to 1)
    float4 g;   // whether the picture of the new screen is here (0, up to 1 over a few frames once it is)
};

static float grain(float2 p) { return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }

// The wave's height across its front (x in front widths, 0 its middle, below 0 behind it): one broad, soft crest, then
// two slight ridges behind it as it settles, as water does; deeper after a long hold (`wild`, 0 to 1).
static float height(float x, float wild) {
    return exp(-1.6 * x * x) - 0.24 * (1.0 + 0.9 * wild) * exp(-1.4 * (x + 1.6) * (x + 1.6))
         + 0.09 * (1.0 + 1.4 * wild) * exp(-1.4 * (x + 3.1) * (x + 3.1));
}

fragment float4 waveFragment(V in [[stage_in]], constant U &u [[buffer(0)]],
                             texture2d<float> was [[texture(0)]], texture2d<float> now [[texture(1)]]) {
    constexpr sampler sm(address::clamp_to_edge, filter::linear);
    float2 size = u.a.xy, o = u.a.zw;
    float pull = u.b.x, reach = u.b.y, swirl = u.b.z, veil = u.b.w;
    float front = u.c.x, w = u.c.y, amp = u.c.z, flash = u.c.w;
    float3 tint = u.d.xyz;
    bool dark = u.d.w > 0.5;
    float bloom = u.e.x, time = u.e.y, pt = u.e.z, split = u.e.w;
    float wild = u.f.w;

    float2 p = in.uv * size;
    float2 v = p - o;
    float r = max(length(v), 0.001);
    float2 n = v / r;
    float ang = atan2(v.y, v.x);

    // the front is no circle: it wavers along its length, and the wavering moves
    float waver = 0.6 * sin(ang * 7.0 + time * 3.5) + 0.32 * sin(ang * 13.0 - time * 5.5 + 1.3) + 0.08 * sin(ang * 23.0 + time * 8.0 + 2.1);
    // (none at the button itself, where a little of it round a small circle would make a star)
    float x = (r - front - waver * w * 0.28 * smoothstep(0.0, 120.0 * pt, r)) / w;
    // well behind the front, once its wave has settled: the page itself shows
    if (x < -4.6) return float4(0.0);
    float ahead = smoothstep(-0.4, 0.4, x);
    // The top bar goes with the rest (owner, 11-14: "I want this top half also to be affected"), all but the button
    // under the pointer: nothing within 20 points of the middle of it (its corners) moves, blurs or splits, so it stays
    // put (11-13: "the button underneath my mouse should not move"); the wave comes in over the next 26.
    float still = smoothstep(20.0 * pt, 46.0 * pt, r);

    // The screen that was falls toward the button: what is near it shrinks into it, what is further is stretched
    // toward it, and all of it turns a little round it. Each point is drawn in until the front comes, and let go as it
    // passes (from 1.5 front widths ahead of its middle to 1.5 behind, further behind the deeper it was drawn in):
    // quick, never in one frame.
    float letgo = smoothstep(-u.f.z, 1.5, x);
    // Held long it goes wilder: it turns harder, in rings that churn in toward the button, and trembles.
    float tremor = wild * wild * 3.0 * pt * sin(time * 47.0 + ang * 3.0);
    float sucked = max(0.7 * pull * r + tremor, 0.0) * exp(-r / reach) * letgo * still;
    float churn = wild * (0.3 + 0.12 * sin(r / (90.0 * pt) + time * 10.0));
    float turn = (swirl + churn) * pull * exp(-r / (0.6 * reach)) * letgo * still;
    // Behind the front the new screen is pushed out by the crest and settles after two slight ridges.
    float h = height(x, wild) * still;
    float slope = (height(x + 0.05, wild) - height(x - 0.05, wild)) / 0.1 * still;
    // ... but the window's edges stay put, as a sheet pinned in its frame: a point is never drawn from past the edge
    // (which would smear the picture's last row), and the closer to it the less it moves. `edge` is how far the window
    // goes from the button this way; with nothing drawn in, `rs` is `r`.
    float2 far2 = float2(n.x > 0.0 ? size.x - o.x : o.x, n.y > 0.0 ? size.y - o.y : o.y);
    float edge = min(far2.x / max(abs(n.x), 1e-4), far2.y / max(abs(n.y), 1e-4));
    float gap = max(edge - r, 0.0);
    float rs = max(edge - gap * gap / (gap + sucked + 1e-3) - amp * h, 0.0);
    float as = ang + turn;
    float2 ns = float2(cos(as), sin(as));
    float2 ts = float2(-ns.y, ns.x);
    float2 base = o + ns * rs;

    // Out of focus: a veil round the button while the screen falls into it, and the crest of the wave.
    // (the crest's blur goes as the wave dies away)
    // (no wider than a hold of about a second and a half makes it: wider, the blur's taps would show as copies)
    float soft = (veil * min(pull, 2.6) * exp(-r / (0.8 * reach)) * letgo + 9.0 * pt * abs(h) * (amp / (30.0 * pt)) * (0.4 + 0.6 * flash)) * still;
    // the colours split where the picture bends most
    float sp = split * (abs(slope) * amp * 0.5 + 0.12 * sucked) * still;
    // How much of this point the pictures make: all of it ahead of the front; behind it, before the picture of the new
    // screen has come, the page itself shows (it is the new screen by then), lit by the wave: a click's wave goes as soon
    // as the page has drawn the new screen, not once a picture of it is taken (owner, 11-14: "it still takes time for it
    // to switch ... it doesn't work 100% super fast")
    float ready = u.g.x;
    float cover = mix(ahead, 1.0, ready);
    float3 col = float3(0.0);
    // (a slight blur needs fewer taps: the window can be 6K at 120 frames a second)
    int taps = soft < 0.75 ? 1 : (soft < 6.0 ? 8 : 16);
    float spin = grain(p) * 6.2831853;
    for (int k = 0; k < taps; k++) {
        float fk = float(k);
        float ring = taps == 1 ? 0.0 : sqrt((fk + 0.5) / float(taps));
        float a = fk * 2.3999632 + spin;
        float2 q = base + (ns * cos(a) * 1.8 + ts * sin(a)) * soft * ring;
        float2 qr = (q + ns * sp) / size, qg = q / size, qb = (q - ns * sp) / size;
        float3 A = float3(was.sample(sm, qr).r, was.sample(sm, qg).g, was.sample(sm, qb).b);
        float3 B = float3(now.sample(sm, qr).r, now.sample(sm, qg).g, now.sample(sm, qb).b);
        col += ahead * A + (1.0 - ahead) * ready * B;
    }
    col = cover > 0.001 ? col / (float(taps) * cover) : float3(0.0);

    // The wave as a surface of glass, lit from the button's side: a highlight where it faces the light, a shade where
    // it turns away, a sheen at its edges in the project's colour turning warm; brightest as it leaves the button.
    // (no brighter for a long hold: its wave is higher, but the glass would glare)
    float lamp = u.f.y;
    float3 N = normalize(float3(-slope * lamp / w * 2.2 * n, 1.0));
    float3 L = normalize(float3(-0.5, -0.6, 0.62));
    float3 Hv = normalize(L + float3(0.0, 0.0, 1.0));
    float spec = pow(max(dot(N, Hv), 0.0), 36.0) * smoothstep(0.02, 0.2, abs(slope) * lamp / w * 2.2);
    float facing = dot(N, L) - L.z;
    float rim = pow(1.0 - N.z, 3.0);
    float3 sheen = mix(mix(tint, float3(1.0), 0.55), mix(tint, float3(1.0, 0.86, 0.72), 0.5), 0.5 + 0.5 * sin(ang * 3.0 + slope * 2.0 + time * 3.0));
    // (the same light over the page itself where no picture is: `over`, laid over it with `overA` of cover)
    float3 over = float3(0.0);
    float overA = 0.0;
    if (dark) {
        float3 add = sheen * (spec * 1.4 + rim * 1.2) * flash + tint * max(h, 0.0) * (0.25 + 0.3 * wild) * flash;
        col += add;
        col *= 1.0 + facing * 0.6 * flash;
        over += add;
    } else {
        // the shade side in the project's colour, never grey
        float shade = clamp(-min(facing, 0.0) * 0.8 * flash, 0.0, 0.35);
        float glint = clamp(spec * 1.2 * flash, 0.0, 1.0);
        float sheenAt = clamp((rim * 1.2 + max(h, 0.0) * 0.18) * flash, 0.0, 0.45);
        col *= mix(float3(1.0), mix(tint, float3(1.0), 0.6), shade);
        col = mix(col, float3(1.0), glint);
        col = mix(col, sheen, sheenAt);
        over = float3(glint);
        overA = glint;
        over = sheen * sheenAt + (1.0 - sheenAt) * over;
        overA = sheenAt + (1.0 - sheenAt) * overA;
    }
    // the light at the button: a white core in a halo of the project's colour
    float core = exp(-(r * r) / (2116.0 * pt * pt));
    float halo = exp(-r / (110.0 * pt));
    if (dark) {
        float3 light = clamp((float3(core * 0.9) + tint * halo * 0.6) * bloom, 0.0, 1.0);
        col = 1.0 - (1.0 - col) * (1.0 - light);
        over += light;
    } else {
        float3 haloColour = mix(tint, float3(1.0), 0.35);
        float kh = clamp(halo * 0.45 * bloom, 0.0, 1.0), kc = clamp(core * 0.85 * bloom, 0.0, 1.0);
        col = mix(col, haloColour, kh);
        col = mix(col, float3(1.0), kc);
        over = haloColour * kh + (1.0 - kh) * over;
        overA = kh + (1.0 - kh) * overA;
        over = float3(kc) + (1.0 - kc) * over;
        overA = kc + (1.0 - kc) * overA;
    }
    // a fine grain in what is out of focus, like frosted glass
    col += (grain(p + time) - 0.5) * 0.05 * clamp(soft / (8.0 * pt), 0.0, 1.0);
    // the wave's last ridges fade into the page as it ends, so it is never taken away at once
    float alpha = smoothstep(-4.6, -3.9, x) * u.f.x;
    float3 colour = clamp(col, 0.0, 1.0) * cover + over * (1.0 - cover);
    return float4(colour * alpha, (cover + (1.0 - cover) * overA) * alpha);
}
"""

/// Where the wave is at `ms` after the press, for a window `size` px with the button at `origin` px, `scale` px a point.
struct WaveMoment {
    /// How hard the screen is drawn in toward the button (0 for a click, 2 and more when held long), how far round the
    /// button that reaches (px), how far it turns round it (radians), how out of focus it is at the button (px).
    var pull: Float, reach: Float, swirl: Float, veil: Float
    /// The front (px from the button), its width (px), the wave's height (px), the light on it.
    var front: Float, width: Float, wave: Float, flash: Float
    /// The light at the button (up within a few frames of the press, so the press is answered at once), the seconds
    /// since the press (the front's wavering moves with them), how far the colours split.
    var bloom: Float, seconds: Float, split: Float
    /// Pixels a point.
    var px: Float
    /// How much of the wave is left on the window: 1, down to 0 over the end of the sweep.
    var left: Float = 1
    /// The wave's height as its light sees it (px): as high as a hold of about half a second makes it, at most.
    var lit: Float = 0
    /// How far behind the front's middle a point is let go by (front widths): further the deeper the screen was drawn
    /// in, so the pop is quick but never a jump however long the button was held.
    var back: Float = 1.5
    /// How wild a long hold has made it (0 to 1): see `WaveClock.wild`.
    var wild: Float = 0
    /// Whether the picture of the new screen is here (0 to 1): before it is, the page itself shows behind the front.
    var ready: Float = 1
    var done: Bool
}

enum WaveClock {
    /// A press shorter than this is a click: nothing is drawn in, the wave only pops (ms). Held longer, the screen falls
    /// in until the button is let go, or until `longest` (ms after the press), when it pops by itself (owner, 11-14:
    /// "only suck when the user holds down the button ... and at a certain point it pops; the longer the button is held
    /// down the stronger the pop").
    static let holdFrom: Double = 140
    static let longest: Double = 2000
    /// Held past `wildFrom` (ms) it goes wilder until `longest`: it twists harder, churns and trembles, and the pop is an
    /// explosion: a higher wave with deeper ridges, more split colour and light in the project's colour, and longer
    /// (owner, 11-14: "the longer the hold, the worse the effect gets and starts twisting stuff and going a bit crazier
    /// ... and an even bigger explosion for the long one").
    static let wildFrom: Double = 900
    static func wild(_ ms: Double) -> Float {
        let t = Float(min(max((ms - wildFrom) / (longest - wildFrom), 0), 1))
        return t * t * (3 - 2 * t)
    }
    /// One wave goes out across the window, quick as it leaves, slowing for a long while as it spreads and dying away to
    /// nothing as it reaches the far side (ms): longer after a long hold.
    static func sweep(held: Double) -> Double { 950 + 450 * Double(wild(held)) }
    /// The widest the front gets (points), and how far past the far corner its middle ends (front widths: its crest and
    /// first ridge have crossed the window; what is left of the wave fades out there).
    static let widest: Float = 240
    static let past: Float = 1.8
    /// The front leaves from this far behind the button (front widths): on the frame it leaves the screen round the
    /// button has been let go by only a few points (the shader's `letgo` reaches 1.5 widths ahead of its middle), and
    /// within three frames it is out past the bar, so the wave follows the pull with no pause between them.
    static let behind: Float = 0.5

    /// How hard the screen is drawn in `ms` after the press, the button held until `held` (ms; under `holdFrom`: a
    /// click). Held, it is on its way within a few frames and quick from the start (owner, 11-14: "make the sucking
    /// stronger right off the bat"), and goes on deeper as long as it is held, never resting. Let go, what the front
    /// has not reached yet goes on falling in, at a speed that falls only slowly: nothing stops before the wave (11-14).
    static func pull(_ ms: Double, held: Double) -> Float {
        func deep(_ t: Double) -> Double {
            let h = max(t - holdFrom, 0)
            return (0.7 * (1 - exp(-h / 200)) + 0.0016 * h) * (1 - exp(-h / 40))
        }
        if ms <= held { return Float(deep(ms)) }
        // at the speed it had, slowing over 300 ms (the new screen's picture can come half a second late on a big
        // window: no stop meanwhile); a press little longer than a click (quick to fall in, with little drawn in yet)
        // slows sooner, so it stays all but a click
        let speed = deep(held) - deep(held - 1)
        let slows = speed > 0 ? min(300, deep(held) / speed * (1 + max(held - holdFrom - 60, 0) / 40)) : 300
        return Float(deep(held) + speed * slows * (1 - exp(-(ms - held) / slows)))
    }

    /// The wave `ms` after the press, the button held until `held` (ms; 0 for a click), the front let go at `release`
    /// (nil, or later than `ms`: not yet; the button is still held, or the picture of the new screen has not come), for a
    /// window `size` px with the button at `origin` px, `scale` px a point.
    static func at(_ ms: Double, held: Double, release: Double?, size: CGSize, origin: CGPoint, scale: CGFloat) -> WaveMoment {
        let s = Float(scale)
        let far = Float(hypot(max(origin.x, size.width - origin.x), max(origin.y, size.height - origin.y)))
        let seconds = Float(ms / 1000)
        let lit = Float(1 - pow(1 - min(ms / 80, 1), 3))
        let p = pull(ms, held: held)
        let w = wild(min(ms, held))
        guard let release, ms >= release else {
            // (the light at the button throbs as it goes wild)
            return WaveMoment(pull: p, reach: 380 * s, swirl: 0.4, veil: 18 * s, front: -1e6, width: 160 * s, wave: 0, flash: 0,
                              bloom: lit * (0.55 + 0.45 * min(p, 1)) * (1 + 0.15 * w * sin(seconds * 18)), seconds: seconds,
                              split: 0.08 * (1 + 0.8 * w), px: s, wild: w, done: false)
        }
        // the longer the button was held, the harder it pops: a click's wave is about a third of the longest hold's
        let drawnIn = pull(held, held: held)
        let pop = 0.65 + 0.35 * drawnIn
        let u = Float(min((ms - release) / sweep(held: held), 1))
        let width = (160 + (widest - 160) * u) * s
        // quick as it leaves, slower and slower after (no point moves more than about 25 points in a frame)
        let from = -behind * 160 * s
        let front = from + (far + past * widest * s - from) * (1 - pow(1 - u, 1.7))
        let dying = pow(1 - u, 1.3)
        // over the last quarter what is left of the wave fades into the page
        let fade = Double(min(max((u - 0.75) / 0.25, 0), 1))
        return WaveMoment(pull: p, reach: 380 * s, swirl: 0.4, veil: 18 * s, front: front, width: width, wave: 26 * s * dying * pop,
                          flash: (0.25 + 0.75 * exp(-2.2 * u)) * pow(1 - u, 0.9) * min(pop, 1),
                          bloom: exp(-7 * u) * (1 + 0.6 * w * exp(-12 * u)), seconds: seconds,
                          split: 0.08 * min(pop, 1.35) * (1 + 1.2 * w), px: s, left: Float(1 - fade * fade * (3 - 2 * fade)),
                          lit: 26 * s * dying * min(pop, 1), back: 1.5 * max(1, 1 + 0.5 * (drawnIn - 1)), wild: w, done: u >= 1)
    }
}

/// The compiled shader and the two pictures; draws one moment of the wave.
final class WaveRenderer {
    let device: MTLDevice
    let queue: MTLCommandQueue
    private let pipeline: MTLRenderPipelineState
    private let loader: MTKTextureLoader
    var was: MTLTexture?
    var now: MTLTexture?

    /// Built once, off the main thread, when the app starts; nil where Metal is missing or the shader does not compile.
    static let shared: WaveRenderer? = try? WaveRenderer()

    init() throws {
        guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { throw WaveError.noMetal }
        self.device = device
        self.queue = queue
        let library = try device.makeLibrary(source: waveShader, options: nil)
        let d = MTLRenderPipelineDescriptor()
        d.vertexFunction = library.makeFunction(name: "waveVertex")
        d.fragmentFunction = library.makeFunction(name: "waveFragment")
        let c = d.colorAttachments[0]!
        c.pixelFormat = .bgra8Unorm
        // the shader's colour is premultiplied: drawn over the new screen (the harness) or over nothing (the window)
        c.isBlendingEnabled = true
        c.sourceRGBBlendFactor = .one
        c.sourceAlphaBlendFactor = .one
        c.destinationRGBBlendFactor = .oneMinusSourceAlpha
        c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
        pipeline = try device.makeRenderPipelineState(descriptor: d)
        loader = MTKTextureLoader(device: device)
    }

    /// A picture as a texture, its values as they are (no colour conversion): the view shows it in the picture's own
    /// colour space, so where nothing bends it, it is the screen, pixel for pixel.
    func texture(_ image: CGImage) throws -> MTLTexture {
        try loader.newTexture(cgImage: image, options: textureOptions)
    }

    /// The same, made off the main thread, which draws the wave (copying a picture of a 6K window takes tens of
    /// milliseconds: frames the wave would miss); `done` runs on the main thread, with nil when there is no picture.
    func picture(_ image: CGImage?, _ done: @escaping (Picture?) -> Void) {
        guard let image else { return done(nil) }
        let space = image.colorSpace
        loader.newTexture(cgImage: image, options: textureOptions) { texture, _ in
            DispatchQueue.main.async { done(texture.map { Picture(texture: $0, space: space) }) }
        }
    }

    private let textureOptions: [MTKTextureLoader.Option: Any] = [
        .SRGB: false, .textureUsage: MTLTextureUsage.shaderRead.rawValue, .textureStorageMode: MTLStorageMode.private.rawValue,
    ]

    /// `was` and `now` default to the renderer's own (a picture renderer such as the tests'); a wave passes its own.
    func encode(_ m: WaveMoment, size: CGSize, origin: CGPoint, tint: SIMD3<Float>, dark: Bool,
                into pass: MTLRenderPassDescriptor, on buffer: MTLCommandBuffer, was: MTLTexture? = nil, now: MTLTexture? = nil) {
        guard let was = was ?? self.was, let enc = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        let now = now ?? self.now
        var u: [SIMD4<Float>] = [
            SIMD4(Float(size.width), Float(size.height), Float(origin.x), Float(origin.y)),
            SIMD4(m.pull, m.reach, m.swirl, m.veil),
            SIMD4(m.front, m.width, m.wave, m.flash),
            SIMD4(tint.x, tint.y, tint.z, dark ? 1 : 0),
            SIMD4(m.bloom, m.seconds, m.px, m.split),
            SIMD4(m.left, m.lit, m.back, m.wild),
            SIMD4(m.ready, 0, 0, 0),
        ]
        enc.setRenderPipelineState(pipeline)
        enc.setFragmentBytes(&u, length: MemoryLayout<SIMD4<Float>>.stride * u.count, index: 0)
        enc.setFragmentTexture(was, index: 0)
        enc.setFragmentTexture(now ?? was, index: 1)
        enc.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
        enc.endEncoding()
    }
}

enum WaveError: Error { case noMetal }

/// A picture of the screen on the GPU, and the colour space it is in.
struct Picture {
    let texture: MTLTexture
    let space: CGColorSpace?
}

/// The wave over the web view while it runs; takes no clicks, and goes when the front has left the window. Drawn on a
/// thread of its own, in step with the display: the main thread is busy while the page under it switches (WebKit puts
/// the new screen together there), and drawn there the wave missed frames, worst the first time after a pause (owner,
/// 11-14: "sometimes it just lags ... it gets stuck ... when I trigger it cold it sometimes lags, stutters").
final class ChatWaveView: NSView, CAMetalDisplayLinkDelegate {
    private let renderer: WaveRenderer
    private let metal = CAMetalLayer()
    private var link: CAMetalDisplayLink?
    private let origin: CGPoint
    private let tint: SIMD3<Float>
    private let dark: Bool
    private let was: MTLTexture
    /// What the main thread and the drawing thread share: when the button was pressed (moved later by however long the
    /// first picture took past `holdFrom`, so the pull starts from nothing on the first frame drawn), the picture of
    /// the new screen and when it came (the front waits for it, at most `wait` ms after it would have gone), the
    /// drawable's size and scale, and whether the wave is over.
    private struct Shared {
        var started: CFTimeInterval
        var now: MTLTexture?
        var newAt: Double?
        /// When the page said it has drawn the new screen: the front can go then, the page itself showing behind it.
        var drawnAt: Double?
        var size = CGSize.zero, scale: CGFloat = 2
        var over = false
    }
    private let shared: OSAllocatedUnfairLock<Shared>
    private let wait: Double = 1000
    /// The drawing thread's own: the first frame (ms), whether it has popped, when the button was let go (ms; at most
    /// `WaveClock.longest`), frames drawn, how many came late (half a frame or more after they were due) and the
    /// longest gap between two (ms).
    private var shownAt: Double?, popped = false, goAt: Double?
    private var frames = 0, late = 0, worstGap: Double = 0, lastDraw: Double?
    /// One frame at the display's rate (ms).
    private let due: Double
    /// The mouse went down on the button: the screen falls in until its button comes up.
    private let hold: Bool
    /// Whether the mouse button is down now (a test sets its own).
    static var mouseDown: () -> Bool = { NSEvent.pressedMouseButtons & 1 != 0 }
    var onDone: (() -> Void)?
    /// The first frame is on the screen (called on the main thread).
    var onShown: (() -> Void)?
    private let sound: WaveSound?

    init(over view: NSView, was: Picture, renderer: WaveRenderer, origin: CGPoint, tint: SIMD3<Float>, dark: Bool, hold: Bool,
         pressed: CFTimeInterval = CACurrentMediaTime(), sound: WaveSound? = nil) throws {
        shared = OSAllocatedUnfairLock(initialState: Shared(started: pressed))
        self.sound = sound
        self.renderer = renderer
        self.origin = origin
        self.tint = tint
        self.dark = dark
        self.hold = hold
        self.was = was.texture
        due = 1000 / Double(max(view.window?.screen?.maximumFramesPerSecond ?? 60, 30))
        super.init(frame: view.bounds)
        autoresizingMask = [.width, .height]
        metal.device = renderer.device
        metal.pixelFormat = .bgra8Unorm
        metal.framebufferOnly = true
        metal.isOpaque = false
        metal.colorspace = was.space
        layer = metal
        wantsLayer = true
        view.addSubview(self)
        resized()
        let link = CAMetalDisplayLink(metalLayer: metal)
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, __preferred: 120)
        link.delegate = self
        self.link = link
        let shared = shared
        let thread = Thread {
            link.add(to: .current, forMode: .default)
            while !shared.withLock({ $0.over }) { _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1)) }
        }
        thread.name = "chat-wave"
        thread.qualityOfService = .userInteractive
        thread.start()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("not used") }

    /// Gone without being finished (its window closed mid-wave): its thread and display link stop with it.
    deinit {
        shared.withLock { $0.over = true }
        link?.invalidate()
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func layout() {
        super.layout()
        resized()
    }

    override func viewDidChangeBackingProperties() {
        super.viewDidChangeBackingProperties()
        resized()
    }

    private func resized() {
        let scale = window?.backingScaleFactor ?? 2
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        metal.contentsScale = scale
        metal.drawableSize = size
        shared.withLock {
            $0.size = size
            $0.scale = scale
        }
    }

    /// Milliseconds since the wave went up.
    var elapsed: Double { (CACurrentMediaTime() - shared.withLock { $0.started }) * 1000 }

    /// The page has drawn the new screen (it is on show under the wave).
    func pageDrawn() {
        shared.withLock { $0.drawnAt = (CACurrentMediaTime() - $0.started) * 1000 }
    }

    func setNew(_ texture: MTLTexture) {
        shared.withLock {
            $0.now = texture
            $0.newAt = (CACurrentMediaTime() - $0.started) * 1000
        }
    }

    func finish() {
        guard superview != nil else { return }
        shared.withLock { $0.over = true }
        link?.invalidate()
        link = nil
        waveLog.notice("done at \(Int(self.elapsed)) ms: \(self.frames) frames, \(self.late) late, worst gap \(Int(self.worstGap)) ms")
        sound?.end()
        removeFromSuperview()
        onDone?()
        onDone = nil
    }

    /// Over, from the drawing thread: no more frames, and the view goes on the main thread.
    private func end() {
        shared.withLock { $0.over = true }
        DispatchQueue.main.async { [weak self] in self?.finish() }
    }

    func metalDisplayLink(_ link: CAMetalDisplayLink, needsUpdate update: CAMetalDisplayLink.Update) {
        let now = CACurrentMediaTime()
        // the first frame: the clock moves later by however long the first picture took past `holdFrom`
        let state = shared.withLock { s -> Shared in
            if shownAt == nil { s.started += max(0, (now - s.started) * 1000 - WaveClock.holdFrom) / 1000 }
            return s
        }
        if state.over { return }
        let ms = (now - state.started) * 1000
        if let lastDraw {
            let gap = ms - lastDraw
            worstGap = max(worstGap, gap)
            if gap > due * 1.5 { late += 1 }
            if gap > due * 4 { waveLog.notice("a frame \(Int(gap)) ms after the last, at \(Int(ms)) ms") }
        }
        frames += 1
        if shownAt == nil {
            shownAt = ms
            waveLog.notice("first frame at \(Int(ms)) ms")
        }
        lastDraw = ms
        if hold && goAt == nil && !Self.mouseDown() {
            goAt = ms
            waveLog.notice("let go at \(Int(ms)) ms")
        }
        // the button let go (a click: at once), or held so long it pops by itself
        let held = hold ? min(goAt ?? WaveClock.longest, WaveClock.longest) : 0
        let shown = state.newAt ?? state.drawnAt
        if shown == nil && ms > held + wait { return end() }
        // the front leaves then, once there is a new screen to show behind it (the page itself, or a picture of it); until
        // then the screen goes on falling in, never held
        let o = CGPoint(x: origin.x * state.scale, y: origin.y * state.scale)
        var m = WaveClock.at(ms, held: held, release: shown.map { max(held, $0) }, size: state.size, origin: o, scale: state.scale)
        if m.done { return end() }
        // the picture of the new screen, once here, comes in over a few frames
        m.ready = state.newAt.map { Float(min(max((ms - $0) / 120, 0), 1)) } ?? 0
        // the light at the button comes up over the first frames drawn, however late the first picture was
        m.bloom *= Float(1 - pow(1 - min((ms - (shownAt ?? 0)) / 80, 1), 3))
        if m.front < -1e5 {
            sound?.hold(pull: m.pull, wild: m.wild)
        } else if !popped {
            popped = true
            sound?.pop(drawnIn: WaveClock.pull(held, held: held))
            waveLog.notice("pops at \(Int(ms)) ms, held \(Int(held)) ms, drawn in \(m.pull)")
        }
        guard let buffer = renderer.queue.makeCommandBuffer() else { return }
        let pass = MTLRenderPassDescriptor()
        pass.colorAttachments[0].texture = update.drawable.texture
        pass.colorAttachments[0].loadAction = .clear
        pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        pass.colorAttachments[0].storeAction = .store
        renderer.encode(m, size: state.size, origin: o, tint: tint, dark: dark, into: pass, on: buffer, was: was, now: state.now)
        if frames == 1 {
            update.drawable.addPresentedHandler { [weak self] _ in
                DispatchQueue.main.async {
                    self?.onShown?()
                    self?.onShown = nil
                }
            }
        }
        buffer.present(update.drawable)
        buffer.commit()
    }
}
