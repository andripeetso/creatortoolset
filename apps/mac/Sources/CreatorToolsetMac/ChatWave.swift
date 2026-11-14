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
final class ChatWaveHost {
    private weak var view: WKWebView?
    private var wave: ChatWaveView?
    /// The answer to "drawn", given when the wave is over (or cut short).
    private var drawn: ((Any?, String?) -> Void)?
    /// The page is from before holding (it says nothing of `hold`): its own entrances still run after the switch.
    private var oldPage = false

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
            // the page has finished its own entrances by now (chat-mode.ts macWash): what it shows is the new screen. A
            // page from before that is given until 420 ms after the press, as it was then (what fades in is there by then)
            let wait = oldPage ? max(0, 420 - wave.elapsed) / 1000 : 0
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak view, weak wave] in
                guard let view, let wave, wave.superview != nil else { return }
                view.takeSnapshot(with: nil) { [weak wave] image, _ in
                    guard let wave, wave.superview != nil else { return }
                    if let image = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) { wave.setNew(image) } else { wave.finish() }
                    waveLog.notice("new screen's picture at \(Int(wave.elapsed)) ms")
                }
            }
        case "stop":
            wave?.finish()
            reply(true, nil)
        default:
            reply(nil, "unknown")
        }
    }

    private func begin(_ start: [String: Any], _ reply: @escaping (Any?, String?) -> Void) {
        // the press, as near as the app can tell: the page asks as the mouse goes down
        let pressed = CACurrentMediaTime()
        wave?.finish()
        guard let view, let renderer = WaveRenderer.shared, let x = start["x"] as? Double, let y = start["y"] as? Double else { return reply(false, nil) }
        let rgb = ((start["tint"] as? String) ?? "").split(separator: " ").compactMap { Float($0) }
        let tint = rgb.count == 3 ? SIMD3(rgb[0], rgb[1], rgb[2]) / 255 : SIMD3<Float>(0.49, 0.23, 0.93)
        let dark = start["dark"] as? Bool ?? false
        // (a page from before holding sends none: a click)
        let hold = start["hold"] as? Bool ?? false
        oldPage = start["hold"] == nil
        waveLog.notice("start: hold \(hold), mouse down \(ChatWaveView.mouseDown()), page from before holding \(self.oldPage)")
        // the screen as it is on show now, not after the next update: the page changes only once this is answered
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        view.takeSnapshot(with: config) { [weak self] image, _ in
            guard let self, let view = self.view, let image = image?.cgImage(forProposedRect: nil, context: nil, hints: nil),
                  let wave = try? ChatWaveView(over: view, was: image, renderer: renderer, origin: CGPoint(x: x * view.pageZoom, y: y * view.pageZoom), tint: tint, dark: dark, hold: hold, pressed: pressed)
            else {
                waveLog.notice("no wave: no picture of the screen")
                return reply(false, nil)
            }
            waveLog.notice("up at \(Int(wave.elapsed)) ms")
            self.wave = wave
            wave.onDone = { [weak self] in
                self?.wave = nil
                self?.drawn?(true, nil)
                self?.drawn = nil
            }
            reply(true, nil)
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
    // The bars at the top (56 points: titleBarHeight in TitleBar.swift, the page's h-14) are the window's own: nothing
    // in them moves, blurs or splits, so the button under the pointer stays put. Below their edge the wave comes in.
    float still = smoothstep(56.0 * pt, 84.0 * pt, p.y);

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
        col += mix(B, A, ahead);
    }
    col /= float(taps);

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
    if (dark) {
        col += sheen * (spec * 1.4 + rim * 1.2) * flash + tint * max(h, 0.0) * (0.25 + 0.3 * wild) * flash;
        col *= 1.0 + facing * 0.6 * flash;
    } else {
        // the shade side in the project's colour, never grey
        col *= mix(float3(1.0), mix(tint, float3(1.0), 0.6), clamp(-min(facing, 0.0) * 0.8 * flash, 0.0, 0.35));
        col = mix(col, float3(1.0), clamp(spec * 1.2 * flash, 0.0, 1.0));
        col = mix(col, sheen, clamp((rim * 1.2 + max(h, 0.0) * 0.18) * flash, 0.0, 0.45));
    }
    // the light at the button: a white core in a halo of the project's colour
    float core = exp(-(r * r) / (2116.0 * pt * pt));
    float halo = exp(-r / (110.0 * pt));
    if (dark) {
        col = 1.0 - (1.0 - col) * (1.0 - clamp((float3(core * 0.9) + tint * halo * 0.6) * bloom, 0.0, 1.0));
    } else {
        col = mix(col, mix(tint, float3(1.0), 0.35), clamp(halo * 0.45 * bloom, 0.0, 1.0));
        col = mix(col, float3(1.0), clamp(core * 0.85 * bloom, 0.0, 1.0));
    }
    // a fine grain in what is out of focus, like frosted glass
    col += (grain(p + time) - 0.5) * 0.05 * clamp(soft / (8.0 * pt), 0.0, 1.0);
    // the wave's last ridges fade into the page as it ends, so it is never taken away at once
    float alpha = smoothstep(-4.6, -3.9, x) * u.f.x;
    return float4(clamp(col, 0.0, 1.0) * alpha, alpha);
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
        // at the speed it had, slowing over 300 ms; a press little longer than a click (quick to fall in, with little
        // drawn in yet) slows sooner, so it goes on by no more than it drew in and stays all but a click
        let speed = deep(held) - deep(held - 1)
        let slows = speed > 0 ? min(300, deep(held) / speed) : 300
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
        try loader.newTexture(cgImage: image, options: [.SRGB: false, .textureUsage: MTLTextureUsage.shaderRead.rawValue, .textureStorageMode: MTLStorageMode.private.rawValue])
    }

    func encode(_ m: WaveMoment, size: CGSize, origin: CGPoint, tint: SIMD3<Float>, dark: Bool,
                into pass: MTLRenderPassDescriptor, on buffer: MTLCommandBuffer) {
        guard let was, let enc = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
        var u: [SIMD4<Float>] = [
            SIMD4(Float(size.width), Float(size.height), Float(origin.x), Float(origin.y)),
            SIMD4(m.pull, m.reach, m.swirl, m.veil),
            SIMD4(m.front, m.width, m.wave, m.flash),
            SIMD4(tint.x, tint.y, tint.z, dark ? 1 : 0),
            SIMD4(m.bloom, m.seconds, m.px, m.split),
            SIMD4(m.left, m.lit, m.back, m.wild),
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

/// The wave over the web view while it runs; takes no clicks, and goes when the front has left the window.
final class ChatWaveView: MTKView, MTKViewDelegate {
    private let renderer: WaveRenderer
    private let origin: CGPoint
    private let tint: SIMD3<Float>
    private let dark: Bool
    /// When the button was pressed (moved later by however long the first picture took past `holdFrom`, so the pull
    /// starts from nothing on the first frame drawn), and that first frame (ms).
    private var started: CFTimeInterval
    private var shownAt: Double?
    private var popped = false
    /// When the picture of the new screen came (the front waits for it, at most `wait` ms after it would have gone).
    private var newAt: Double?
    private let wait: Double = 1000
    /// The mouse went down on the button: the screen falls in until its button comes up (`goAt`, ms), at most
    /// `WaveClock.longest`.
    private let hold: Bool
    private var goAt: Double?
    /// Whether the mouse button is down now (a test sets its own).
    static var mouseDown: () -> Bool = { NSEvent.pressedMouseButtons & 1 != 0 }
    var onDone: (() -> Void)?

    init(over view: NSView, was: CGImage, renderer: WaveRenderer, origin: CGPoint, tint: SIMD3<Float>, dark: Bool, hold: Bool,
         pressed: CFTimeInterval = CACurrentMediaTime()) throws {
        started = pressed
        self.renderer = renderer
        self.origin = origin
        self.tint = tint
        self.dark = dark
        self.hold = hold
        renderer.was = try renderer.texture(was)
        renderer.now = nil
        super.init(frame: view.bounds, device: renderer.device)
        autoresizingMask = [.width, .height]
        colorPixelFormat = .bgra8Unorm
        framebufferOnly = true
        clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
        layer?.isOpaque = false
        (layer as? CAMetalLayer)?.colorspace = was.colorSpace
        preferredFramesPerSecond = NSScreen.main?.maximumFramesPerSecond ?? 60
        delegate = self
        view.addSubview(self)
    }

    @available(*, unavailable)
    required init(coder: NSCoder) { fatalError("not used") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// Milliseconds since the wave went up.
    var elapsed: Double { (CACurrentMediaTime() - started) * 1000 }

    func setNew(_ image: CGImage) {
        renderer.now = try? renderer.texture(image)
        newAt = (CACurrentMediaTime() - started) * 1000
    }

    func finish() {
        guard superview != nil else { return }
        waveLog.notice("done at \(Int(self.elapsed)) ms")
        isPaused = true
        removeFromSuperview()
        renderer.was = nil
        renderer.now = nil
        onDone?()
        onDone = nil
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        var ms = (CACurrentMediaTime() - started) * 1000
        if shownAt == nil {
            started += max(0, ms - WaveClock.holdFrom) / 1000
            ms = (CACurrentMediaTime() - started) * 1000
            shownAt = ms
            waveLog.notice("first frame at \(Int(ms)) ms")
        }
        if hold && goAt == nil && !Self.mouseDown() {
            goAt = ms
            waveLog.notice("let go at \(Int(ms)) ms")
        }
        // the button let go (a click: at once), or held so long it pops by itself
        let held = hold ? min(goAt ?? WaveClock.longest, WaveClock.longest) : 0
        if newAt == nil && ms > held + wait { return finish() }
        // the front leaves then, once there is a new screen to show behind it; until then the screen goes on falling in,
        // never held
        let scale = window?.backingScaleFactor ?? 2
        let size = drawableSize
        let o = CGPoint(x: origin.x * scale, y: origin.y * scale)
        var m = WaveClock.at(ms, held: held, release: newAt.map { max(held, $0) }, size: size, origin: o, scale: scale)
        if m.done { return finish() }
        // the light at the button comes up over the first frames drawn, however late the first picture was
        m.bloom *= Float(1 - pow(1 - min((ms - (shownAt ?? 0)) / 80, 1), 3))
        if !popped && m.front > -1e5 {
            popped = true
            waveLog.notice("pops at \(Int(ms)) ms, held \(Int(held)) ms, drawn in \(m.pull)")
        }
        guard let pass = currentRenderPassDescriptor, let drawable = currentDrawable, let buffer = renderer.queue.makeCommandBuffer() else { return }
        renderer.encode(m, size: size, origin: o, tint: tint, dark: dark, into: pass, on: buffer)
        buffer.present(drawable)
        buffer.commit()
    }
}
