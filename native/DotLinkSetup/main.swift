import AppKit

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
    var contentScroll: NSScrollView!
    var statusItem: NSStatusItem!
    var stack: NSStackView!
    var state: [String: Any] = [:]
    var notifications: NotificationController?
    var showingNotifications = false
    var showingPairing = false
    var showingDetails = false
    var showingSpeech = false
    var showingSpeechOutput = false
    var speechChoice = "whisper"
    var speechEndpointField: NSTextField?
    var speechEndpointDraft = ""
    var speechKeyField: NSTextField?
    var speechMetadata: [String: String] = [:]
    var speechMetadataGeneration = 0
    var speechMetadataLabel: NSTextField?
    var allowTermination = false
    var quitting = false
    var automaticResumePending = false
    var currentAction = ""
    var lastChecked: Date?
    var migratingNotifications = false
    var busy = false
    var helper: Process?
    var messageRecord: LocalizedMessage?
    var message: String { messageRecord.map { Localization.shared.text($0, language: language) } ?? "" }
    var setupFailure = SetupFailurePresentation()
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
    var pairingRefreshPending = false
    var pairingRefreshAt = Date.distantPast
    var pairingRefreshGeneration = 0
    var language = Localization.shared.choose(preferred: Locale.preferredLanguages.first ?? "en", saved: UserDefaults.standard.string(forKey: "setupLanguage"))
    let payload = Bundle.main.resourceURL!.appendingPathComponent("payload")
    var step: String { state["step"] as? String ?? "checking" }
    func tr(_ key: String, _ parameters: [String: String] = [:]) -> String { Localization.shared.text(key, language: language, parameters) }
    func yes(_ key: String) -> Bool { state[key] as? Bool == true }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let relaunchAt = UserDefaults.standard.double(forKey: "updateBackgroundRelaunchAt")
        let quietUpdate = relaunchAt > 0 && Date().timeIntervalSince1970 - relaunchAt < 600
        UserDefaults.standard.removeObject(forKey: "updateBackgroundRelaunchAt")
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        updateMenu()
        updateAppMenu()
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 740), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.minSize = NSSize(width: 360, height: 300); window.title = "Dot Link"; window.delegate = self; window.isReleasedWhenClosed = false
        window.titlebarAppearsTransparent = true; window.backgroundColor = .windowBackgroundColor
        if let screen = window.screen ?? NSScreen.main {
            window.minSize = NSSize(width: min(360, screen.visibleFrame.width), height: min(300, screen.visibleFrame.height))
            window.setFrame(SetupWindowLayout.initialFrame(for: window, within: screen.visibleFrame), display: false)
        } else { window.center() }
        contentScroll = SetupWindowLayout.install(in: window)
        render(); if !CommandLine.arguments.contains("--background") && !quietUpdate { window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
        automaticResumePending = !CommandLine.arguments.contains("--background")
        configureUpdater()
        appUpdater?.beginStartupRecovery()
        perform("update-recover")
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.updateExpiry()
            self?.refreshVisiblePairing()
        }
    }
    func updateAppMenu() {
        let menu = NSMenu(); let appItem = NSMenuItem(); menu.addItem(appItem)
        let appMenu = NSMenu(); appMenu.addItem(withTitle: tr("mac.quit_dot_link"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); appItem.submenu = appMenu
        let editItem = NSMenuItem(title: tr("mac.edit"), action: nil, keyEquivalent: ""); menu.addItem(editItem)
        let edit = NSMenu(); edit.addItem(withTitle: tr("mac.copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c"); edit.addItem(withTitle: tr("mac.paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v"); edit.addItem(withTitle: tr("mac.select_all"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"); editItem.submenu = edit; NSApp.mainMenu = menu
    }
    func configureUpdater() {
        let updater = AppUpdater(); appUpdater = updater
        updater.localize = { [weak self] key, parameters in self?.tr(key, parameters) ?? Localization.shared.text(key, language: "en", parameters) }
        updater.canCheck = { [weak self] in guard let self else { return false }; return self.yes("installed") && !self.busy && self.appUpdater?.blocksActions != true && Bundle.main.bundleURL.path == NSHomeDirectory() + "/Applications/Dot Link.app" }
        updater.changed = { [weak self] in self?.refreshUpdateAnimation(); self?.updateMenu() }
        updater.prepare = { [weak self] interrupt, reply in
            guard let self, !self.busy else { reply("waiting"); return }
            self.notifications?.setRelaySuspended(true)
            self.updateHelper(interrupt ? "update-prepare-manual" : "update-prepare") { result in
                let outcome = AppUpdater.preparationResult(result)
                reply(outcome)
                if outcome != "prepared" && outcome != "recovery-required" { self.inspect() }
            }
        }
        updater.recover = { [weak self] reply in
            guard let self, !self.busy else { reply(false); return }
            self.notifications?.setRelaySuspended(true)
            self.updateHelper("update-abort") { result in
                let succeeded = result["kind"] as? String == "result"
                reply(succeeded)
                if succeeded { self.inspect() }
            }
        }
        updater.retryStartupRecovery = { [weak self] in
            guard let self, !self.busy, self.appUpdater?.blocksActions != true else { return }
            self.appUpdater?.beginStartupRecovery(); self.perform("update-recover")
        }
        updater.start()
    }
    func updateHelper(_ action: String, completion: @escaping ([String: Any]) -> Void) {
        let p = Process(); p.executableURL = payload.appendingPathComponent(".runtime/bin/node")
        p.arguments = [payload.appendingPathComponent("scripts/mac-setup.mjs").path, action]
        if ["update-prepare", "update-prepare-manual"].contains(action) {
            p.arguments?.append(String(ProcessInfo.processInfo.processIdentifier))
        }
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
        showingNotifications = false; showingPairing = false; showingDetails = false; showingSpeech = false; showingSpeechOutput = false; pairingCode = nil; pairingExpiry = 0
        render(); showWindow(); inspect()
    }
    @objc func menuPair() { showingDetails = false; showingSpeech = false; showingSpeechOutput = false; showingNotifications = false; showingPairing = true; render(); showWindow(); inspect() }
    @objc func menuNotifications() { showingSpeech = false; showingSpeechOutput = false; showingNotifications = true; render(); showWindow() }
    @objc func menuNotificationPause() { notifications?.togglePause() }
    func connectNotifications() {
        guard notifications == nil, let directory = state["directory"] as? String, state["installed"] as? Bool == true else { return }
        let n = NotificationController(project: URL(fileURLWithPath: directory), legacyRunning: state["legacyNotificationRegistered"] as? Bool == true, relaySuspended: yes("lifecycleStopped") || !yes("bridge"))
        notifications = n
        n.localize = { [weak self] key, parameters in self?.tr(key, parameters) ?? Localization.shared.text(key, language: "en", parameters) }
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
    @objc func menuResume() { perform(yes("lifecycleStopped") && yes("servicesConfigured") ? "resume" : "activate") }
    func updateMenu() {
        guard statusItem != nil else { return }
        let ready = step == "pair"
        let status = yes("lifecycleStopped") ? tr("mac.paused") : ready ? tr("mac.connected_to_dot") : step == "start" ? tr("mac.relay_stopped") : tr("mac.setup_or_attention_needed")
        let icon: DotStatus = yes("lifecycleStopped") ? .paused : ready ? .ready : step == "start" ? .paused : step == "checking" ? .checking : .attention
        statusItem.button?.image = appUpdater?.working == true ? DotStatus.ready.image(rotation: orbitAngle) : icon.image()
        statusItem.button?.setAccessibilityLabel("Dot Link: " + (appUpdater?.working == true ? appUpdater!.message : status))
        let menu = NSMenu()
        let info = NSMenuItem(title: "Dot Link · " + status, action: nil, keyEquivalent: ""); info.isEnabled = false; menu.addItem(info)
        func item(_ title: String, _ action: Selector, enabled: Bool = true) { let i = NSMenuItem(title: title, action: action, keyEquivalent: ""); i.target = self; i.isEnabled = enabled && !busy && appUpdater?.blocksActions != true; menu.addItem(i) }
        menu.autoenablesItems = false
        item(tr("mac.open_dot_link"), #selector(showHome))
        item(tr("mac.even_connection_settings"), #selector(menuPair), enabled: yes("installed"))
        item(tr("mac.speech_input_128"), #selector(menuSpeech), enabled: yes("installed"))
        item(tr("mac.speech_output_129"), #selector(menuSpeechOutput), enabled: yes("installed"))
        item(tr("mac.mac_notifications"), #selector(menuNotifications), enabled: notifications != nil)
        if let n = notifications {
            let detail = NSMenuItem(title: n.notificationSummary, action: nil, keyEquivalent: ""); detail.isEnabled = false; menu.addItem(detail)
        }
        menu.addItem(.separator())
        item(tr("mac.pause"), #selector(menuPause), enabled: yes("bridge") || yes("device") || yes("tunnel"))
        item(tr("mac.resume"), #selector(menuResume), enabled: step == "start" || (yes("lifecycleStopped") && yes("servicesConfigured")))
        menu.addItem(.separator())
        item(appUpdater?.checkTitle ?? tr("mac.check_for_updates"), #selector(menuCheckUpdate))
        if let updater = appUpdater, !updater.message.isEmpty { let update = NSMenuItem(title: updater.message, action: nil, keyEquivalent: ""); update.isEnabled = false; menu.addItem(update) }
        menu.addItem(.separator())
        let quit = NSMenuItem(title: tr("mac.quit_dot_link"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); menu.addItem(quit)
        statusItem.menu = menu
    }
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if appUpdater?.prepared == true {
            if appUpdater?.silentRelaunch == true { UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "updateBackgroundRelaunchAt") }
            notifications?.shutdown(); return .terminateNow
        }
        if appUpdater?.blocksActions == true { _ = appUpdater?.cancelForQuit(); return .terminateCancel }
        if allowTermination { notifications?.shutdown(); return .terminateNow }
        if quitting { return .terminateLater }
        if busy {
            let alert = NSAlert(); alert.messageText = tr("mac.wait_for_the_current_operation_to_finish")
            alert.informativeText = tr("mac.settings_are_being_updated_you_can_quit_when_the_operation_finishes")
            alert.runModal(); return .terminateCancel
        }
        if appUpdater?.cancelForQuit() == false {
            return .terminateCancel
        }
        quitting = true
        notifications?.setRelaySuspended(true)
        perform("shutdown")
        return .terminateLater
    }
    func confirmUninstall(_ plan: [String: Any]) {
        guard let token = plan["token"] as? String else { return }
        let alert = NSAlert(); alert.alertStyle = .warning
        alert.messageText = tr("mac.uninstall_dot_link_from_this_mac")
        alert.informativeText = tr("mac.this_stops_the_relay_and_notifications_removes_login_items_and_moves_dot")
        if plan["retainsSource"] as? Bool == true { alert.informativeText += tr("mac.the_development_source_folder_is_preserved") }
        let box = NSStackView(); box.orientation = .vertical; box.alignment = .leading; box.spacing = 10
        let paths = (plan["removes"] as? [String] ?? []).joined(separator: "\n")
        let list = NSTextView(frame: NSRect(x: 0, y: 0, width: 480, height: 100)); list.string = paths; list.isEditable = false; list.font = .systemFont(ofSize: 11)
        let scroll = NSScrollView(frame: list.frame); scroll.hasVerticalScroller = true; scroll.documentView = list; box.addArrangedSubview(scroll)
        scroll.widthAnchor.constraint(equalToConstant: 480).isActive = true; scroll.heightAnchor.constraint(equalToConstant: 100).isActive = true
        box.widthAnchor.constraint(equalToConstant: 480).isActive = true; box.setFrameSize(box.fittingSize)
        alert.accessoryView = box; alert.addButton(withTitle: tr("mac.cancel")); alert.addButton(withTitle: tr("mac.uninstall"))
        guard alert.runModal() == .alertSecondButtonReturn else { return }
        if appUpdater?.cancelForQuit(discardConfirmed: true) == false {
            return
        }
        performSpeechCredential("delete-all") { [weak self] in self?.perform("uninstall", input: ["token": token, "deleteData": "true"]) }
    }
    func label(_ text: String, size: CGFloat = 14, bold: Bool = false) -> NSTextField {
        let l = NSTextField(wrappingLabelWithString: text); l.font = .systemFont(ofSize: size, weight: bold ? .semibold : .regular); l.maximumNumberOfLines = 0; l.setContentCompressionResistancePriority(.required, for: .vertical); return l
    }
    func add(_ text: String, size: CGFloat = 14, bold: Bool = false) {
        let text = label(text, size: size, bold: bold)
        stack.addArrangedSubview(text)
        text.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
    }
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
        content.addArrangedSubview(HelpButton(name + tr("mac.help"), help))
        let card = NSBox(); card.boxType = .custom; card.borderColor = .separatorColor; card.borderWidth = 0.5; card.cornerRadius = 12; card.fillColor = .controlBackgroundColor; card.contentViewMargins = .zero
        card.contentView = content; stack.addArrangedSubview(card)
        card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
        card.heightAnchor.constraint(greaterThanOrEqualToConstant: 84).isActive = true
    }
    func connectionCards(paused: Bool = false) {
        statusCard("Dot", symbol: "bubble.left.and.bubble.right", detail: tr("mac.your_existing_chatgpt_dot"), status: paused ? tr("mac.stopped") : tr("mac.connected"), statusIcon: paused ? "pause.circle" : "checkmark.circle.fill", color: paused ? .secondaryLabelColor : .systemGreen, help: tr("mac.this_reflects_this_mac_s_relay_and_dot_s_conversation_subscription_it_do"))
        statusCard(tr("mac.this_mac"), symbol: "desktopcomputer", detail: tr("mac.speech_recognition_and_relay"), status: paused ? tr("mac.paused_144") : tr("mac.running"), statusIcon: paused ? "pause.circle" : "checkmark.circle.fill", color: paused ? .secondaryLabelColor : .systemGreen, help: tr("mac.this_mac_handles_speech_recognition_and_communication_it_must_be_awake_p"))
        statusCard("Even G2", symbol: "eyeglasses", detail: tr("mac.pairing"), status: yes("evenPaired") ? tr("mac.saved") : yes("evenPairingKnown") ? tr("mac.not_paired") : tr("mac.unknown_150"), statusIcon: yes("evenPaired") ? "checkmark.circle.fill" : "questionmark.circle", color: yes("evenPaired") ? .systemGreen : .systemOrange, help: tr("mac.this_shows_whether_pairing_is_saved_this_screen_cannot_check_whether_eve"))
    }
    func open(_ url: String) { if let value = URL(string: url) { NSWorkspace.shared.open(value) } }
    func render() {
        updateMenu()
        stack = NSStackView(); stack.orientation = .vertical; stack.alignment = .leading; stack.spacing = 14; stack.edgeInsets = NSEdgeInsets(top: 28, left: 32, bottom: 28, right: 32); stack.translatesAutoresizingMaskIntoConstraints = false
        SetupWindowLayout.display(stack, in: contentScroll)
        let top = NSStackView(); top.orientation = .horizontal; top.spacing = 12
        let mark = NSImageView(); mark.image = DotStatus.ready.image(); mark.contentTintColor = .labelColor; mark.imageScaling = .scaleProportionallyUpOrDown
        mark.widthAnchor.constraint(equalToConstant: 28).isActive = true; mark.heightAnchor.constraint(equalToConstant: 28).isActive = true
        top.addArrangedSubview(mark); top.addArrangedSubview(label("Dot Link", size: 26, bold: true))
        let topSpace = NSView(); topSpace.setContentHuggingPriority(.defaultLow, for: .horizontal); top.addArrangedSubview(topSpace)
        let languages = NSPopUpButton(); languages.addItems(withTitles: Localization.shared.languages.map { Localization.shared.metadata[$0]!.name }); languages.selectItem(at: Localization.shared.languages.firstIndex(of: language) ?? 0); languages.target = self; languages.action = #selector(changeLanguage(_:)); languages.isEnabled = !busy; languages.setAccessibilityLabel(tr("mac.language")); top.addArrangedSubview(languages); stack.addArrangedSubview(top)
        top.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
        if showingSpeech { renderSpeech(); return }
        if showingSpeechOutput { renderSpeechOutput(); return }
        if showingDetails && !busy {
            add(tr("mac.advanced_settings"), size: 23, bold: true)
            button(tr("mac.back")) { [weak self] in self?.showHome() }
            if !message.isEmpty { add(message) }
            if let updater = appUpdater { let updates = updater.settingsView(); stack.addArrangedSubview(updates); updates.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true }
            space()
            add(tr("mac.if_you_no_longer_use_dot_link_on_this_mac_you_can_remove_it_here"))
            button(tr("mac.uninstall_dot_link")) { [weak self] in self?.perform("uninstall-plan") }
            return
        }
        if showingNotifications && !busy {
            button(tr("mac.back_to_connection")) { [weak self] in self?.showingNotifications = false; self?.render() }
            if !message.isEmpty { add(message) }
            if let n = notifications { let view = n.makeView(); stack.addArrangedSubview(view); view.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true }
            else { add(tr("mac.finish_mac_setup_to_configure_notifications")) }
            return
        }
        if !showingPairing && step != "pair" && !yes("lifecycleStopped") { add(tr("mac.1_prepare_mac_2_connect_dot_3_pair_iphone"), size: 13, bold: true) }
        space()
        if !message.isEmpty {
            let l = label(message); l.textColor = .secondaryLabelColor; stack.addArrangedSubview(l)
            l.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
        }
        if let failure = setupFailure.details, !busy {
            let l = label(failure.message(language: language)); l.textColor = .secondaryLabelColor; stack.addArrangedSubview(l)
            l.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
            if setupFailure.details?.code == "TAILSCALE_SERVE_APPROVAL_REQUIRED" {
                button(tr("mac.open_tailscale_dns_settings")) { [weak self] in self?.open("https://login.tailscale.com/admin/dns") }
            }
            let copy = button(setupFailure.copied ? tr("mac.diagnostics_copied") : tr("mac.copy_diagnostics")) { [weak self] in self?.copySetupDiagnostics() }
            copy.toolTip = tr("mac.only_the_failed_step_error_codes_and_app_version_no_keys_or_conversation")
        }
        progressLabel = nil; progress = nil; tunnelField = nil; secretField = nil; originField = nil; codeField = nil; expiryLabel = nil; copyButton = nil
        if busy {
            let progressText = currentAction == "revoke-pairings" ? tr("mac.removing_even_connections") : ["pause", "shutdown"].contains(currentAction) ? tr("mac.stopping_dot_link") : currentAction == "uninstall" ? tr("mac.removing_dot_link") : currentAction == "resume" ? tr("mac.resuming_dot_link") : tr("mac.checking")
            let l = label(progressText, size: 18, bold: true); progressLabel = l; stack.addArrangedSubview(l)
            let p = NSProgressIndicator(); p.style = .bar; p.isIndeterminate = true; p.startAnimation(nil); p.widthAnchor.constraint(equalToConstant: 470).isActive = true; stack.addArrangedSubview(p); progress = p
            return
        }
        if showingPairing && yes("installed") && step != "conflict" {
            renderPairingSettings()
            return
        }
        switch step {
        case "install":
            add(tr("mac.prepare_this_mac"), size: 23, bold: true)
            add(tr("mac.dot_link_checks_what_is_present_and_installs_missing_components_in_its_o"))
            add(tr("mac.this_downloads_about_490_mb_of_speech_recognition_data_existing_apps_con"))
            if yes("legacyTerminalPresent") { add(tr("mac.an_older_even_terminal_folder_was_found_it_is_a_separate_app_and_will_be")) }
            button(tr("mac.prepare_this_mac_172"), primary: true) { [weak self] in self?.perform("prepare") }
        case "network":
            add(tr("mac.connect_your_mac_and_iphone"), size: 23, bold: true)
            add(tr("mac.use_tailscale_to_connect_your_own_mac_and_iphone_sign_in_with_the_same_a"))
            if yes("tailscaleInstalled") {
                button(tr("mac.open_tailscale"), primary: true) { [weak self] in self?.openTailscale() }
            } else {
                button(tr("mac.install_tailscale"), primary: true) { [weak self] in self?.open("https://tailscale.com/download/mac") }
            }
            button(tr("mac.connected_continue")) { [weak self] in self?.inspect() }
        case "networkConflict":
            add(tr("mac.review_existing_network_settings"), size: 23, bold: true)
            add(tr("mac.existing_settings_are_in_use_for_another_purpose_dot_link_has_not_overwr"))
            button(tr("mac.check_again"), primary: true) { [weak self] in self?.inspect() }
        case "dot":
            add(tr("mac.connect_your_existing_dot"), size: 23, bold: true)
            add(tr("mac.create_a_connection_for_this_mac_in_openai_settings_paste_its_tunnel_id"))
            add(tr("mac.keep_connections_already_used_by_another_mac_create_a_separate_one_for_t"), size: 13)
            button(tr("mac.open_openai_connection_settings")) { [weak self] in self?.open("https://platform.openai.com/settings/organization/tunnels") }
            add(tr("mac.when_creating_the_api_key_choose_restricted_under_permissions_and_enable"), size: 14, bold: true)
            add(tr("mac.the_api_key_used_by_this_app_does_not_need_manage_creating_a_new_tunnel"), size: 12)
            add(tr("mac.tunnel_id_starts_with_tunnel"), size: 13, bold: true)
            let id = field("tunnel_…"); id.stringValue = tunnelID; tunnelField = id
            add(tr("mac.api_key_saved_only_on_this_mac"), size: 13, bold: true)
            let secret = field("sk-…", secure: true); secretField = secret
            button(tr("mac.save_and_continue"), primary: true) { [weak self] in
                guard let self else { return }; self.tunnelID = self.tunnelField?.stringValue ?? ""; let key = self.secretField?.stringValue ?? ""; self.secretField?.stringValue = ""
                self.perform("save-tunnel", input: ["id": self.tunnelID, "secret": key])
            }
        case "start":
            add(yes("lifecycleStopped") ? tr("mac.dot_link_is_paused") : tr("mac.start_your_relay"), size: 23, bold: true)
            if yes("lifecycleStopped") {
                connectionCards(paused: true)
            } else {
                add(tr("mac.start_dot_link_on_this_mac_and_enable_it_at_login_the_relay_works_while"))
            }
            button(yes("lifecycleStopped") ? tr("mac.resume") : tr("mac.start_relay"), primary: true) { [weak self] in self?.menuResume() }
        case "subscribe":
            add(tr("mac.set_up_the_connection_in_chatgpt"), size: 23, bold: true)
            add(tr("mac.1_add_the_plugin"), size: 16, bold: true)
            add(tr("mac.plugins_add_add_custom_mcp_server"))
            add(tr("mac.name_dot_link_or_a_name_of_your_choice_nconnection_tunnel_select_this_ma"))
            add(tr("mac.review_and_check_i_understand_and_want_to_continue_nclick_create_as_a_pl"))
            button(tr("mac.open_chatgpt_plugins")) { [weak self] in self?.open("https://chatgpt.com/plugins") }
            space()
            add(tr("mac.2_send_the_setup_message_to_your_dot"), size: 16, bold: true)
            add(tr("mac.home_your_dot_in_the_message_box_select_your_plugin_ncopy_the_message_be"))
            button(tr("mac.copy_setup_message")) { [weak self] in self?.copySetupMessage() }
            space()
            add(tr("mac.3_return_here_to_check_the_connection"), size: 16, bold: true)
            add(tr("mac.when_your_dot_confirms_setup_is_complete_click_below"))
            button(tr("mac.check_connection_to_dot"), primary: true) { [weak self] in self?.inspect() }
        case "pair":
            add(tr("mac.connections"), size: 22, bold: true)
            connectionCards()
            let actions = NSStackView(); actions.orientation = .horizontal; actions.spacing = 12
            let pairing = ActionButton(yes("evenPaired") ? tr("mac.even_connection_settings_206") : tr("mac.connect_even")) { [weak self] in self?.menuPair() }
            pairing.controlSize = .large; pairing.keyEquivalent = "\r"; actions.addArrangedSubview(pairing)
            let notificationSettings = ActionButton(tr("mac.notifications")) { [weak self] in self?.menuNotifications() }
            notificationSettings.controlSize = .large; notificationSettings.image = NSImage(systemSymbolName: "bell", accessibilityDescription: nil); notificationSettings.imagePosition = .imageLeading
            notificationSettings.isEnabled = notifications != nil; actions.addArrangedSubview(notificationSettings)
            let speechSettings = ActionButton(tr("mac.speech_input")) { [weak self] in self?.menuSpeech() }
            speechSettings.controlSize = .large; speechSettings.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil); speechSettings.imagePosition = .imageLeading
            actions.addArrangedSubview(speechSettings)
            let outputSettings = ActionButton(tr("mac.speech_output")) { [weak self] in self?.menuSpeechOutput() }
            outputSettings.controlSize = .large; outputSettings.image = NSImage(systemSymbolName: "speaker.wave.2", accessibilityDescription: nil); outputSettings.imagePosition = .imageLeading
            actions.addArrangedSubview(outputSettings)
            stack.addArrangedSubview(actions)
        case "updateRecovery":
            add(tr("mac.the_relay_has_not_recovered_after_the_update"), size: 23, bold: true)
            add(tr("mac.your_settings_and_history_are_preserved_check_the_network_connection_and"))
            button(tr("mac.retry_recovery"), primary: true) { [weak self] in self?.perform("update-recover") }
        case "conflict":
            add(tr("mac.review_previous_settings"), size: 23, bold: true)
            add(tr("mac.multiple_installations_or_conflicting_login_services_were_found_nothing"))
            button(tr("mac.check_again"), primary: true) { [weak self] in self?.inspect() }
        default:
            add(tr("mac.check_setup"), size: 23, bold: true)
            button(tr("mac.check"), primary: true) { [weak self] in self?.inspect() }
        }
        space()
        if step != "pair" && step != "subscribe" && !yes("lifecycleStopped") { let footer = label(tr("mac.finish_mac_and_dot_setup_before_pairing_your_iphone"), size: 12); footer.textColor = .secondaryLabelColor; stack.addArrangedSubview(footer) }
        let footer = NSStackView(); footer.orientation = .horizontal; footer.spacing = 10
        if let checked = lastChecked {
            let f = DateFormatter(); f.locale = Locale(identifier: Localization.shared.metadata[language]?.dateLocale ?? "en_US"); f.timeStyle = .medium
            let checkedLabel = label(tr("mac.last_checked") + f.string(from: checked), size: 12); checkedLabel.textColor = .secondaryLabelColor; footer.addArrangedSubview(checkedLabel)
        }
        if step != "checking" {
            let refresh = ActionButton("") { [weak self] in self?.inspect() }; refresh.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: tr("mac.refresh_status")); refresh.isBordered = false; refresh.toolTip = tr("mac.refresh_status"); refresh.setAccessibilityLabel(refresh.toolTip!); footer.addArrangedSubview(refresh)
        }
        let footerSpace = NSView(); footerSpace.setContentHuggingPriority(.defaultLow, for: .horizontal); footer.addArrangedSubview(footerSpace)
        let details = ActionButton("") { [weak self] in self?.showingDetails = true; self?.messageRecord = nil; self?.render() }; details.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: tr("mac.advanced_settings")); details.isBordered = false; details.toolTip = tr("mac.advanced_settings"); details.setAccessibilityLabel(details.toolTip!); footer.addArrangedSubview(details)
        stack.addArrangedSubview(footer); footer.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
    }
    @objc func changeLanguage(_ sender: NSPopUpButton) { speechEndpointDraft = speechEndpointField?.stringValue ?? speechEndpointDraft; language = Localization.shared.languages[sender.indexOfSelectedItem]; UserDefaults.standard.set(language, forKey: "setupLanguage"); appUpdater?.refreshLanguage(); notifications?.refreshLanguage(); updateAppMenu(); render() }
    func inspect() { perform("inspect") }
    func refreshVisiblePairing() {
        guard showingPairing, window.isVisible, yes("installed"), !busy,
              !pairingRefreshPending, appUpdater?.blocksActions != true,
              Date().timeIntervalSince(pairingRefreshAt) >= 3 else { return }
        pairingRefreshPending = true; pairingRefreshAt = Date()
        let generation = pairingRefreshGeneration
        updateHelper("inspect") { [weak self] value in
            guard let self else { return }
            self.pairingRefreshPending = false
            guard generation == self.pairingRefreshGeneration, !self.busy, self.showingPairing else { return }
            let keys = ["evenPairingKnown", "evenPaired", "evenPairingCount", "evenInvitationCount"]
            let previousCount = self.state["evenPairingCount"] as? Int ?? 0
            let refreshed: [String: Any] = value["kind"] as? String == "result" ? value : ["evenPairingKnown": false]
            var changed = false
            for key in keys {
                guard let next = refreshed[key] as? NSNumber else { continue }
                if (self.state[key] as? NSNumber) != next { changed = true; self.state[key] = next }
            }
            if refreshed["evenPairingKnown"] as? Bool == true,
               (refreshed["evenPairingCount"] as? Int ?? 0) > previousCount,
               self.pairingCode != nil, (refreshed["evenInvitationCount"] as? Int ?? 0) == 0 {
                self.pairingCode = nil; self.pairingExpiry = 0
                self.messageRecord = LocalizedMessage("mac.even_connected")
                changed = true
            }
            if changed { self.render() }
        }
    }
    func renderPairingSettings() {
        add(tr("mac.even_connection_settings_206"), size: 22, bold: true)
        button(tr("mac.back_to_connection_status")) { [weak self] in self?.showHome() }
        let count = state["evenPairingCount"] as? Int ?? 0
        let invitations = state["evenInvitationCount"] as? Int ?? 0
        add(yes("evenPairingKnown") ? (count > 0 ? tr("mac.saved_connections_count", ["count": String(count)]) : tr("mac.no_saved_connections")) : tr("mac.saved_connections_could_not_be_checked"), size: 16, bold: true)
        if count > 1 { add(tr("mac.this_may_include_older_registrations_for_the_same_device_it_is_not_a_dev")) }
        if step == "pair" {
            button(count > 0 ? tr("mac.change_or_add_a_connection") : tr("mac.create_pairing_code"), primary: true) { [weak self] in self?.perform("pair") }
            if let code = pairingCode, pairingExpiry > Date().timeIntervalSince1970 * 1000 {
                let codeView = SetupWindowLayout.pairingCode(code)
                stack.addArrangedSubview(codeView.scroll)
                codeView.scroll.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
                codeField = codeView.field
                copyButton = button(tr("mac.copy_pairing_code")) { [weak self] in self?.copyPairing() }
                let l = label(""); expiryLabel = l; stack.addArrangedSubview(l)
                add(tr("mac.paste_the_full_code_into_dot_link_in_the_even_app_and_tap_connect_existi"))
                updateExpiry()
            }
        } else {
            add(tr("mac.to_pair_again_return_to_connection_status_and_finish_mac_and_dot_setup_y"))
        }
        if invitations > 0 { add(tr("mac.unused_pairing_codes_invitations", ["invitations": String(invitations)]), size: 12) }
        space()
        if count > 0 || invitations > 0 || !yes("evenPairingKnown") {
            button(tr("mac.remove_all_even_connections")) { [weak self] in self?.confirmPairingRemoval() }
        }
        button(tr("mac.refresh_status")) { [weak self] in self?.inspect() }
    }
    func confirmPairingRemoval() {
        guard !busy, appUpdater?.blocksActions != true else { return }
        let alert = NSAlert(); alert.alertStyle = .warning
        alert.messageText = tr("mac.remove_all_even_connections_230")
        alert.informativeText = tr("mac.this_invalidates_all_even_connections_registered_with_this_mac_s_pairing")
        alert.addButton(withTitle: tr("mac.remove_all"))
        alert.addButton(withTitle: tr("mac.cancel"))
        alert.buttons[0].keyEquivalent = ""
        alert.buttons[1].keyEquivalent = "\r"
        if alert.runModal() == .alertFirstButtonReturn { perform("revoke-pairings") }
    }
    func openTailscale() {
        for path in ["/Applications/Tailscale.app", NSHomeDirectory() + "/Applications/Tailscale.app"] {
            if FileManager.default.fileExists(atPath: path) { NSWorkspace.shared.open(URL(fileURLWithPath: path)); return }
        }
        open("https://tailscale.com/download/mac")
    }
    func copySetupMessage() {
        let text = tr("mac.use_this_mac_s_dot_link_connection_to_receive_messages_from_my_even_g2_t")
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string); messageRecord = LocalizedMessage("mac.setup_message_copied_paste_and_send_it_to_your_existing_dot"); render()
    }
    func copyPairing() {
        guard let code = pairingCode, pairingExpiry > Date().timeIntervalSince1970 * 1000 else { updateExpiry(); return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(code, forType: .string)
        expiryLabel?.stringValue = tr("mac.copied_paste_it_on_your_iphone")
    }
    func updateExpiry() {
        guard pairingCode != nil else { return }
        let seconds = max(0, Int((pairingExpiry - Date().timeIntervalSince1970 * 1000) / 1000))
        if seconds == 0 {
            pairingCode = nil; codeField?.stringValue = ""; copyButton?.isEnabled = false
            expiryLabel?.stringValue = tr("mac.expired_create_a_new_pairing_code")
        } else { expiryLabel?.stringValue = tr("mac.seconds_seconds_remaining_one_use", ["seconds": String(seconds)]) }
    }
    func copySetupDiagnostics() {
        guard let text = setupFailure.details?.copyText(appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String) else { return }
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        setupFailure.copied = true; render()
    }
    func perform(_ action: String, input: [String: String] = [:]) {
        guard !busy, appUpdater?.blocksActions != true else { return }; busy = true; currentAction = action; messageRecord = nil
        pairingRefreshGeneration += 1
        setupFailure.begin(action)
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
            progressLabel?.stringValue = value["task"] as? String == "model" ? tr("mac.preparing_speech_recognition_pct", ["pct": String(pct)]) : tr("mac.preparing_dot_link")
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
                let alert = NSAlert(); alert.messageText = tr("mac.dot_link_was_uninstalled")
                alert.informativeText = tr("mac.dot_link_has_stopped_on_this_mac_removed_files_are_in_trash")
                if preferencesRetained { alert.informativeText += "\n" + tr("mac.mac_display_and_notification_preferences_were_kept_because_their_backup") }
                alert.runModal(); allowTermination = true; NSApp.terminate(nil); return
            }
            if let plan = value["uninstallPlan"] as? [String: Any] { render(); confirmUninstall(plan); return }
            state = value; lastChecked = Date()
            var showAfterUpdate = false
            if currentAction == "update-recover" {
                showAfterUpdate = appUpdater?.startupRecoveryFinished(success: AppUpdater.recoveredStateIsReady(value)) ?? false
            }
            if currentAction == "revoke-pairings" {
                pairingCode = nil; pairingExpiry = 0
                switch value["pairingRemoval"] as? String {
                case "removed":
                    messageRecord = LocalizedMessage("mac.all_even_connections_were_removed_use_a_new_pairing_code_to_reconnect_yo")
                case "changed":
                    messageRecord = LocalizedMessage("mac.a_new_connection_or_code_was_found_after_removal_review_the_current_save")
                case "failed":
                    messageRecord = LocalizedMessage("mac.connections_could_not_be_removed_removal_is_not_confirmed_please_try_aga")
                default:
                    messageRecord = LocalizedMessage("mac.the_state_after_removal_could_not_be_verified_refresh_the_status_then_re")
                }
            }
            if currentAction == "stt-select" {
                messageRecord = nil // The active provider is already shown at the top of Speech input.
            }
            if currentAction == "inspect" { messageRecord = nil } // The timestamp and cards show the refreshed result.
            connectNotifications()
            notifications?.setRelaySuspended(yes("lifecycleStopped") || !yes("bridge"))
            notifications?.healthChecked = true
            notifications?.healthReady = yes("bridge") && yes("subscribed")
            notifications?.updateState()
            if migratingNotifications { migratingNotifications = false; notifications?.migrationFinished(); messageRecord = LocalizedMessage("mac.notifications_moved_the_old_app_will_no_longer_start_at_login") }
            if let code = value["pairingCode"] as? String { pairingCode = code; pairingExpiry = value["expiresAt"] as? Double ?? 0 }
            render()
            if showAfterUpdate { showWindow() }
            if automaticResumePending {
                automaticResumePending = false
                if yes("servicesConfigured") && yes("lifecycleStopped") && state["lifecycleReason"] as? String == "quit" { perform("resume") }
            }
        case "error":
            busy = false; helper = nil; automaticResumePending = false
            if currentAction == "update-recover" { appUpdater?.startupRecoveryFinished(success: false) }
            if quitting { quitting = false; NSApp.reply(toApplicationShouldTerminate: false); showWindow() }
            if migratingNotifications { migratingNotifications = false; notifications?.migrationFailed() }
            let code = value["code"] as? String ?? "SETUP_FAILED"
            if code == "UPDATE_RECOVERY_REQUIRED" { state["step"] = "updateRecovery" }
            if ["MULTIPLE_INSTALLATIONS", "EXISTING_SERVICE_CONFLICT", "EXISTING_SERVICE_UNREADABLE", "INSTALL_FOLDER_OCCUPIED"].contains(code) { state["step"] = "conflict" }
            messageRecord = LocalizedMessage("mac.setup_could_not_complete_existing_settings_have_been_preserved_check_the", suffix: " (\(code))")
            if currentAction == "activate" {
                messageRecord = LocalizedMessage("mac.relay_setup_could_not_complete_check_the_current_status_before_retrying", suffix: " (\(code))")
                if let failure = value["failure"] as? [String: Any] {
                    setupFailure.details = SetupFailureDetails(value: failure, catalogURL: payload.appendingPathComponent("scripts/lib/setup-errors.json"))
                }
                if setupFailure.details != nil { messageRecord = nil } // Render the retained failure separately from transient status messages.
            }
            if currentAction == "stt-select" { messageRecord = LocalizedMessage("mac.could_not_switch_services_please_try_again") }
            if currentAction == "revoke-pairings" {
                pairingCode = nil; pairingExpiry = 0
                state["evenPairingKnown"] = false
                messageRecord = LocalizedMessage("mac.the_removal_result_could_not_be_confirmed_refresh_the_status_then_retry")
            }
            if ["shutdown", "pause", "uninstall"].contains(currentAction) {
                messageRecord = LocalizedMessage("mac.the_operation_could_not_complete_dot_link_remains_open_check_the_stop_or", suffix: " (\(code))")
            }
            render()
        default: break
        }
    }
}
if CommandLine.arguments.contains("--stt-credential") { runSTTCredentialHelper() }
if NSRunningApplication.runningApplications(withBundleIdentifier: "app.tripsurf.dotlink.mac").contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) { exit(0) }
let app = NSApplication.shared
let delegate = SetupApp(); app.delegate = delegate; app.run()
