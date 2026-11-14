// Chat mode switched on or off (apps/captions/src/lib/chat-mode.ts washTo): a wave goes through the window's own
// picture. A page can only move its boxes and paint over them; this bends the picture itself. A view over the web view
// shows a picture of the screen as it was, and for half a second that screen falls toward the button, faster and
// faster: what is near the button shrinks into it, what is further is stretched toward it and turns a little round it,
// under a veil of blur and a light that grows at the button. Then it is let go: one wave goes out across the window,
// its front wavering, its crest a ridge of glass (lit and shaded, its colours split where it bends most) that pushes
// the new screen out and lets it settle back after one small trough. Past the settled wave the live page shows.
import AppKit
import Metal
import MetalKit
import WebKit

/// The page's "chatWave" messages for one web view (AppWebView registers it, for the open server's own page only):
/// - `{start: {x, y, dark, tint}}`: a picture of the screen as it is goes over the page, the button at (x, y) in the
///   page's points, `tint` the project's colour as "r g b"; answered true once it is up, false when there is no wave
///   (the page then changes at once)
/// - `"drawn"`: the page has changed under the picture; a picture of the new screen is taken and the front goes. Answered
///   when the wave is over
/// - `"stop"`: chat mode was switched again; the wave goes at once
final class ChatWaveHost {
    private weak var view: WKWebView?
    private var wave: ChatWaveView?
    /// The answer to "drawn", given when the wave is over (or cut short).
    private var drawn: ((Any?, String?) -> Void)?

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
            // The picture of the new screen is taken just before the wave is let go, not now: what the page fills in a
            // moment after the switch (the list of chats, the open chat's messages) is there by then, and the picture
            // of the screen as it was hides the page until that moment anyway.
            let wait = max(0, WaveClock.gather - 140 - wave.elapsed) / 1000
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak view, weak wave] in
                guard let view, let wave, wave.superview != nil else { return }
                view.takeSnapshot(with: nil) { [weak wave] image, _ in
                    guard let wave else { return }
                    if let image = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) { wave.setNew(image) } else { wave.finish() }
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
        wave?.finish()
        guard let view, let renderer = WaveRenderer.shared, let x = start["x"] as? Double, let y = start["y"] as? Double else { return reply(false, nil) }
        let rgb = ((start["tint"] as? String) ?? "").split(separator: " ").compactMap { Float($0) }
        let tint = rgb.count == 3 ? SIMD3(rgb[0], rgb[1], rgb[2]) / 255 : SIMD3<Float>(0.49, 0.23, 0.93)
        let dark = start["dark"] as? Bool ?? false
        // the screen as it is on show now, not after the next update: the page changes only once this is answered
        let config = WKSnapshotConfiguration()
        config.afterScreenUpdates = false
        view.takeSnapshot(with: config) { [weak self] image, _ in
            guard let self, let view = self.view, let image = image?.cgImage(forProposedRect: nil, context: nil, hints: nil),
                  let wave = try? ChatWaveView(over: view, was: image, renderer: renderer, origin: CGPoint(x: x * view.pageZoom, y: y * view.pageZoom), tint: tint, dark: dark)
            else { return reply(false, nil) }
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
};

static float grain(float2 p) { return fract(sin(dot(p, float2(12.9898, 78.233))) * 43758.5453); }

