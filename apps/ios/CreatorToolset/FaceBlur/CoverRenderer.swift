// Face Blur engine (Cover.swift says what this folder is): drawing covers onto a frame.
import CoreImage
import CoreImage.CIFilterBuiltins

/// Paints covers onto an upright frame; photo and video export both call this. Every cover is a circle of radius
/// r = max(w·W, h·H)/2, the interior out to r − feather/2 is always fully covered, and the soft edge is centred on r.
final class CoverRenderer: @unchecked Sendable {
    static let shared = CoverRenderer()

    /// Renders every cover active at `time`, in array order. Later covers see
    /// earlier ones, like layers.
    func render(_ source: CIImage, covers: [Cover], time: Double) -> CIImage {
        let frame = source.extent
        guard frame.width > 0, frame.height > 0 else { return source }
        // Work with the frame at the origin so normalized coordinates map
        // directly to pixels.
        var image = source.transformed(by: CGAffineTransform(translationX: -frame.minX, y: -frame.minY))
        let bounds = CGRect(origin: .zero, size: frame.size)
        for cover in covers {
            guard let placement = cover.placement(at: time) else { continue }
            let opacity = cover.opacity(at: time)
            guard opacity > 0.001 else { continue }
            image = paint(cover, rect: placement.rect, opacity: opacity, on: image, bounds: bounds)
        }
        return image.cropped(to: bounds)
            .transformed(by: CGAffineTransform(translationX: frame.minX, y: frame.minY))
    }

    /// Circle geometry in Core Image space (origin bottom-left).
    struct Circle {
        var center: CGPoint
        var radius: CGFloat
    }

    static func circle(for rect: NormRect, in size: CGSize) -> Circle {
        let r = CGFloat(rect.diameter(in: size) / 2)
        return Circle(
            center: CGPoint(x: rect.cx * size.width, y: (1 - rect.cy) * size.height),
            radius: max(1, r)
        )
    }

    /// How far the soft edge reaches past the circle at full softness, as a fraction of the radius.
    static let maxFeather: CGFloat = 0.7

    private func paint(_ cover: Cover, rect: NormRect, opacity: Double = 1, on image: CIImage, bounds: CGRect) -> CIImage {
        let circle = Self.circle(for: rect, in: bounds.size)
        let r = circle.radius
        let softness = min(1, max(0, cover.softness))
        let strength = min(1, max(0, cover.strength))
        // the default (0.45) fades over about a third of the radius, centred on the cover's edge, so it grows the cover little
        let feather = r * Self.maxFeather * CGFloat(softness)

        switch cover.look {
        case .solid:
            let color = Self.color(hex: cover.colorHex) ?? CIColor(red: 0.2, green: 0.2, blue: 0.2)
            let fill = CIImage(color: color).cropped(to: bounds)
            return blend(fill, over: image, circle: circle, feather: feather, opacity: opacity, bounds: bounds)

        case .blur:
            let effect = blurred(image, circle: circle, strength: strength, feather: feather, bounds: bounds)
            return blend(effect, over: image, circle: circle, feather: feather, opacity: opacity, bounds: bounds)

        case .mosaic:
            let effect = mosaic(image, circle: circle, strength: strength, feather: feather, bounds: bounds)
            return blend(effect, over: image, circle: circle, feather: feather, opacity: opacity, bounds: bounds)
        }
    }

    /// The square around the circle plus the feather, clipped to the frame.
    private func workRegion(_ circle: Circle, pad: CGFloat, bounds: CGRect) -> CGRect {
        let extent = circle.radius + pad
        return CGRect(x: circle.center.x - extent, y: circle.center.y - extent, width: extent * 2, height: extent * 2)
            .integral
            .intersection(bounds)
    }

    /// Gaussian blur with σ = max(2, r / (1.2 + 3·(1 − strength))). The region
    /// is averaged into blocks of σ/2 first, which throws away the fine detail
    /// a deblurring tool would need while looking the same once blurred.
    private func blurred(_ image: CIImage, circle: Circle, strength: Double, feather: CGFloat, bounds: CGRect) -> CIImage {
        let r = circle.radius
        let sigma = max(2, r / (1.2 + 3 * CGFloat(1 - strength)))
        let region = workRegion(circle, pad: ceil(feather + 2) + sigma * 2, bounds: bounds)
        guard !region.isEmpty else { return image }
        let patch = image.cropped(to: region).clampedToExtent()
        let scrambled = averaged(patch, block: max(1, sigma / 2), origin: region.origin, region: region, smooth: true)
        return scrambled
            .clampedToExtent()
            .applyingGaussianBlur(sigma: Double(sigma))
            .cropped(to: region)
    }

