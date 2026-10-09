import AppKit

enum DotStatus: String, CaseIterable {
    case ready, paused, checking, attention

    // Template artwork follows the system menu-bar contrast in light/dark modes.
    // Shapes carry the meaning; no text glyphs, color-only signals, or idle animation.
    func image(rotation: CGFloat = 0) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            NSColor.black.set()
            // Orbit: the same open arc and central Dot used by the app icon.
            let orbit = NSBezierPath()
            orbit.appendArc(withCenter: NSPoint(x: 9, y: 9), radius: 6.4, startAngle: 60 + rotation, endAngle: 345 + rotation)
            orbit.lineWidth = 1.5; orbit.lineCapStyle = .round; orbit.stroke()
            switch self {
            case .ready:
                NSBezierPath(ovalIn: NSRect(x: 6.8, y: 6.8, width: 4.4, height: 4.4)).fill()
            case .paused:
                for x in [6.75, 9.75] {
                    NSBezierPath(roundedRect: NSRect(x: x, y: 6.5, width: 1.5, height: 5), xRadius: 0.5, yRadius: 0.5).fill()
                }
            case .checking:
                let center = NSBezierPath(ovalIn: NSRect(x: 7.25, y: 7.25, width: 3.5, height: 3.5))
                center.lineWidth = 1; center.stroke()
            case .attention:
                NSBezierPath(ovalIn: NSRect(x: 6.8, y: 6.8, width: 4.4, height: 4.4)).fill()
                NSBezierPath(ovalIn: NSRect(x: 13.5, y: 10.4, width: 3, height: 3)).fill()
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "Dot \(rawValue)"
        return image
    }
}