// The wave's height across its front (x in front widths, 0 its middle, below 0 behind it): one crest, then one small
// trough as it settles, as water does.
static float height(float x) {
    return exp(-3.0 * x * x) - 0.32 * exp(-2.2 * (x + 1.35) * (x + 1.35));
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
    if (x < -3.2) return float4(0.0);
    float ahead = smoothstep(-0.4, 0.4, x);
    // The bars at the top (56 points: titleBarHeight in TitleBar.swift, the page's h-14) are the window's own: nothing
    // in them moves, blurs or splits, so the button under the pointer stays put. Below their edge the wave comes in.
    float still = smoothstep(56.0 * pt, 84.0 * pt, p.y);

    // The screen that was falls toward the button: what is near it shrinks into it, what is further is stretched
    // toward it, and all of it turns a little round it. Each point stays so until the front reaches it.
    float sucked = pull * r * exp(-r / reach) * ahead * still;
    float turn = swirl * pull * exp(-r / (0.6 * reach)) * ahead * still;
    // Behind the front the new screen is pushed out by the crest and settles back after one small trough.
    float h = height(x) * still;
    float slope = (height(x + 0.05) - height(x - 0.05)) / 0.1 * still;
    float rs = max(r + sucked - amp * h, 0.0);
    float as = ang + turn;
    float2 ns = float2(cos(as), sin(as));
    float2 ts = float2(-ns.y, ns.x);
    float2 base = o + ns * rs;

    // Out of focus: a veil round the button while the screen falls into it, and the crest of the wave.
    float soft = (veil * pull * exp(-r / (0.8 * reach)) * ahead + 9.0 * pt * abs(h) * (0.4 + 0.6 * flash)) * still;
    // the colours split where the picture bends most
    float sp = split * (abs(slope) * amp * 0.5 + 0.12 * sucked) * still;
    float3 col = float3(0.0);
    int taps = soft < 0.75 ? 1 : 16;
    float spin = grain(p) * 6.2831853;
    for (int k = 0; k < taps; k++) {
        float fk = float(k);
        float ring = taps == 1 ? 0.0 : sqrt((fk + 0.5) / 16.0);
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
    float3 N = normalize(float3(-slope * amp / w * 2.2 * n, 1.0));
    float3 L = normalize(float3(-0.5, -0.6, 0.62));
    float3 Hv = normalize(L + float3(0.0, 0.0, 1.0));
    float spec = pow(max(dot(N, Hv), 0.0), 60.0) * smoothstep(0.02, 0.2, abs(slope) * amp / w * 2.2);
    float facing = dot(N, L) - L.z;
    float rim = pow(1.0 - N.z, 3.0);
    float3 sheen = mix(mix(tint, float3(1.0), 0.55), mix(tint, float3(1.0, 0.86, 0.72), 0.5), 0.5 + 0.5 * sin(ang * 3.0 + slope * 2.0 + time * 3.0));
    if (dark) {
        col += sheen * (spec * 1.4 + rim * 1.2) * flash + tint * max(h, 0.0) * 0.25 * flash;
        col *= 1.0 + facing * 0.6 * flash;
    } else {
        // the shade side in the project's colour, never grey
        col *= mix(float3(1.0), mix(tint, float3(1.0), 0.6), clamp(-min(facing, 0.0) * 0.8 * flash, 0.0, 0.35));
        col = mix(col, float3(1.0), clamp(spec * 1.6 * flash, 0.0, 1.0));
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
    float alpha = smoothstep(-3.2, -2.6, x);
    return float4(clamp(col, 0.0, 1.0) * alpha, alpha);
}
"""

/// Where the wave is at `ms` after the press, for a window `size` px with the button at `origin` px, `scale` px a point.
struct WaveMoment {
    /// How hard the screen is drawn in toward the button (0 to 1), how far round the button that reaches (px), how far
    /// it turns round it (radians), how out of focus it is at the button (px).
    var pull: Float, reach: Float, swirl: Float, veil: Float
    /// The front (px from the button), its width (px), the wave's height (px), the light on it (0 to 1).
    var front: Float, width: Float, wave: Float, flash: Float
    /// The light at the button (up within a few frames of the press, so the press is answered at once), the seconds
    /// since the press (the front's wavering moves with them), how far the colours split.
    var bloom: Float, seconds: Float, split: Float
    /// Pixels a point.
    var px: Float
    var done: Bool
}

enum WaveClock {
    /// The screen falls toward the button, faster and faster (ms); then it is let go and one wave goes out across the
    /// window, fast as it leaves and slowing as it spreads (ms).
    static let gather: Double = 520
    static let sweep: Double = 560

    static func at(_ ms: Double, size: CGSize, origin: CGPoint, scale: CGFloat) -> WaveMoment {
        let s = Float(scale)
        let far = Float(hypot(max(origin.x, size.width - origin.x), max(origin.y, size.height - origin.y)))
        let seconds = Float(ms / 1000)
        let lit = Float(1 - pow(1 - min(ms / 80, 1), 3))
        if ms < gather {
            let g = Float(pow(ms / gather, 2.2))
            return WaveMoment(pull: g, reach: 220 * s, swirl: 0.35, veil: 16 * s, front: -1e6, width: 55 * s, wave: 0, flash: 0,
                              bloom: lit * (0.55 + 0.45 * g), seconds: seconds, split: 0.08, px: s, done: false)
        }
        let u = Float(min((ms - gather) / sweep, 1))
        let width = (55 + 70 * u) * s
        // the front ends past the far corner by all of its wave and the most it wavers
        let front = (1 - pow(1 - u, 1.4)) * (far + 3.8 * 125 * s)
        return WaveMoment(pull: 1, reach: 220 * s, swirl: 0.35, veil: 16 * s, front: front, width: width, wave: 26 * s * (1 - 0.45 * u),
                          flash: 0.25 + 0.75 * exp(-2.2 * u), bloom: max(0, 1 - 4 * u), seconds: seconds, split: 0.08, px: s, done: u >= 1)
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
    private var started = CACurrentMediaTime()
    /// When the picture of the new screen came (the front waits for it, at most `wait` ms after the press).
    private var newAt: Double?
    private let wait: Double = 1000
    var onDone: (() -> Void)?

    init(over view: NSView, was: CGImage, renderer: WaveRenderer, origin: CGPoint, tint: SIMD3<Float>, dark: Bool) throws {
        self.renderer = renderer
        self.origin = origin
        self.tint = tint
        self.dark = dark
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
        isPaused = true
        removeFromSuperview()
        renderer.was = nil
        renderer.now = nil
        onDone?()
        onDone = nil
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        let elapsed = (CACurrentMediaTime() - started) * 1000
        // the front leaves only once there is a new screen to show behind it; the gathering waits for it
        let ms: Double
        if let newAt { ms = max(elapsed - max(0, newAt - WaveClock.gather), 0) } else if elapsed > wait { return finish() } else { ms = min(elapsed, WaveClock.gather) }
        let scale = window?.backingScaleFactor ?? 2
        let size = drawableSize
        let o = CGPoint(x: origin.x * scale, y: origin.y * scale)
        let m = WaveClock.at(ms, size: size, origin: o, scale: scale)
        if m.done { return finish() }
        guard let pass = currentRenderPassDescriptor, let drawable = currentDrawable, let buffer = renderer.queue.makeCommandBuffer() else { return }
        renderer.encode(m, size: size, origin: o, tint: tint, dark: dark, into: pass, on: buffer)
        buffer.present(drawable)
        buffer.commit()
    }
}