    /// Mosaic with blocks = 14 − 8·strength across the diameter (10 at 0.5: about 9 across the face, as the AI Editor's
    /// step drew it), each filled with its average colour. The grid starts at
    /// the circle's top-left, so the pattern stays put while a cover sits still.
    private func mosaic(_ image: CIImage, circle: Circle, strength: Double, feather: CGFloat, bounds: CGRect) -> CIImage {
        let r = circle.radius
        let blocks = 14 - 8 * CGFloat(strength)
        let cell = max(1, (2 * r / blocks).rounded())
        let region = workRegion(circle, pad: ceil(feather + 2), bounds: bounds)
        guard !region.isEmpty else { return image }
        let origin = CGPoint(x: circle.center.x - r, y: circle.center.y + r)
        let patch = image.cropped(to: region).clampedToExtent()
        return averaged(patch, block: cell, origin: origin, region: region, smooth: false)
            .cropped(to: region)
    }

    /// Averages `image` into square blocks aligned to `origin`, then scales it
    /// back up. `smooth` uses linear upsampling (for blur), otherwise nearest
    /// (visible mosaic squares).
    private func averaged(_ image: CIImage, block: CGFloat, origin: CGPoint, region: CGRect, smooth: Bool) -> CIImage {
        guard block > 1 else { return image }
        let toGrid = CGAffineTransform(translationX: -origin.x, y: -origin.y)
        // Cover the region with whole cells in grid space.
        let local = region.applying(toGrid)
        let gridRect = CGRect(
            x: floor(local.minX / block) * block,
            y: floor(local.minY / block) * block,
            width: (ceil(local.maxX / block) - floor(local.minX / block)) * block,
            height: (ceil(local.maxY / block) - floor(local.minY / block)) * block
        )
        let shifted = image.transformed(by: toGrid).cropped(to: gridRect)
        // Box-filter down by integer-free scaling: CIAreaAverage per cell is
        // too slow, but a Lanczos downscale of a clamped patch averages well.
        let lanczos = CIFilter.lanczosScaleTransform()
        lanczos.inputImage = shifted.clampedToExtent().cropped(to: gridRect)
        lanczos.scale = Float(1 / block)
        lanczos.aspectRatio = 1
        guard let small = lanczos.outputImage else { return image }
        let smallRect = CGRect(
            x: (gridRect.minX / block).rounded(),
            y: (gridRect.minY / block).rounded(),
            width: (gridRect.width / block).rounded(),
            height: (gridRect.height / block).rounded()
        )
        let cells = small.cropped(to: smallRect).clampedToExtent()
        let up = (smooth ? cells.samplingLinear() : cells.samplingNearest())
            .transformed(by: CGAffineTransform(scaleX: block, y: block))
        return up.transformed(by: toGrid.inverted())
    }

    /// Composites `effect` over `image` inside the circle: fully opaque out to
    /// r − feather/2, then a smoothstep fade to r + feather/2 (or a 1px
    /// anti-aliased edge when there's no feather).
    private func blend(_ effect: CIImage, over image: CIImage, circle: Circle, feather: CGFloat, opacity: Double, bounds: CGRect) -> CIImage {
        let inner = max(1, circle.radius - feather / 2)
        let outer = circle.radius + max(1, feather / 2)
        let gradient = CIFilter.radialGradient()
        gradient.center = circle.center
        gradient.radius0 = Float(inner)
        gradient.radius1 = Float(outer)
        gradient.color0 = CIColor(red: CGFloat(opacity), green: CGFloat(opacity), blue: CGFloat(opacity), alpha: 1)
        gradient.color1 = CIColor(red: 0, green: 0, blue: 0, alpha: 1)
        let maskRect = CGRect(
            x: circle.center.x - outer, y: circle.center.y - outer,
            width: outer * 2, height: outer * 2
        ).intersection(bounds)
        // smoothstep, not a straight ramp: a linear fade over the squares reads as a hard edge
        let curve = CIFilter.toneCurve()
        curve.inputImage = gradient.outputImage
        curve.point0 = CGPoint(x: 0, y: 0)
        curve.point1 = CGPoint(x: 0.25, y: 0.156)
        curve.point2 = CGPoint(x: 0.5, y: 0.5)
        curve.point3 = CGPoint(x: 0.75, y: 0.844)
        curve.point4 = CGPoint(x: 1, y: 1)
        guard let mask = curve.outputImage?.cropped(to: maskRect), !maskRect.isEmpty else { return image }
        let blend = CIFilter.blendWithMask()
        blend.inputImage = effect.cropped(to: maskRect)
        blend.backgroundImage = image
        blend.maskImage = mask
        return blend.outputImage ?? image
    }

    /// "#rrggbb" as a colour; nil for anything else.
    static func color(hex: String) -> CIColor? {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        return CIColor(red: CGFloat((value >> 16) & 0xFF) / 255, green: CGFloat((value >> 8) & 0xFF) / 255, blue: CGFloat(value & 0xFF) / 255)
    }
}
