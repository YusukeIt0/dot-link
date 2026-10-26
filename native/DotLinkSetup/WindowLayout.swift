import AppKit

final class SetupClipView: NSClipView { override var isFlipped: Bool { true } }

final class SetupScrollView: NSScrollView {
    var documentWidth: NSLayoutConstraint?
    override func layout() {
        documentWidth?.constant = max(580, contentSize.width)
        super.layout()
        if let document = documentView {
            document.setFrameSize(NSSize(width: max(580, contentSize.width), height: document.fittingSize.height))
        }
    }
}

// Keep the window independent of the document's intrinsic size. A refreshed
// document can overflow the viewport, but must never resize its owning window.
enum SetupWindowLayout {
    static func pairingCode(_ code: String) -> (scroll: NSScrollView, field: NSTextField) {
        let field = NSTextField(labelWithString: code)
        field.isSelectable = true
        field.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        field.cell?.usesSingleLineMode = true
        field.sizeToFit()
        field.setFrameOrigin(NSPoint(x: 8, y: 6))
        let document = NSView(frame: NSRect(x: 0, y: 0, width: field.frame.width + 16, height: field.frame.height + 12))
        document.addSubview(field)
        let scroll = NSScrollView()
        scroll.borderType = .bezelBorder
        scroll.hasHorizontalScroller = true
        scroll.drawsBackground = true
        scroll.backgroundColor = .textBackgroundColor
        scroll.documentView = document
        scroll.heightAnchor.constraint(equalToConstant: 48).isActive = true
        return (scroll, field)
    }

    static func install(in window: NSWindow) -> NSScrollView {
        let scroll = SetupScrollView(frame: window.contentView!.bounds)
        scroll.autoresizingMask = [.width, .height]
        scroll.contentView = SetupClipView()
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = true
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        window.contentView!.addSubview(scroll)
        return scroll
    }

    static func display(_ document: NSView, in scroll: NSScrollView) {
        document.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = document
        let width = document.widthAnchor.constraint(equalToConstant: max(580, scroll.contentSize.width))
        width.isActive = true
        (scroll as? SetupScrollView)?.documentWidth = width
        scroll.needsLayout = true
    }

    static func initialFrame(for window: NSWindow, within visible: NSRect) -> NSRect {
        let preferred = window.frameRect(forContentRect: NSRect(x: 0, y: 0, width: 660, height: 740))
        let width = min(preferred.width, visible.width)
        let height = min(preferred.height, visible.height)
        return NSRect(x: visible.midX - width / 2, y: visible.midY - height / 2, width: width, height: height)
    }
}

