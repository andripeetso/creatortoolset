// Chat mode switched on or off (apps/captions/src/lib/chat-mode.ts washTo): a wave goes through the window's own
// picture. A page can only move its boxes and paint over them; this bends the picture itself. A view over the web view
// shows a picture of the screen as it was, gathers it toward the button for a moment, then lets one front go out across
// the window. At the front the picture is drawn in toward the button, blurred a little, its colours split a little
// where it bends most, and lit in the project's colour. Behind the front is the new screen: a picture of it where the
// front still bends it, the live page past that. Nothing is drawn behind the front once it has passed.
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
            view.takeSnapshot(with: nil) { [weak wave] image, _ in
                guard let wave else { return }
                if let image = image?.cgImage(forProposedRect: nil, context: nil, hints: nil) { wave.setNew(image) } else { wave.finish() }
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
    float4 b;   // front (px from the button), half width of the front (px), how far it bends (px), colour split
    float4 c;   // gathered (0 to 1), how far round the button that reaches (px), light (0 to 1), blur (px)
    float4 d;   // the project's colour (0 to 1), 1 on a dark screen
    float4 e;   // the light at the button (0 to 1)
};

fragment float4 waveFragment(V in [[stage_in]], constant U &u [[buffer(0)]],
                             texture2d<float> was [[texture(0)]], texture2d<float> now [[texture(1)]]) {
    constexpr sampler sm(address::clamp_to_edge, filter::linear);
    float2 size = u.a.xy, o = u.a.zw;
    float front = u.b.x, w = u.b.y, bend = u.b.z, split = u.b.w;
    float gather = u.c.x, reach = u.c.y, light = u.c.z, blur = u.c.w;
    float3 tint = u.d.xyz;
    float dark = u.d.w;

    float2 p = in.uv * size;
    float2 v = p - o;
    float r = max(length(v), 0.001);
    float2 n = v / r;
    float2 t = float2(-n.y, n.x);
    // where this point is against the front: below 0 the new screen, above 0 the one that was
    float x = (r - front) / w;
    float lens = exp(-2.2 * x * x);
    // gathering: the screen round the button is drawn in toward it, most a little way out, none at the button itself
    float near = exp(-(r * r) / (reach * reach));
    float pull = gather * near;
    // well behind the front: the page itself shows
    if (x < -2.4 && pull < 0.002) return float4(0.0);

    // how far toward the button this point's picture is drawn from (the screen is pulled in, never pushed out)
    float lensShift = bend * lens;
    float shift = lensShift + 0.22 * gather * r * near;
    // out of focus where the two screens meet, so they dissolve into each other and no text is seen twice
    float soft = blur * (exp(-5.0 * x * x) + 0.35 * pull);
    float m = smoothstep(-0.3, 0.3, x);
    float3 col = float3(0.0);
    float total = 0.0;
    // the middle and two rings round it, longer along the way the front goes
    for (int k = 0; k < 13; k++) {
        float ring = k == 0 ? 0.0 : (k < 7 ? 0.5 : 1.0);
        float ang = float(k) * 1.0472 + (k < 7 ? 0.0 : 0.5236);
        float2 off = (n * cos(ang) * 1.6 + t * sin(ang)) * soft * ring;
        float wk = k == 0 ? 1.0 : (k < 7 ? 0.8 : 0.5);
        // each colour bent a little more or less than the next, only where the front bends the picture
        float3 at = shift + float3(1.0, 0.0, -1.0) * split * lensShift;
        float2 base = p + off;
        float2 qr = (base + n * at.r) / size, qg = (base + n * at.g) / size, qb = (base + n * at.b) / size;
        float3 a = float3(was.sample(sm, qr).r, was.sample(sm, qg).g, was.sample(sm, qb).b);
        float3 b = float3(now.sample(sm, qr).r, now.sample(sm, qg).g, now.sample(sm, qb).b);
        col += mix(b, a, m) * wk;
        total += wk;
    }
    col /= total;

    // the light rides just behind the middle of the front; while the screen gathers it is a small glow at the button
    // A wide halo in the project's colour and a narrow core near white: on a dark screen the light, on a light one a
    // sheen over what the front bends
    float bloom = u.e.x * exp(-(r * r) / (0.09 * reach * reach));
    float halo = clamp(light * (exp(-2.8 * (x + 0.15) * (x + 0.15)) + bloom), 0.0, 1.0);
    float core = clamp(light * (exp(-16.0 * (x + 0.08) * (x + 0.08)) + 0.6 * bloom * bloom), 0.0, 1.0);
    if (dark > 0.5) {
        float3 l = tint * halo * 0.42 + mix(tint, float3(1.0), 0.7) * core * 0.5;
        col = 1.0 - (1.0 - col) * (1.0 - clamp(l, 0.0, 1.0));
    } else {
        col = mix(col, mix(tint, float3(1.0), 0.45), halo * 0.32);
        col = mix(col, float3(1.0), core * 0.45);
    }
    float alpha = smoothstep(-2.4, -1.6, x);
    alpha = max(alpha, step(0.002, pull));
    return float4(col * alpha, alpha);
}
"""

/// Where the wave is at `ms` after the press, for a window `size` px with the button at `origin` px, `scale` px a point.
struct WaveMoment {
    var front: Float, width: Float, bend: Float, split: Float
    var gather: Float, reach: Float, light: Float, blur: Float
    /// The light at the button: up within a few frames of the press, so the press is answered at once.
    var bloom: Float = 0
    var done: Bool
}

enum WaveClock {
    /// The screen gathers toward the button (ms), then the front crosses the window (ms): slow to leave, fast at the end.
    static let gather: Double = 200
    static let sweep: Double = 600

    static func at(_ ms: Double, size: CGSize, origin: CGPoint, scale: CGFloat) -> WaveMoment {
        let s = Float(scale)
        let far = Float(hypot(max(origin.x, size.width - origin.x), max(origin.y, size.height - origin.y)))
        let smooth = { (e0: Double, e1: Double, v: Double) -> Float in
            let t = min(max((v - e0) / (e1 - e0), 0), 1)
            return Float(t * t * (3 - 2 * t))
        }
        // the light at the button: up at once, and gone into the front as it leaves
        let lit = Float(1 - pow(1 - min(ms / 80, 1), 3))
        if ms < gather {
            let g = smooth(0, gather, ms)
            return WaveMoment(front: -1e6, width: 70 * s, bend: 0, split: 0.07, gather: g, reach: 260 * s, light: 0.8, blur: 10 * s, bloom: lit, done: false)
        }
        let u = Float(min((ms - gather) / sweep, 1))
        let width = (70 + 50 * u) * s
        // the front's middle ends past the far corner by the part of the front that still bends the picture
        let front = (0.3 * u + 0.7 * u * u) * (far + 2.4 * width)
        let held = 1 - smooth(0, 0.3, Double(u))
        return WaveMoment(front: front, width: width, bend: 22 * s * smooth(0, 0.12, Double(u)), split: 0.07,
                          gather: held, reach: 260 * s, light: 0.8 * (1 - 0.4 * u), blur: 10 * s, bloom: held, done: u >= 1)
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
            SIMD4(m.front, m.width, m.bend, m.split),
            SIMD4(m.gather, m.reach, m.light, m.blur),
            SIMD4(tint.x, tint.y, tint.z, dark ? 1 : 0),
            SIMD4(m.bloom, 0, 0, 0),
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
    private let wait: Double = 700
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
