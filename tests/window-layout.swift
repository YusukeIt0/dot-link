import AppKit

@main enum WindowLayoutTests {
    static func main() {
        _ = NSApplication.shared
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 740), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let screen = NSRect(x: 100, y: 50, width: 520, height: 430)
        let initial = SetupWindowLayout.initialFrame(for: window, within: screen)
        precondition(screen.contains(initial), "Initial frame must fit a small display")
        window.setFrame(initial, display: false)
        let scroll = SetupWindowLayout.install(in: window)
        let longCode = String(repeating: "DEMO-PAIRING-CODE-", count: 120)

        for size in [NSSize(width: 660, height: 740), NSSize(width: 360, height: 300), NSSize(width: 900, height: 800)] {
            window.setContentSize(size)
            let expected = window.frame
            for _ in 0..<10 {
                let stack = NSStackView()
                stack.orientation = .vertical
                stack.alignment = .leading
                stack.spacing = 14
                stack.edgeInsets = NSEdgeInsets(top: 28, left: 32, bottom: 28, right: 32)
                SetupWindowLayout.display(stack, in: scroll)
                let codeView = SetupWindowLayout.pairingCode(longCode)
                stack.addArrangedSubview(codeView.scroll)
                codeView.scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
                for _ in 0..<30 {
                    let text = NSTextField(wrappingLabelWithString: String(repeating: "Long localized setup instructions. ", count: 4))
                    text.setContentCompressionResistancePriority(.required, for: .vertical)
                    stack.addArrangedSubview(text)
                    text.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
                }
                window.contentView!.layoutSubtreeIfNeeded()
                precondition(window.frame == expected, "Rendering must not resize the window")
                precondition(abs(scroll.frame.width - size.width) < 1, "Viewport must follow user resizing")
                precondition(stack.frame.width >= 580, "Narrow windows retain a readable document")
                precondition(stack.frame.width < max(581, size.width + 1), "Long code must not widen the document")
                precondition(stack.frame.height > scroll.contentSize.height, "Long content must scroll vertically")
                precondition(codeView.field.stringValue == longCode, "Long code must remain complete")
                precondition(codeView.scroll.frame.maxX <= stack.frame.width, "Code viewport must fit the document")
                precondition(codeView.scroll.documentView!.frame.width > codeView.scroll.contentSize.width, "Long code must scroll within its own viewport")
                codeView.scroll.contentView.scroll(to: NSPoint(x: 200, y: 0))
                precondition(codeView.scroll.contentView.bounds.minX > 0, "Code can scroll horizontally")
                if size.width < 580 { precondition(stack.frame.width > scroll.contentSize.width, "Narrow windows must scroll horizontally") }
            }
        }
        print("Native window bounds, repeated refresh, resizing, overflow and complete long-code checks passed")
    }
}
