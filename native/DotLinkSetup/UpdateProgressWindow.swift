import AppKit

// Presentation only. AppUpdater owns the operation and supplies measured progress.
final class UpdateProgressWindow: NSWindowController {
    let stage = NSTextField(wrappingLabelWithString: "")
    let indicator = NSProgressIndicator()
    let actionButton = NSButton()
    private var action: (() -> Void)?
    init() {
        let panel = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 180),
                            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        super.init(window: panel)
        let content = panel.contentView!
        stage.font = .systemFont(ofSize: 15, weight: .medium)
        stage.maximumNumberOfLines = 0
        stage.setContentCompressionResistancePriority(.required, for: .vertical)
        indicator.style = .bar; indicator.minValue = 0; indicator.maxValue = 1
        actionButton.bezelStyle = .rounded; actionButton.target = self; actionButton.action = #selector(invoke)
        for view in [stage, indicator, actionButton] { view.translatesAutoresizingMaskIntoConstraints = false; content.addSubview(view) }
        NSLayoutConstraint.activate([
            stage.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
            stage.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
            stage.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
            indicator.leadingAnchor.constraint(equalTo: stage.leadingAnchor),
            indicator.trailingAnchor.constraint(equalTo: stage.trailingAnchor),
            indicator.topAnchor.constraint(equalTo: stage.bottomAnchor, constant: 20),
            actionButton.trailingAnchor.constraint(equalTo: stage.trailingAnchor),
            actionButton.topAnchor.constraint(greaterThanOrEqualTo: indicator.bottomAnchor, constant: 20),
            actionButton.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -18)
        ])
        panel.center()
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    @objc private func invoke() { action?() }
    func render(title: String, message: String, fraction: Double?, working: Bool,
                actionTitle: String?, action: (() -> Void)?) {
        window?.title = title; stage.stringValue = message
        let textHeight = (message as NSString).boundingRect(with: NSSize(width: 392, height: 1000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: stage.font!]).height
        window?.setContentSize(NSSize(width: 440, height: max(180, ceil(textHeight) + 130)))
        indicator.isHidden = !working
        indicator.isIndeterminate = fraction == nil
        if let fraction { indicator.stopAnimation(nil); indicator.doubleValue = min(1, max(0, fraction)) }
        else if working { indicator.startAnimation(nil) } else { indicator.stopAnimation(nil) }
        indicator.setAccessibilityLabel(message)
        actionButton.title = actionTitle ?? ""; actionButton.isHidden = actionTitle == nil
        self.action = action
        window?.contentView?.layoutSubtreeIfNeeded()
    }
    func present() { showWindow(nil); window?.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
}
