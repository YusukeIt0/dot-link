import AppKit

final class SetupClipView: NSClipView { override var isFlipped: Bool { true } }

// Native help remains available to pointer, keyboard and accessibility users.
final class HelpButton: NSButton {
    private var explanation = ""
    private var popover: NSPopover?
    convenience init(_ title: String, _ text: String) {
        self.init(title: "", target: nil, action: #selector(showExplanation))
        bezelStyle = .helpButton; target = self; explanation = text; toolTip = text
        setAccessibilityLabel(title); setAccessibilityHelp(text)
    }
    @objc private func showExplanation() {
        if let popover, popover.isShown { popover.close(); return }
        let controller = NSViewController(); controller.view = NSView()
        let text = NSTextField(wrappingLabelWithString: explanation)
        text.font = .systemFont(ofSize: 13); text.isSelectable = true; text.translatesAutoresizingMaskIntoConstraints = false
        controller.view.addSubview(text)
        NSLayoutConstraint.activate([text.leadingAnchor.constraint(equalTo: controller.view.leadingAnchor, constant: 18), text.trailingAnchor.constraint(equalTo: controller.view.trailingAnchor, constant: -18), text.topAnchor.constraint(equalTo: controller.view.topAnchor, constant: 16), text.bottomAnchor.constraint(equalTo: controller.view.bottomAnchor, constant: -16), text.widthAnchor.constraint(equalToConstant: 280)])
        let p = NSPopover(); p.behavior = .transient; p.contentViewController = controller
        p.contentSize = controller.view.fittingSize; popover = p
        p.show(relativeTo: bounds, of: self, preferredEdge: .minX)
    }
}

final class ActionButton: NSButton {
    var handler: (() -> Void)?
    convenience init(_ title: String, _ action: @escaping () -> Void) {
        self.init(title: title, target: nil, action: #selector(invoke))
        handler = action; target = self; bezelStyle = .rounded
    }
    @objc func invoke() { handler?() }
}

final class SetupApp: NSObject, NSApplicationDelegate, NSWindowDelegate {
    var appUpdater: AppUpdater?
    var orbitTimer: Timer?
    var orbitAngle: CGFloat = 0
    var window: NSWindow!
    var statusItem: NSStatusItem!
    var stack: NSStackView!
    var state: [String: Any] = [:]
    var notifications: NotificationController?
    var showingNotifications = false
    var showingPairing = false
    var showingDetails = false
    var allowTermination = false
    var quitting = false
    var automaticResumePending = false
    var currentAction = ""
    var lastChecked: Date?
    var migratingNotifications = false
    var busy = false
    var helper: Process?
    var message = ""
    var progressLabel: NSTextField?
    var progress: NSProgressIndicator?
    var tunnelID = ""
    var tunnelField: NSTextField?
    var secretField: NSTextField?
    var originField: NSTextField?
    var originValue = ""
    var pairingCode: String?
    var pairingExpiry: Double = 0
    var codeField: NSTextField?
    var expiryLabel: NSTextField?
    var copyButton: NSButton?
    var timer: Timer?
    var language = UserDefaults.standard.string(forKey: "setupLanguage") ?? (Locale.preferredLanguages.first?.hasPrefix("ja") == true ? "ja" : "en")
    let payload = Bundle.main.resourceURL!.appendingPathComponent("payload")
    var step: String { state["step"] as? String ?? "checking" }
    func tr(_ ja: String, _ en: String) -> String { language == "ja" ? ja : en }
    func yes(_ key: String) -> Bool { state[key] as? Bool == true }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let relaunchAt = UserDefaults.standard.double(forKey: "updateBackgroundRelaunchAt")
        let quietUpdate = relaunchAt > 0 && Date().timeIntervalSince1970 - relaunchAt < 600
        UserDefaults.standard.removeObject(forKey: "updateBackgroundRelaunchAt")
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        updateMenu()
        let menu = NSMenu(); let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appMenu.addItem(withTitle: tr("Dot Linkを終了", "Quit Dot Link"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appItem.submenu = appMenu
        let editItem = NSMenuItem(title: tr("編集", "Edit"), action: nil, keyEquivalent: ""); menu.addItem(editItem)
        let edit = NSMenu(); edit.addItem(withTitle: tr("コピー", "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c"); edit.addItem(withTitle: tr("ペースト", "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v"); edit.addItem(withTitle: tr("すべてを選択", "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"); editItem.submenu = edit; NSApp.mainMenu = menu
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 740), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.minSize = NSSize(width: 580, height: 620); window.title = "Dot Link"; window.delegate = self; window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true; window.backgroundColor = .windowBackgroundColor
        window.center(); render(); if !CommandLine.arguments.contains("--background") && !quietUpdate { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        automaticResumePending = !CommandLine.arguments.contains("--background")
        configureUpdater()
        perform("update-recover")
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateExpiry() }
    }
    func configureUpdater() {
        let updater = AppUpdater(); appUpdater = updater
        updater.tr = { [weak self] ja, en in self?.tr(ja, en) ?? ja }
        updater.canCheck = { [weak self] in guard let self else { return false }; return self.yes("installed") && !self.busy && Bundle.main.bundleURL.path == NSHomeDirectory() + "/Applications/Dot Link.app" }
        updater.changed = { [weak self] in self?.refreshUpdateAnimation(); self?.updateMenu() }
        updater.prepare = { [weak self] reply in
            guard let self, !self.busy else { reply("waiting"); return }
            self.notifications?.setRelaySuspended(true)
            self.updateHelper("update-prepare") { result in
                if result["prepared"] as? Bool == true { self.notifications?.setRelaySuspended(true); reply("prepared") } else { self.notifications?.setRelaySuspended(self.yes("lifecycleStopped") || !self.yes("bridge")); reply(result["waiting"] as? Bool == true ? "waiting" : "failed") }
            }
        }
        updater.recover = { [weak self] in self?.updateHelper("update-abort") { _ in self?.inspect() } }
        updater.start()
    }
    func updateHelper(_ action: String, completion: @escaping ([String: Any]) -> Void) {
        let p = Process(); p.executableURL = payload.appendingPathComponent(".runtime/bin/node")
        p.arguments = [payload.appendingPathComponent("scripts/mac-setup.mjs").path, action]
        let output = Pipe(); p.standardOutput = output; p.standardError = FileHandle.nullDevice; p.standardInput = FileHandle.nullDevice
        p.terminationHandler = { process in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            let result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            DispatchQueue.main.async { completion(result) }
        }
        do { try p.run() } catch { completion([:]) }
    }
    func refreshUpdateAnimation() {
        let animate = appUpdater?.working == true && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if animate && orbitTimer == nil {
            orbitTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 15.0, repeats: true) { [weak self] _ in
                guard let self else { return }; self.orbitAngle = (self.orbitAngle + 12).truncatingRemainder(dividingBy: 360)
                self.statusItem.button?.image = DotStatus.ready.image(rotation: self.orbitAngle)
            }
            if let orbitTimer { RunLoop.main.add(orbitTimer, forMode: .common) }
        } else if !animate { orbitTimer?.invalidate(); orbitTimer = nil; orbitAngle = 0 }
    }
    @objc func menuCheckUpdate() { appUpdater?.check() }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        guard window != nil else { return true }
        showWindow(); return false
    }
    @objc func showWindow() { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func showHome() {
        showingNotifications = false; showingPairing = false; showingDetails = false; pairingCode = nil; pairingExpiry = 0
        render(); showWindow(); inspect()
    }
    @objc func menuPair() { showingNotifications = false; showingPairing = true; render(); showWindow(); inspect() }
    @objc func menuNotifications() { showingNotifications = true; render(); showWindow() }
    @objc func menuNotificationPause() { notifications?.togglePause() }
    func connectNotifications() {
        guard notifications == nil, let directory = state["directory"] as? String, state["installed"] as? Bool == true else { return }
        let n = NotificationController(project: URL(fileURLWithPath: directory), legacyRunning: state["legacyNotificationRegistered"] as? Bool == true, relaySuspended: yes("lifecycleStopped") || !yes("bridge"))
        notifications = n
        n.tr = { [weak self] ja, en in self?.tr(ja, en) ?? ja }
        n.changed = { [weak self] in self?.updateMenu() }
        n.rebuildView = { [weak self] in if self?.showingNotifications == true { self?.render() } }
        n.requestMigration = { [weak self] in self?.beginNotificationMigration() }
        updateMenu()
    }
    func beginNotificationMigration() {
        guard notifications?.legacyRunning == true else { return }
        if busy {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.beginNotificationMigration() }
            return
        }
        migratingNotifications = true
        perform("migrate-notifications")
    }
    @objc func menuPause() { perform("pause") }
    @objc func menuResume() { perform(yes("lifecycleStopped") ? "resume" : "activate") }
    func updateMenu() {
        guard statusItem != nil else { return }
        let ready = step == "pair"
        let status = yes("lifecycleStopped") ? tr("一時停止中", "Paused") : ready ? tr("Dotに接続済み", "Connected to Dot") : step == "start" ? tr("中継は停止中", "Relay stopped") : tr("準備・確認が必要", "Setup or attention needed")
        let icon: DotStatus = yes("lifecycleStopped") ? .paused : ready ? .ready : step == "start" ? .paused : step == "checking" ? .checking : .attention
        statusItem.button?.image = appUpdater?.working == true ? DotStatus.ready.image(rotation: orbitAngle) : icon.image()
        statusItem.button?.setAccessibilityLabel("Dot Link: " + (appUpdater?.working == true ? appUpdater!.message : status))
        let menu = NSMenu()
        let info = NSMenuItem(title: "Dot Link · " + status, action: nil, keyEquivalent: ""); info.isEnabled = false; menu.addItem(info)
        func item(_ title: String, _ action: Selector, enabled: Bool = true) { let i = NSMenuItem(title: title, action: action, keyEquivalent: ""); i.target = self; i.isEnabled = enabled && !busy && appUpdater?.preparing != true; menu.addItem(i) }
        menu.autoenablesItems = false
        item(tr("Dot Linkを開く", "Open Dot Link"), #selector(showHome))
        item(tr("Macの通知…", "Mac notifications…"), #selector(menuNotifications), enabled: notifications != nil)
        if let n = notifications {
            let detail = NSMenuItem(title: n.notificationSummary, action: nil, keyEquivalent: ""); detail.isEnabled = false; menu.addItem(detail)
        }
        menu.addItem(.separator())
        item(tr("一時停止", "Pause"), #selector(menuPause), enabled: yes("bridge") || yes("device") || yes("tunnel"))
        item(tr("再開", "Resume"), #selector(menuResume), enabled: step == "start" || yes("lifecycleStopped"))
        menu.addItem(.separator())
        item(tr("アップデートを確認…", "Check for updates…"), #selector(menuCheckUpdate))
        if let updater = appUpdater, !updater.message.isEmpty { let update = NSMenuItem(title: updater.message, action: nil, keyEquivalent: ""); update.isEnabled = false; menu.addItem(update) }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: tr("Dot Linkを終了", "Quit Dot Link"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); menu.addItem(quit)
        statusItem.menu = menu
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if appUpdater?.prepared == true {
            if appUpdater?.silentRelaunch == true { UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "updateBackgroundRelaunchAt") }
            notifications?.shutdown(); return .terminateNow
        }
        if appUpdater?.preparing == true { return .terminateCancel }
        if allowTermination { notifications?.shutdown(); return .terminateNow }
        if quitting { return .terminateLater }
        if busy {
            let alert = NSAlert(); alert.messageText = tr("処理が終わってから終了してください", "Wait for the current operation to finish")
            alert.informativeText = tr("設定の更新中です。完了後にもう一度終了できます。", "Settings are being updated. You can quit when the operation finishes.")
            alert.runModal(); return .terminateCancel
        }
        if appUpdater?.cancelForQuit() == false {
            let alert = NSAlert(); alert.messageText = tr("更新の検証が終わるまでお待ちください", "Wait for update verification to finish"); alert.runModal(); return .terminateCancel
        }
        quitting = true
        notifications?.setRelaySuspended(true)
        perform("shutdown")
        return .terminateLater
    }
    func confirmUninstall(_ plan: [String: Any]) {
        guard let token = plan["token"] as? String else { return }
        let alert = NSAlert(); alert.alertStyle = .warning
        alert.messageText = tr("このMacからDot Linkをアンインストールしますか？", "Uninstall Dot Link from this Mac?")
        alert.informativeText = tr("会話の中継と通知を停止し、自動起動を解除します。Dot Link、音声認識モデル、接続設定、会話履歴をゴミ箱へ移動します。再び使うには初期設定が必要です。", "This stops the relay and notifications, removes login items, and moves Dot Link, its speech model, connection settings, and conversation history to Trash. You will need to set up Dot Link again to use it.")
        if plan["retainsSource"] as? Bool == true { alert.informativeText += tr(" 開発用のソースフォルダは残します。", " The development source folder is preserved.") }
        let box = NSStackView(); box.orientation = .vertical; box.alignment = .leading; box.spacing = 10
        let paths = (plan["removes"] as? [String] ?? []).joined(separator: "\n")
        let list = NSTextView(frame: NSRect(x: 0, y: 0, width: 480, height: 100)); list.string = paths; list.isEditable = false; list.font = .systemFont(ofSize: 11)
        let scroll = NSScrollView(frame: list.frame); scroll.hasVerticalScroller = true; scroll.documentView = list; box.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalToConstant: 480).isActive = true; scroll.heightAnchor.constraint(equalToConstant: 100).isActive = true
        box.widthAnchor.constraint(equalToConstant: 480).isActive = true; box.setFrameSize(box.fittingSize)
        alert.accessoryView = box; alert.addButton(withTitle: tr("キャンセル", "Cancel")); alert.addButton(withTitle: tr("アンインストール", "Uninstall"))
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        if appUpdater?.cancelForQuit() == false {
            let alert = NSAlert(); alert.messageText = tr("更新の検証が終わるまでお待ちください", "Wait for update verification to finish"); alert.runModal(); return
        }
        perform("uninstall", input: ["token": token, "deleteData": "true"])
    }
    func label(_ text: String, size: CGFloat = 14, bold: Bool = false) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: text); l.font = .systemFont(ofSize: size, weight: bold ? .semibold : .regular); l.maximumNumberOfLines = 0; l.setContentCompressionResistancePriority(.required, for: .vertical); return l
    }
    func add(_ text: String, size: CGFloat = 14, bold: Bool = false) { stack.addArrangedSubview(label(text, size: size, bold: bold)) }
    @discardableResult func button(_ text: String, primary: Bool = false, _ action: @escaping () -> Void) -> NSButton {
        let b = ActionButton(text, action); b.controlSize = .large; b.isEnabled = !busy
        if primary { b.keyEquivalent = "\r" }
        stack.addArrangedSubview(b); return b
    }
    func field(_ placeholder: String, secure: Bool = false) -> NSTextField {
        let f: NSTextField = secure ? NSSecureTextField() : NSTextField(); f.placeholderString = placeholder; f.font = .systemFont(ofSize: 15); f.isEnabled = !busy; f.translatesAutoresizingMaskIntoConstraints = false; stack.addArrangedSubview(f); f.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true; return f
    }
    func space() { let v = NSView(); v.heightAnchor.constraint(equalToConstant: 8).isActive = true; stack.addArrangedSubview(v) }
    func symbol(_ name: String, size: CGFloat, color: NSColor = .secondaryLabelColor) -> NSImageView {
        let v = NSImageView(); v.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: size, weight: .regular))
        v.contentTintColor = color; v.imageScaling = .scaleProportionallyDown
        v.widthAnchor.constraint(equalToConstant: size + 8).isActive = true; v.heightAnchor.constraint(equalToConstant: size + 8).isActive = true
        return v
    }
    func statusCard(_ name: String, symbol icon: String, detail: String, status: String, statusIcon: String, color: NSColor, help: String) {
        let content = NSStackView(); content.orientation = .horizontal; content.alignment = .centerY; content.spacing = 14
        content.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 14)
        content.addArrangedSubview(symbol(icon, size: 28))
        let words = NSStackView(); words.orientation = .vertical; words.alignment = .leading; words.spacing = 4
        words.addArrangedSubview(label(name, size: 15, bold: true))
        let sub = label(detail, size: 12); sub.textColor = .secondaryLabelColor; words.addArrangedSubview(sub); content.addArrangedSubview(words)
        let flexible = NSView(); flexible.setContentHuggingPriority(.defaultLow, for: .horizontal); content.addArrangedSubview(flexible)
        let state = NSStackView(views: [symbol(statusIcon, size: 13, color: color), label(status, size: 12, bold: true)]); state.spacing = 4
        state.setContentCompressionResistancePriority(.required, for: .horizontal); content.addArrangedSubview(state)
        content.addArrangedSubview(HelpButton(name + tr("について", " help"), help))
        let card = NSBox(); card.boxType = .custom; card.borderColor = .separatorColor; card.borderWidth = 0.5; card.cornerRadius = 12; card.fillColor = .controlBackgroundColor; card.contentViewMargins = .zero
        card.contentView = content; stack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
        card.heightAnchor.constraint(greaterThanOrEqualToConstant: 84).isActive = true
    }
    func connectionCards(paused: Bool = false) {
        statusCard("Dot", symbol: "bubble.left.and.bubble.right", detail: tr("いつものChatGPT Dot", "Your existing ChatGPT Dot"), status: paused ? tr("停止中", "Stopped") : tr("接続済み", "Connected"), statusIcon: paused ? "pause.circle" : "checkmark.circle.fill", color: paused ? .secondaryLabelColor : .systemGreen, help: tr("このMacの中継と、Dotの会話用購読の状態です。返信の到着やEvenでの表示を保証するものではありません。", "This reflects this Mac's relay and Dot's conversation subscription. It does not confirm delivery of a reply or its display on Even."))
        statusCard(tr("このMac", "This Mac"), symbol: "desktopcomputer", detail: tr("音声認識・会話の中継", "Speech recognition and relay"), status: paused ? tr("一時停止", "Paused") : tr("稼働中", "Running"), statusIcon: paused ? "pause.circle" : "checkmark.circle.fill", color: paused ? .secondaryLabelColor : .systemGreen, help: tr("このMacが音声認識と通信を中継します。スリープ中は使えません。一時停止・終了では、会話の中継と通知を停止します。", "This Mac handles speech recognition and communication. It must be awake. Pause and Quit stop both the relay and notifications."))
        statusCard("Even G2", symbol: "eyeglasses", detail: tr("接続設定", "Pairing"), status: yes("evenPaired") ? tr("設定済み", "Saved") : yes("evenPairingKnown") ? tr("未設定", "Not paired") : tr("確認できません", "Unknown"), statusIcon: yes("evenPaired") ? "checkmark.circle.fill" : "questionmark.circle", color: yes("evenPaired") ? .systemGreen : .systemOrange, help: tr("接続設定の保存状況です。Evenが今オンラインかどうかは、この画面では確認できません。接続先を変更・追加するときだけ、新しいコードを作成してください。", "This shows whether pairing is saved. This screen cannot check whether Even is currently online. Create a new code only to change or add a connection."))
    }
    func open(_ url: String) { if let value = URL(string: url) { NSWorkspace.shared.open(value) } }
    func render() {
        updateMenu()
        let scroll = NSScrollView(); scroll.contentView = SetupClipView(); scroll.hasVerticalScroller = true; scroll.drawsBackground = false
        stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14; stack.edgeInsets = NSEdgeInsets(top: 28, left: 32, bottom: 28, right: 32); stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.documentView = stack; window.contentView = scroll
        stack.widthAnchor.constraint(equalTo: scroll.contentView.widthAnchor).isActive = true
        stack.topAnchor.constraint(equalTo: scroll.contentView.topAnchor).isActive = true
        let top = NSStackView(); top.orientation = .horizontal; top.spacing = 12
        let mark = NSImageView(); mark.image = DotStatus.ready.image(); mark.contentTintColor = .labelColor; mark.imageScaling = .scaleProportionallyUpOrDown
        mark.widthAnchor.constraint(equalToConstant: 28).isActive = true; mark.heightAnchor.constraint(equalToConstant: 28).isActive = true
        top.addArrangedSubview(mark); top.addArrangedSubview(label("Dot Link", size: 26, bold: true))
        let topSpace = NSView(); topSpace.setContentHuggingPriority(.defaultLow, for: .horizontal); top.addArrangedSubview(topSpace)
        let languages = NSPopUpButton(); languages.addItems(withTitles: ["日本語", "English"]); languages.selectItem(at: language == "ja" ? 0 : 1); languages.target = self; languages.action = #selector(changeLanguage(_:)); languages.isEnabled = !busy; languages.setAccessibilityLabel(tr("表示言語", "Language")); top.addArrangedSubview(languages); stack.addArrangedSubview(top)
        top.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
        if showingDetails && !busy {
            add(tr("詳細設定", "Advanced settings"), size: 23, bold: true)
            button(tr("戻る", "Back")) { [weak self] in self?.showHome() }
            if !message.isEmpty { add(message) }
            if let updater = appUpdater { let updates = updater.settingsView(); stack.addArrangedSubview(updates); updates.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true }
            space()
            add(tr("このMacでDot Linkを使わなくなった場合は、ここから取り除けます。", "If you no longer use Dot Link on this Mac, you can remove it here."))
            button(tr("Dot Linkをアンインストール…", "Uninstall Dot Link…")) { [weak self] in self?.perform("uninstall-plan") }
            return
        }
        if showingNotifications && !busy {
            button(tr("接続に戻る", "Back to connection")) { [weak self] in self?.showingNotifications = false; self?.render() }
            if !message.isEmpty { add(message) }
            if let n = notifications { let view = n.makeView(); stack.addArrangedSubview(view); view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true }
            else { add(tr("Macの準備が終わると通知を設定できます。", "Finish Mac setup to configure notifications.")) }
            return
        }
        if step != "pair" && !yes("lifecycleStopped") { add(tr("1  Macの準備   →   2  Dotとの連携   →   3  iPhoneの接続", "1  Prepare Mac   →   2  Connect Dot   →   3  Pair iPhone"), size: 13, bold: true) }
        space()
        if !message.isEmpty { let l = label(message); l.textColor = .secondaryLabelColor; stack.addArrangedSubview(l) }
        progressLabel = nil; progress = nil; tunnelField = nil; secretField = nil; originField = nil; codeField = nil; expiryLabel = nil; copyButton = nil
        if busy {
            let progressText = ["pause", "shutdown"].contains(currentAction) ? tr("Dot Linkを停止しています…", "Stopping Dot Link…") : currentAction == "uninstall" ? tr("Dot Linkを取り除いています…", "Removing Dot Link…") : currentAction == "resume" ? tr("Dot Linkを再開しています…", "Resuming Dot Link…") : tr("状態を確認しています…", "Checking…")
            let l = label(progressText, size: 18, bold: true); progressLabel = l; stack.addArrangedSubview(l)
            let p = NSProgressIndicator(); p.style = .bar; p.isIndeterminate = true; p.startAnimation(nil); p.widthAnchor.constraint(equalToConstant: 470).isActive = true; stack.addArrangedSubview(p); progress = p
            return
        }
        switch step {
        case "install":
            add(tr("このMacを準備", "Prepare this Mac"), size: 23, bold: true)
            add(tr("必要なものを確認し、足りないものをDot Link専用の場所へ入れます。開発ツールの操作は不要です。", "Dot Link checks what is present and installs missing components in its own folder. No developer tools are needed."))
            add(tr("音声認識データを約490 MBダウンロードします。Macの既存アプリ・接続設定・スリープ設定は変更しません。", "This downloads about 490 MB of speech recognition data. Existing apps, connection settings and sleep settings are preserved."))
            if yes("legacyTerminalPresent") { add(tr("以前のEven Terminalが見つかりました。別のアプリとして、そのまま残します。", "An older Even Terminal folder was found. It is a separate app and will be preserved.")) }
            button(tr("このMacを準備する", "Prepare this Mac"), primary: true) { [weak self] in self?.perform("prepare") }
        case "network":
            add(tr("MacとiPhoneをつなぐ", "Connect your Mac and iPhone"), size: 23, bold: true)
            add(tr("Tailscaleを使って、自分のMacとiPhoneを接続します。両方で同じアカウントにログインしてください。", "Use Tailscale to connect your own Mac and iPhone. Sign in with the same account on both devices."))
            if yes("tailscaleInstalled") {
                button(tr("Tailscaleを開く", "Open Tailscale"), primary: true) { [weak self] in self?.openTailscale() }
            } else {
                button(tr("Tailscaleをインストール", "Install Tailscale"), primary: true) { [weak self] in self?.open("https://tailscale.com/download/mac") }
            }
            button(tr("接続できたので次へ", "Connected — continue")) { [weak self] in self?.inspect() }
        case "networkConflict":
            add(tr("既存の接続設定を確認", "Review existing network settings"), size: 23, bold: true)
            add(tr("別の用途の設定が見つかりました。Dot Linkでは上書きしていません。既存サービスとの併用方法を確認してから続けます。", "Existing settings are in use for another purpose. Dot Link has not overwritten them. Resolve the conflict before continuing."))
            button(tr("もう一度確認", "Check again"), primary: true) { [weak self] in self?.inspect() }
        case "dot":
            add(tr("いつものDotと連携", "Connect your existing Dot"), size: 23, bold: true)
            add(tr("OpenAIの設定画面で、このMac用の接続を作ります。表示された接続IDとキーを、下の欄に一度だけ貼り付けます。", "Create a connection for this Mac in OpenAI settings. Paste its tunnel ID and runtime key below once."))
            add(tr("別のMacで使っている接続はそのまま残し、このMacには別の接続を用意してください。", "Keep connections already used by another Mac. Create a separate one for this Mac."), size: 13)
            button(tr("OpenAIの接続設定を開く", "Open OpenAI connection settings")) { [weak self] in self?.open("https://platform.openai.com/settings/organization/tunnels") }
            add(tr("キーを作るときは Permissionsで「Restricted」を選び、Tunnelsの「Read」と「Use」だけを有効にします。", "When creating the key, choose Restricted under Permissions and enable only Read and Use for Tunnels."), size: 14, bold: true)
            add(tr("このアプリで使うキーにManageは不要です。トンネル自体を新しく作る操作には、アカウント側のRead・Manage権限が必要です。", "The runtime key does not need Manage. Creating a new tunnel separately requires Read and Manage on your account."), size: 12)
            add(tr("接続ID（tunnel_ で始まるもの）", "Tunnel ID (starts with tunnel_)"), size: 13, bold: true)
            let id = field("tunnel_…"); id.stringValue = tunnelID; tunnelField = id
            add(tr("接続用キー（このMac内だけに保存）", "Runtime key (saved only on this Mac)"), size: 13, bold: true)
            let secret = field("sk-…", secure: true); secretField = secret
            button(tr("保存して次へ", "Save and continue"), primary: true) { [weak self] in
                guard let self else { return }; self.tunnelID = self.tunnelField?.stringValue ?? ""; let key = self.secretField?.stringValue ?? ""; self.secretField?.stringValue = ""
                self.perform("save-tunnel", input: ["id": self.tunnelID, "secret": key])
            }
        case "start":
            add(yes("lifecycleStopped") ? tr("Dot Linkは一時停止中", "Dot Link is paused") : tr("中継を起動", "Start your relay"), size: 23, bold: true)
            if yes("lifecycleStopped") {
                connectionCards(paused: true)
            } else {
                add(tr("このMacでDot Linkを起動し、ログイン時にも自動で起動するようにします。Macが起きている間に利用できます。", "Start Dot Link on this Mac and enable it at login. The relay works while your Mac is awake."))
            }
            button(yes("lifecycleStopped") ? tr("再開", "Resume") : tr("中継を起動する", "Start relay"), primary: true) { [weak self] in self?.menuResume() }
        case "subscribe":
            add(tr("Dotで接続を有効にする", "Enable the connection in Dot"), size: 23, bold: true)
            add(tr("Macの中継は起動しました。ChatGPTのPluginsから「Add custom MCP server」を開き、ConnectionでTunnelを選び、このMacの接続を追加します。", "Your Mac relay is running. In ChatGPT Plugins, open Add custom MCP server, choose Tunnel under Connection, and add this Mac's connection."))
            add(tr("いつものDotでその接続を選び、下の設定メッセージを送ります。別のDotを作る必要はありません。", "Select the connection in your existing Dot and send the setup message below. You do not need a new Dot."))
            button(tr("ChatGPTを開く", "Open ChatGPT")) { [weak self] in self?.open("https://chatgpt.com/") }
            button(tr("Dotへの設定メッセージをコピー", "Copy setup message for Dot")) { [weak self] in self?.copySetupMessage() }
            button(tr("Dotとの接続を確認", "Check connection to Dot"), primary: true) { [weak self] in self?.inspect() }
        case "pair":
            add(showingPairing ? tr("Evenの接続設定", "Even connection settings") : tr("接続状況", "Connections"), size: 22, bold: true)
            connectionCards()
            if showingPairing {
                button(tr("接続状況に戻る", "Back to connection status")) { [weak self] in self?.showHome() }
                button(yes("evenPaired") ? tr("接続を変更・追加", "Change or add a connection") : tr("接続コードを作成", "Create pairing code"), primary: true) { [weak self] in self?.perform("pair") }
                if let code = pairingCode, pairingExpiry > Date().timeIntervalSince1970 * 1000 {
                    let f = field(""); f.stringValue = code; f.isEditable = false; f.font = .monospacedSystemFont(ofSize: 12, weight: .regular); codeField = f
                    copyButton = button(tr("接続コードをコピー", "Copy pairing code")) { [weak self] in self?.copyPairing() }
                    let l = label(""); expiryLabel = l; stack.addArrangedSubview(l)
                    add(tr("コード全体をEvenアプリのDot Linkに貼り付けて「接続」を押してください。既存の接続設定は保持されます。", "Paste the full code into Dot Link in the Even app and tap Connect. Existing pairings are preserved."))
                    updateExpiry()
                }
            } else {
                let actions = NSStackView(); actions.orientation = .horizontal; actions.spacing = 12
                let pairing = ActionButton(yes("evenPaired") ? tr("Evenの接続設定", "Even connection settings") : tr("Evenを接続", "Connect Even")) { [weak self] in self?.menuPair() }
                pairing.controlSize = .large; pairing.keyEquivalent = "\r"; actions.addArrangedSubview(pairing)
                let notificationSettings = ActionButton(tr("通知設定", "Notifications")) { [weak self] in self?.menuNotifications() }
                notificationSettings.controlSize = .large; notificationSettings.image = NSImage(systemSymbolName: "bell", accessibilityDescription: nil); notificationSettings.imagePosition = .imageLeading
                notificationSettings.isEnabled = notifications != nil; actions.addArrangedSubview(notificationSettings)
                stack.addArrangedSubview(actions)
            }
        case "updateRecovery":
            add(tr("更新後の中継を確認できません", "The relay has not recovered after the update"), size: 23, bold: true)
            add(tr("設定と履歴は保持しています。ネットワーク接続を確認して、復旧を再試行してください。", "Your settings and history are preserved. Check the network connection and retry recovery."))
            button(tr("復旧を再試行", "Retry recovery"), primary: true) { [weak self] in self?.perform("update-recover") }
        case "conflict":
            add(tr("以前の設定を確認してください", "Review previous settings"), size: 23, bold: true)
            add(tr("複数の導入先、または別の用途の起動設定が見つかりました。何も上書きしていません。", "Multiple installations or conflicting login services were found. Nothing has been overwritten."))
            button(tr("もう一度確認", "Check again"), primary: true) { [weak self] in self?.inspect() }
        default:
            add(tr("準備を確認", "Check setup"), size: 23, bold: true)
            button(tr("確認する", "Check"), primary: true) { [weak self] in self?.inspect() }
        }
        space()
        if step != "pair" && !yes("lifecycleStopped") { let footer = label(tr("接続や準備が終わるまで、iPhoneでコードを発行・撮影する必要はありません。", "Finish Mac and Dot setup before pairing your iPhone."), size: 12); footer.textColor = .secondaryLabelColor; stack.addArrangedSubview(footer) }
        let footer = NSStackView(); footer.orientation = .horizontal; footer.spacing = 10
        if let checked = lastChecked {
            let f = DateFormatter(); f.locale = Locale(identifier: language == "ja" ? "ja_JP" : "en_US"); f.timeStyle = .medium
            let checkedLabel = label(tr("最終確認：", "Last checked: ") + f.string(from: checked), size: 12); checkedLabel.textColor = .secondaryLabelColor; footer.addArrangedSubview(checkedLabel)
        }
        if step != "checking" {
            let refresh = ActionButton("") { [weak self] in self?.inspect() }; refresh.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: tr("状態を再確認", "Refresh status")); refresh.isBordered = false; refresh.toolTip = tr("状態を再確認", "Refresh status"); refresh.setAccessibilityLabel(refresh.toolTip!); footer.addArrangedSubview(refresh)
        }
        let footerSpace = NSView(); footerSpace.setContentHuggingPriority(.defaultLow, for: .horizontal); footer.addArrangedSubview(footerSpace)
        let details = ActionButton("") { [weak self] in self?.showingDetails = true; self?.message = ""; self?.render() }; details.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: tr("詳細設定", "Advanced settings")); details.isBordered = false; details.toolTip = tr("詳細設定", "Advanced settings"); details.setAccessibilityLabel(details.toolTip!); footer.addArrangedSubview(details)
        stack.addArrangedSubview(footer); footer.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
    }
    @objc func changeLanguage(_ sender: NSPopUpButton) { language = sender.indexOfSelectedItem == 0 ? "ja" : "en"; UserDefaults.standard.set(language, forKey: "setupLanguage"); appUpdater?.refreshLanguage(); render() }
    func inspect() { perform("inspect") }
    func openTailscale() {
        for path in ["/Applications/Tailscale.app", NSHomeDirectory() + "/Applications/Tailscale.app"] {
            if FileManager.default.fileExists(atPath: path) { NSWorkspace.shared.open(URL(fileURLWithPath: path)); return }
        }
        open("https://tailscale.com/download/mac")
    }
    func copySetupMessage() {
        let text = tr("このMac用のDot Link接続を使って、私のEven G2からの発話を受け取ってください。セッションはpersonal-g2です。utterance.createdを購読し、届いたらget_pending_utterancesで実際のIDと本文を取得して、reply_to_g2で返してください。新しい連絡はsend_message_to_g2を使ってください。まずget_statusで接続を確認してください。別のMacで利用中の接続や購読は変更しないでください。Mac通知の購読は今は追加しないでください。", "Use this Mac's Dot Link connection to receive messages from my Even G2. The session is personal-g2. Subscribe to utterance.created, use get_pending_utterances to read real IDs and messages, then reply with reply_to_g2. Use send_message_to_g2 for new messages. First check get_status. Do not change connections or subscriptions used by another Mac. Do not subscribe to Mac notifications yet.")
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string); message = tr("設定メッセージをコピーしました。いつものDotへ貼り付けて送ってください。", "Setup message copied. Paste and send it to your existing Dot."); render()
    }
    func copyPairing() {
        guard let code = pairingCode, pairingExpiry > Date().timeIntervalSince1970 * 1000 else { updateExpiry(); return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string)
        expiryLabel?.stringValue = tr("コピーしました。iPhoneへ貼り付けてください。", "Copied. Paste it on your iPhone.")
    }
    func updateExpiry() {
        guard pairingCode != nil else { return }
        let seconds = max(0, Int((pairingExpiry - Date().timeIntervalSince1970 * 1000) / 1000))
        if seconds == 0 {
            pairingCode = nil; codeField?.stringValue = ""; copyButton?.isEnabled = false
            expiryLabel?.stringValue = tr("期限が切れました。新しい接続コードを作成してください。", "Expired. Create a new pairing code.")
        } else { expiryLabel?.stringValue = tr("残り\(seconds)秒・1回限り", "\(seconds) seconds remaining · one use") }
    }
    func perform(_ action: String, input: [String: String] = [:]) {
        guard !busy, appUpdater?.preparing != true else { return }; busy = true; currentAction = action; message = ""
        if ["pause", "shutdown", "uninstall"].contains(action) { notifications?.setRelaySuspended(true) }
        render()
        let task = Process(); task.executableURL = payload.appendingPathComponent(".runtime/bin/node"); task.arguments = [payload.appendingPathComponent("scripts/mac-setup.mjs").path, action]; task.currentDirectoryURL = payload
        let out = Pipe(), stdin = Pipe(); task.standardOutput = out; task.standardInput = stdin; task.standardError = FileHandle.nullDevice
        helper = task
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self else { return }
            var buffer = Data(); var completed = false
            func consume(_ data: Data) {
                buffer.append(data)
                while let range = buffer.range(of: Data([10])) {
                    let line = buffer.subdata(in: buffer.startIndex..<range.lowerBound); buffer.removeSubrange(buffer.startIndex...range.lowerBound)
                    guard let value = try? JSONSerialization.jsonObject(with: line) as? [String: Any] else { continue }
                    if value["kind"] as? String == "result" || value["kind"] as? String == "error" { completed = true }
                    DispatchQueue.main.async { self.receive(value) }
                }
            }
            do {
                try task.run()
                var data = try JSONSerialization.data(withJSONObject: input); data.append(10); stdin.fileHandleForWriting.write(data); try? stdin.fileHandleForWriting.close()
                while true { let chunk = out.fileHandleForReading.availableData; if chunk.isEmpty { break }; consume(chunk) }
                task.waitUntilExit()
                if !completed { DispatchQueue.main.async { self.receive(["kind": "error", "code": "HELPER_FAILED"]) } }
            } catch { DispatchQueue.main.async { self.receive(["kind": "error", "code": "HELPER_FAILED"]) } }
        }
    }
    func receive(_ value: [String: Any]) {
        switch value["kind"] as? String {
        case "progress":
            let pct = value["percent"] as? Int ?? 0
            progressLabel?.stringValue = value["task"] as? String == "model" ? tr("音声認識を準備しています… \(pct)%", "Preparing speech recognition… \(pct)%") : tr("Dot Linkを準備しています…", "Preparing Dot Link…")
            progress?.isIndeterminate = false; progress?.doubleValue = Double(pct)
        case "result":
            busy = false; helper = nil
            if value["quitReady"] as? Bool == true {
                allowTermination = true; notifications?.shutdown(); NSApp.reply(toApplicationShouldTerminate: true); return
            }
            if value["uninstalled"] as? Bool == true {
                notifications?.shutdown(); notifications = nil
                var preferencesRetained = false
                if value["deleteData"] as? Bool == true, let id = Bundle.main.bundleIdentifier {
                    do {
                        guard let trash = value["trash"] as? String else { throw NSError(domain: "Uninstall", code: 1) }
                        let preferences = UserDefaults.standard.persistentDomain(forName: id) ?? [:]
                        let data = try PropertyListSerialization.data(fromPropertyList: preferences, format: .xml, options: 0)
                        let backup = URL(fileURLWithPath: trash).appendingPathComponent("Dot-Link-preferences.plist")
                        try data.write(to: backup, options: [.atomic])
                        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: backup.path)
                        UserDefaults.standard.removePersistentDomain(forName: id)
                    } catch { preferencesRetained = true }
                }
                let alert = NSAlert(); alert.messageText = tr("アンインストールしました", "Dot Link was uninstalled")
                alert.informativeText = tr("このMacのDot Linkは停止しました。取り除いたファイルはゴミ箱にあります。", "Dot Link has stopped on this Mac. Removed files are in Trash.")
                if preferencesRetained { alert.informativeText += "\n" + tr("Macアプリの表示・通知設定は、バックアップできなかったため保持しています。", "Mac display and notification preferences were kept because their backup could not be created.") }
                alert.runModal(); allowTermination = true; NSApp.terminate(nil); return
            }
            if let plan = value["uninstallPlan"] as? [String: Any] { render(); confirmUninstall(plan); return }
            state = value; lastChecked = Date()
            if currentAction == "inspect" { message = "" } // The timestamp and cards show the refreshed result.
            connectNotifications()
            notifications?.setRelaySuspended(yes("lifecycleStopped") || !yes("bridge"))
            notifications?.healthChecked = true
            notifications?.healthReady = yes("bridge") && yes("subscribed")
            notifications?.updateState()
            if migratingNotifications { migratingNotifications = false; notifications?.migrationFinished(); message = tr("通知の引き継ぎが完了しました。旧アプリの自動起動も解除しました。", "Notifications moved. The old app will no longer start at login.") }
            if let code = value["pairingCode"] as? String { pairingCode = code; pairingExpiry = value["expiresAt"] as? Double ?? 0 }
            render()
            if automaticResumePending {
                automaticResumePending = false
                if yes("lifecycleStopped") && state["lifecycleReason"] as? String == "quit" { perform("resume") }
            }
        case "error":
            busy = false; helper = nil; automaticResumePending = false
            if quitting { quitting = false; NSApp.reply(toApplicationShouldTerminate: false); showWindow() }
            if migratingNotifications { migratingNotifications = false; notifications?.migrationFailed() }
            let code = value["code"] as? String ?? "SETUP_FAILED"
            if code == "UPDATE_RECOVERY_REQUIRED" { state["step"] = "updateRecovery" }
            if ["MULTIPLE_INSTALLATIONS", "EXISTING_SERVICE_CONFLICT", "EXISTING_SERVICE_UNREADABLE", "INSTALL_FOLDER_OCCUPIED"].contains(code) { state["step"] = "conflict" }
            message = tr("準備を完了できませんでした。既存の設定は保持しています。もう一度状態を確認してください。", "Setup could not complete. Existing settings have been preserved. Check the status again.") + " (\(code))"
            if ["shutdown", "pause", "uninstall"].contains(currentAction) {
                message = tr("処理を完了できませんでした。Dot Linkは開いたままです。停止・削除の状況を確認してから再試行してください。", "The operation could not complete. Dot Link remains open. Check the stop or removal status before retrying.") + " (\(code))"
            }
            render()
        default: break
        }
    }
}
if NSRunningApplication.runningApplications(withBundleIdentifier: "app.tripsurf.dotlink.mac").contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) { exit(0) }
let app = NSApplication.shared
let delegate = SetupApp(); app.delegate = delegate; app.run()
