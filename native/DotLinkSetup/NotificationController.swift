import AppKit
import ApplicationServices
import UserNotifications

final class NotificationSourcesStack: NSStackView { override var isFlipped: Bool { true } }

// This prototype reads only Notification Center accessibility elements. It never
// opens chats or invokes AX actions. Selected synthetic probes go to the local bridge.
final class NotificationController: NSObject, UNUserNotificationCenterDelegate {
    let stateLabel = NSTextField(wrappingLabelWithString: "")
    let connectionLabel = NSTextField(wrappingLabelWithString: "接続を確認しています…")
    let summaryItem = NSMenuItem(title: "接続を確認しています…", action: nil, keyEquivalent: "")
    var tailscaleButton: NSButton!
    let pauseItem = NSMenuItem(title: "通知を開始", action: #selector(togglePause), keyEquivalent: "")
    let results = NSTextView()
    let apps = NotificationSourcesStack()
    var selected = Set<String>()
    var paused = true
    var relaySuspended = false
    var forwardingTasks: [String: URLSessionDataTask] = [:]
    var activityGeneration = 0
    var observer: AXObserver?
    var observedPID: pid_t = 0
    var observers: [NSObjectProtocol] = []
    var seen: [String: Date] = [:]
    var entries: [String] = []
    var eventCount = 0
    var candidateCount = 0
    var testCount = 0
    var registrations: [String] = []
    var pendingScan = false
    var appNames: [String] = []
    var notificationPermission = "確認中"
    var healthReady = false
    var healthChecked = false
    var healthIssues: [String] = []
    var helperRunning = false
    var pendingHelper: (() -> Void)?
    var healthTimer: Timer?
    var currentIcon = DotStatus.checking
    var setupMessage = ""
    struct Probe: Codable {
        let id: String
        let body: String
        let dueAt: Double
        var registered = false
        var detectedAt: Double?
        var bodyMatched = false
        var selectedAtDetection: Bool?
        var sourceLabelMatched = false
        var observations = 0
        var attributes: [String] = []
        var notificationID = UUID().uuidString.lowercased()
        var forwarding = "未送信"
    }
    var probes: [String: Probe] = [:]
    var batchUntil: Date = .distantPast
    let projectURL: URL
    var diagnosticURL: URL { projectURL.appendingPathComponent(".runtime/notification-menu-unified/diagnostics.json") }
    var defaults = UserDefaults.standard
    var changed: (() -> Void)?
    var requestMigration: (() -> Void)?
    var legacyRunning: Bool
    var validating = false
    var migrationRequested = false
    var testScheduled = false
    var migrationProbe: String?
    var settingsView: NSView?
    var detailsVisible = false
    var tr: (String, String) -> String = { ja, _ in ja }
    var notificationSummary: String {
        if relaySuspended { return tr("Dot Linkは一時停止中", "Dot Link is paused") }
        if legacyRunning { return tr("旧アプリから引き継ぎ待ち", "Waiting to move notifications") }
        if paused { return tr("通知は一時停止中", "Notifications paused") }
        if !AXIsProcessTrusted() { return tr("通知の許可が必要です", "Notification access needed") }
        return observer == nil ? tr("通知を確認中", "Checking notifications") : tr("通知を監視中", "Watching notifications")
    }
    init(project: URL, legacyRunning: Bool, relaySuspended: Bool = false) {
        self.projectURL = project; self.legacyRunning = legacyRunning; self.relaySuspended = relaySuspended
        super.init()
        // Read legacy preferences once; never change the old application's domain.
        if defaults.object(forKey: "notificationSettingsImported") == nil {
            let old = defaults.persistentDomain(forName: "local.even-g2-dot.notification-lab") ?? [:]
            defaults.set(old["selectedApps"] as? [String] ?? ["Dot Notification Lab"], forKey: "selectedApps")
            var previousPaused = old["monitoringPaused"] as? Bool
            if previousPaused == nil, let data = try? Data(contentsOf: project.appendingPathComponent(".runtime/notification-menu/diagnostics.json")), let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { previousPaused = record["paused"] as? Bool }
            defaults.set(previousPaused ?? true, forKey: "monitoringPaused")
            defaults.set(true, forKey: "notificationSettingsImported")
        }
        selected = Set(defaults.stringArray(forKey: "selectedApps") ?? ["Dot Notification Lab"])
        paused = defaults.bool(forKey: "monitoringPaused")
        try? FileManager.default.createDirectory(at: diagnosticURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        UNUserNotificationCenter.current().delegate = self
        let nc = NSWorkspace.shared.notificationCenter
        observers.append(nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.attach() })
        observers.append(nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.attach() })
        observers.append(nc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.refresh() })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.refresh() })
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.attach(); self?.continueMigration() }
        healthTimer?.tolerance = 2
        refresh()
    }
    func setRelaySuspended(_ value: Bool) {
        relaySuspended = value
        if value {
            activityGeneration += 1
            validating = false; migrationRequested = false; testScheduled = false
            detach()
            for task in forwardingTasks.values { task.cancel() }; forwardingTasks.removeAll()
            UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: Array(probes.keys))
        } else { attach() }
        updateState()
    }
    func shutdown() {
        setRelaySuspended(true)
        detach(); healthTimer?.invalidate()
        for token in observers { NSWorkspace.shared.notificationCenter.removeObserver(token); NotificationCenter.default.removeObserver(token) }
    }
    @objc func beginMigration() {
        guard !relaySuspended, !migrationRequested else { return }
        migrationRequested = true
        if !AXIsProcessTrusted() { openPermission() }
        continueMigration(); updateState()
    }
    func continueMigration() {
        guard !relaySuspended, migrationRequested, legacyRunning, AXIsProcessTrusted(), !testScheduled else { return }
        // Temporary probe observation: the old process only forwards its own markers.
        validating = true; attach()
        guard observer != nil else { return }
        testScheduled = true; scheduleTests(count: 1)
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
            guard let self, self.validating else { return }
            self.add(self.tr("通知テストを確認できませんでした。旧アプリはそのまま動いています。", "The notification test did not complete. The old app is still running."))
            self.migrationFailed()
        }
    }
    func migrationFinished() {
        legacyRunning = false; migrationRequested = false; validating = false; testScheduled = false
        if paused { detach() } else { attach() }
        updateState()
    }
    func migrationFailed() {
        migrationRequested = false; validating = false; testScheduled = false
        detach(); updateState()
        rebuildView?()
    }
    func button(_ title: String, _ action: Selector) -> NSButton {
        NSButton(title: title, target: self, action: action)
    }
    func text(_ value: String, size: CGFloat = 13, secondary: Bool = false) -> NSTextField {
        let v = NSTextField(wrappingLabelWithString: value); v.font = .systemFont(ofSize: size)
        v.textColor = secondary ? .secondaryLabelColor : .labelColor
        v.setContentCompressionResistancePriority(.required, for: .vertical); return v
    }
    func symbol(_ name: String) -> NSImageView {
        let v = NSImageView(); v.image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 23, weight: .regular)); v.contentTintColor = .secondaryLabelColor
        v.widthAnchor.constraint(equalToConstant: 32).isActive = true; v.heightAnchor.constraint(equalToConstant: 32).isActive = true; return v
    }
    func card(_ root: NSStackView, title: String, icon: String, help: String) -> NSStackView {
        let body = NSStackView(); body.orientation = .vertical; body.alignment = .leading; body.spacing = 12; body.edgeInsets = NSEdgeInsets(top: 16, left: 18, bottom: 16, right: 18)
        let heading = NSStackView(); heading.spacing = 12; heading.addArrangedSubview(symbol(icon))
        let titleLabel = text(title, size: 15); titleLabel.font = .systemFont(ofSize: 15, weight: .semibold); heading.addArrangedSubview(titleLabel)
        let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal); heading.addArrangedSubview(spacer)
        heading.addArrangedSubview(HelpButton(title + tr("について", " help"), help)); body.addArrangedSubview(heading)
        heading.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -36).isActive = true
        let box = NSBox(); box.boxType = .custom; box.borderColor = .separatorColor; box.borderWidth = 0.5; box.cornerRadius = 12; box.fillColor = .controlBackgroundColor; box.contentViewMargins = .zero; box.contentView = body
        root.addArrangedSubview(box); box.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        box.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        return body
    }
    func makeView() -> NSView {
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 14
        root.translatesAutoresizingMaskIntoConstraints = false
        let heading = text(tr("通知設定", "Notifications"), size: 22); heading.font = .systemFont(ofSize: 22, weight: .semibold); root.addArrangedSubview(heading)
        let status = card(root, title: tr("通知の状態", "Notification status"), icon: "bell", help: tr("選んだMacの通知をDotへ渡す機能です。通知の許可とMacの中継が必要です。現在はDot Linkのテスト通知に対応しています。", "Send selected Mac notifications to Dot. Notification access and the Mac relay are required. Currently, only Dot Link test notifications are supported."))
        connectionLabel.font = .systemFont(ofSize: 13); connectionLabel.maximumNumberOfLines = 0; connectionLabel.lineBreakMode = .byWordWrapping
        status.addArrangedSubview(connectionLabel); connectionLabel.widthAnchor.constraint(equalTo: status.widthAnchor, constant: -36).isActive = true
        let controls = NSStackView(); controls.spacing = 10
        if legacyRunning {
            controls.addArrangedSubview(button(tr("通知を引き継ぐ", "Move notifications"), #selector(beginMigration)))
            status.addArrangedSubview(text(tr("対象と一時停止の設定を引き継ぎ、確認後に旧アプリを終了します。", "Keep your sources and pause setting. The old app closes after verification."), size: 12, secondary: true))
        } else {
            controls.addArrangedSubview(button(paused ? tr("通知を開始", "Start notifications") : tr("一時停止", "Pause"), #selector(togglePause)))
        }
        controls.addArrangedSubview(button(tr("権限設定", "Permissions"), #selector(openPermission)))
        let refreshButton = button("", #selector(refresh)); refreshButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil); refreshButton.isBordered = false; refreshButton.toolTip = tr("状態を確認", "Check status"); refreshButton.setAccessibilityLabel(refreshButton.toolTip!); controls.addArrangedSubview(refreshButton); status.addArrangedSubview(controls)
        let sources = card(root, title: tr("通知の対象", "Notification sources"), icon: "square.grid.2x2", help: tr("チェックしたアプリを通知の対象として保存します。「準備中」のアプリは選択を保存できますが、通知の転送にはまだ対応していません。", "Checked apps are saved as notification sources. Apps marked Coming soon can be selected, but their notifications are not forwarded yet."))
        sources.addArrangedSubview(text(tr("現在はテスト通知のみ対応", "Currently supports test notifications only"), size: 12, secondary: true))
        apps.orientation = .vertical; apps.alignment = .leading; apps.spacing = 8
        let appScroll = NSScrollView(); appScroll.hasVerticalScroller = true; appScroll.drawsBackground = false; appScroll.documentView = apps; apps.translatesAutoresizingMaskIntoConstraints = false
        apps.widthAnchor.constraint(equalTo: appScroll.contentView.widthAnchor).isActive = true
        appScroll.heightAnchor.constraint(equalToConstant: 116).isActive = true; sources.addArrangedSubview(appScroll); appScroll.widthAnchor.constraint(equalTo: sources.widthAnchor, constant: -36).isActive = true
        let test = card(root, title: tr("動作確認", "Try a notification"), icon: "paperplane", help: tr("テスト通知をこのMacに表示し、検知とDotへの転送を確認します。OSの通知表示許可も必要です。Dotからの案内やG2での表示は、実際に届いた内容を確認してください。", "Display a test notification on this Mac to check detection and forwarding to Dot. macOS notification permission is also required. Check the actual message to confirm Dot's response and its display on G2."))
        test.addArrangedSubview(button(tr("テスト通知を送る", "Send test notification"), #selector(sendTest)))
        let details = button(detailsVisible ? tr("詳細を閉じる", "Hide details") : tr("検知結果と詳細", "Detection details"), #selector(toggleDetails)); details.isBordered = false; details.image = NSImage(systemSymbolName: detailsVisible ? "chevron.down" : "chevron.right", accessibilityDescription: nil); details.imagePosition = .imageLeading; details.setAccessibilityLabel(details.title); root.addArrangedSubview(details)
        if detailsVisible {
            root.addArrangedSubview(stateLabel)
            let scroll = NSScrollView(); scroll.hasVerticalScroller = true; results.isEditable = false; results.font = .monospacedSystemFont(ofSize: 12, weight: .regular); results.autoresizingMask = [.width]; scroll.documentView = results
            scroll.heightAnchor.constraint(equalToConstant: 180).isActive = true; root.addArrangedSubview(scroll); scroll.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
            root.addArrangedSubview(button(tr("連続テスト（5件）", "Test 5 notifications"), #selector(sendBatch)))
        }
        settingsView = root; reloadApps(); updateState(); return root
    }
    var rebuildView: (() -> Void)?
    @objc func toggleDetails() { detailsVisible.toggle(); rebuildView?() }
    func reloadApps() {
        appNames = Array(Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { $0.localizedName } + ["Dot Notification Lab", "LINE", "Mail", "Slack"])).sorted { a, b in a == b ? false : a == "Dot Notification Lab" ? true : b == "Dot Notification Lab" ? false : a < b }
        for view in apps.arrangedSubviews { apps.removeArrangedSubview(view); view.removeFromSuperview() }
        for name in appNames {
            let check = NSButton(checkboxWithTitle: name == "Dot Notification Lab" ? tr("Dot Link（テスト通知）", "Dot Link (test notifications)") : name, target: self, action: #selector(selectApp(_:)))
            check.identifier = NSUserInterfaceItemIdentifier(name)
            check.state = selected.contains(name) ? .on : .off
            check.isEnabled = !legacyRunning
            let row = NSStackView(); row.spacing = 10; row.addArrangedSubview(check)
            let spacer = NSView(); spacer.setContentHuggingPriority(.defaultLow, for: .horizontal); row.addArrangedSubview(spacer)
            row.addArrangedSubview(text(name == "Dot Notification Lab" ? tr("対応", "Supported") : tr("準備中", "Coming soon"), size: 11, secondary: true))
            apps.addArrangedSubview(row); row.widthAnchor.constraint(equalTo: apps.widthAnchor, constant: -8).isActive = true
        }
    }
    @objc func selectApp(_ sender: NSButton) {
        let name = sender.identifier?.rawValue ?? sender.title
        if sender.state == .on { selected.insert(name) } else { selected.remove(name) }
        defaults.set(Array(selected).sorted(), forKey: "selectedApps")
        updateState()
    }
    @objc func openPermission() {
        // Trigger only on this explicit user action; never grant permission itself.
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
    @objc func togglePause() {
        guard !legacyRunning else { return }
        paused.toggle()
        defaults.set(paused, forKey: "monitoringPaused")
        if paused { detach() } else { attach() }
        updateState(); rebuildView?()
    }
    @objc func refresh() {
        reloadApps(); attach(); updateState()
        continueMigration()
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            DispatchQueue.main.async {
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral: self.notificationPermission = "許可済み"
                case .denied: self.notificationPermission = "未許可（システム設定 → 通知で変更）"
                case .notDetermined: self.notificationPermission = "未設定"
                @unknown default: self.notificationPermission = "不明"
                }
                self.updateState()
            }
        }
    }
    func updateState() {
        stateLabel.stringValue = "アクセシビリティ: \(AXIsProcessTrusted() ? "許可済み" : "未許可")　検知: \(paused ? "一時停止" : observer == nil ? "接続待ち" : "監視中")\nイベント \(eventCount) 件 / 新規候補 \(candidateCount) 件 / テスト要求 \(testCount) 件\n監視登録: \(registrations.isEmpty ? "なし" : registrations.joined(separator: ", "))"
        var reasons = healthIssues
        if !paused && !AXIsProcessTrusted() { reasons.append("通知を再開するにはアクセシビリティを許可してください。") }
        else if !paused && observer == nil { reasons.append("通知の監視に再接続しています。") }
        if probes.values.contains(where: { $0.forwarding.hasPrefix("送信未確認") || $0.forwarding == "通知用接続設定なし" }) {
            reasons.append("中継への転送を確認できないテスト通知があります。検知結果を確認してください。")
        }
        currentIcon = !healthChecked ? .checking : !healthReady || !reasons.isEmpty ? .attention : paused ? .paused : .ready
        connectionLabel.stringValue = notificationSummary + (migrationRequested && !AXIsProcessTrusted() ? tr("\nシステム設定でDot Linkを許可してください。戻ると引き継ぎを続けます。", "\nAllow Dot Link in System Settings. Migration continues when you return.") : "")
        changed?()
        stateLabel.stringValue += "\nテスト通知の表示権限: \(notificationPermission)"
        saveDiagnostics()
    }
    func saveDiagnostics() {
        struct Diagnostic: Codable {
            let version: Int, pid: Int32
            let updatedAt: Double
            let trusted: Bool, paused: Bool, observing: Bool, relaySuspended: Bool
            let notificationPermission: String
            let eventCount: Int, candidateCount: Int
            let selectedApps: [String], registrations: [String]
            let icon: String, connectionReady: Bool
            let probes: [Probe]
        }
        let record = Diagnostic(version: 1, pid: ProcessInfo.processInfo.processIdentifier,
            updatedAt: Date().timeIntervalSince1970, trusted: AXIsProcessTrusted(), paused: paused,
            observing: observer != nil, relaySuspended: relaySuspended, notificationPermission: notificationPermission,
            eventCount: eventCount, candidateCount: candidateCount, selectedApps: selected.sorted(),
            registrations: registrations, icon: currentIcon.rawValue, connectionReady: healthReady,
            probes: probes.values.sorted { $0.dueAt < $1.dueAt })
        do {
            let data = try JSONEncoder().encode(record)
            try data.write(to: diagnosticURL, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: diagnosticURL.path)
        } catch { /* Diagnostics must not stop notification observation. */ }
    }
    func detach() {
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
        observer = nil; observedPID = 0; registrations = []
    }
    func attach() {
        guard !relaySuspended, (validating || (!legacyRunning && !paused)), AXIsProcessTrusted() else { detach(); updateState(); return }
        guard let target = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.notificationcenterui").first else { detach(); updateState(); return }
        if observer != nil && observedPID == target.processIdentifier { return }
        detach()
        var created: AXObserver?
        let result = AXObserverCreate(target.processIdentifier, { _, _, _, ref in
            guard let ref else { return }
            Unmanaged<NotificationController>.fromOpaque(ref).takeUnretainedValue().onEvent()
        }, &created)
        guard result == .success, let created else { add("監視作成失敗: \(result.rawValue)"); return }
        let element = AXUIElementCreateApplication(target.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.3)
        let ref = Unmanaged.passUnretained(self).toOpaque()
        var registeredCount = 0
        registrations = [kAXWindowCreatedNotification, kAXLayoutChangedNotification, kAXUIElementDestroyedNotification].map { name in
            let error = AXObserverAddNotification(created, element, name as CFString, ref)
            if error == .success { registeredCount += 1 }
            return "\(name)=\(error.rawValue)"
        }
        guard registeredCount > 0 else { add("監視イベントが未対応です。検知は開始できません。"); updateState(); return }
        observer = created; observedPID = target.processIdentifier
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        updateState()
        // No initial scan: existing private notifications are not test arrivals.
    }
    func onEvent() {
        guard !relaySuspended, validating || (!legacyRunning && !paused) else { return }
        eventCount += 1
        guard !pendingScan else { return }
        pendingScan = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self else { return }; self.pendingScan = false
            if !self.relaySuspended && (self.validating || (!self.legacyRunning && !self.paused)) { self.scan() }
        }
    }
    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    func scan() {
        guard !relaySuspended, observedPID != 0, AXIsProcessTrusted() else { detach(); updateState(); return }
        let root = AXUIElementCreateApplication(observedPID)
        let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
        seen = seen.filter { Date().timeIntervalSince($0.value) < 120 }
        for window in windows.prefix(10) {
            var strings: [String] = []
            var attributeNames = Set<String>()
            var nodes = 0
            func walk(_ element: AXUIElement, _ depth: Int) {
                guard depth < 16, nodes < 400 else { return }; nodes += 1
                var names: CFArray?
                if AXUIElementCopyAttributeNames(element, &names) == .success,
                   let names = names as? [String] { attributeNames.formUnion(names) }
                for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
                    if let value = attribute(element, key) as? String, !value.isEmpty, !strings.contains(value) { strings.append(String(value.prefix(2000))) }
                }
                for child in (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []) { walk(child, depth + 1) }
            }
            walk(window, 0)
            guard !strings.isEmpty else { continue }
            let fingerprint = strings.joined(separator: "\u{1f}")
            guard seen[fingerprint] == nil else { continue }
            seen[fingerprint] = Date(); candidateCount += 1
            let matches = appNames.filter { name in strings.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) }
            // In the first probe, only our synthetic marker may reveal its body.
            // Unknown/mixed windows remain metadata-only to avoid misattribution.
            let markers = strings.filter { probes[$0] != nil }
            if !markers.isEmpty {
                for marker in markers {
                    guard var probe = probes[marker] else { continue }
                    probe.observations += 1
                    probe.bodyMatched = probe.bodyMatched || strings.contains(probe.body)
                    probe.sourceLabelMatched = probe.sourceLabelMatched || strings.contains("Dot Link")
                    probe.attributes = attributeNames.sorted()
                    if probe.detectedAt == nil {
                        probe.detectedAt = Date().timeIntervalSince1970
                        probe.selectedAtDetection = validating || selected.contains("Dot Notification Lab")
                        add("テスト通知をAXで検知: \(marker)\n本文一致: \(probe.bodyMatched ? "はい" : "いいえ") / 選択対象: \(probe.selectedAtDetection! ? "はい" : "対象外・除外") / 表示アプリ候補: \(matches.joined(separator: ", "))")
                    }
                    probes[marker] = probe
                    if probe.registered && probe.bodyMatched && probe.selectedAtDetection == true && probe.forwarding == "未送信" { forwardProbe(marker) }
                }
            } else {
                add("通知候補: アプリ候補 \(matches.isEmpty ? "不明" : matches.joined(separator: ", ")) / 文字列 \(strings.count) / 要素 \(nodes) — 本文非表示・転送保留")
            }
        }
        updateState()
    }
    func forwardProbe(_ marker: String, attempt: Int = 0) {
        guard !relaySuspended, (validating || (!legacyRunning && !paused)), AXIsProcessTrusted(), observer != nil,
              (validating || selected.contains("Dot Notification Lab")), let probe = probes[marker],
              probe.registered, probe.bodyMatched, probe.selectedAtDetection == true,
              let detectedAt = probe.detectedAt else { return }
        do {
            let runtime = projectURL.appendingPathComponent(".runtime")
            let key = try String(contentsOf: runtime.appendingPathComponent("notification-key"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !key.isEmpty else { throw NSError(domain: "NotificationKey", code: 1) }
            var request = URLRequest(url: URL(string: "http://127.0.0.1:3460/api/notifications")!)
            request.httpMethod = "POST"
            request.timeoutInterval = 20
            request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: [
                "id": probe.notificationID, "source_app": "Dot Notification Lab",
                "title": probe.id, "body": probe.body,
                "observed_at": ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: detectedAt)),
                "source_verification": "synthetic-test-marker"
            ])
            probes[marker]?.forwarding = "送信中"
            updateState()
            let generation = activityGeneration
            let task = URLSession.shared.dataTask(with: request) { _, response, error in
                DispatchQueue.main.async {
                    self.forwardingTasks.removeValue(forKey: marker)
                    guard !self.relaySuspended, self.activityGeneration == generation else { return }
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    if error == nil && (200..<300).contains(status) {
                        self.probes[marker]?.forwarding = "中継受領済み"
                        if self.validating && self.migrationProbe == marker { self.validating = false; self.detach(); self.saveDiagnostics(); self.requestMigration?() }
                        self.add("自動転送: \(marker) — 中継受領済み（Dotの案内・G2表示は別途確認）")
                    } else {
                        self.probes[marker]?.forwarding = "送信未確認 HTTP \(status)"
                        self.add("自動転送: \(marker) — 送信未確認 HTTP \(status)")
                        if attempt < 2 {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                                guard self.activityGeneration == generation else { return }
                                self.forwardProbe(marker, attempt: attempt + 1)
                            }
                        }
                    }
                    if attempt >= 2 && self.legacyRunning { self.migrationFailed() }
                    self.updateState()
                }
            }
            forwardingTasks[marker] = task; task.resume()
        } catch {
            probes[marker]?.forwarding = "通知用接続設定なし"
            add("自動転送: \(marker) — 通知用接続設定を確認してください")
            if legacyRunning { migrationFailed() }
            updateState()
        }
    }
    func add(_ message: String) {
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        entries.insert("\(time)  \(message)", at: 0)
        entries = Array(entries.prefix(50)); results.string = entries.joined(separator: "\n\n")
    }
    @objc func sendTest() { if legacyRunning { beginMigration() } else { scheduleTests(count: 1) } }
    @objc func sendBatch() { guard !legacyRunning else { return }; scheduleTests(count: 5) }
    func scheduleTests(count: Int) {
        guard !relaySuspended else { return }
        guard Date() >= batchUntil else { add("前の連続テストが完了するまでお待ちください。"); return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            DispatchQueue.main.async {
                guard !self.relaySuspended else { return }
                guard granted else { self.add("テスト通知の許可なし: \(error?.localizedDescription ?? "システム設定 → 通知で確認")"); self.testScheduled = false; self.migrationRequested = false; self.validating = false; self.detach(); self.refresh(); return }
                self.notificationPermission = "許可済み"
                self.batchUntil = Date().addingTimeInterval(Double(count * 4 + 5))
                for index in 0..<count {
                self.testCount += 1
                let id = "DOT-LAB-\(UUID().uuidString.prefix(8))"
                if self.validating { self.migrationProbe = id }
                let content = UNMutableNotificationContent()
                content.title = id
                content.body = "通知の読み取りテスト \(self.testCount)。選択・検知後にDotへ自動送信します。"
                let delay = Double(3 + index * 4)
                self.probes[id] = Probe(id: id, body: content.body, dueAt: Date().timeIntervalSince1970 + delay)
                let request = UNNotificationRequest(identifier: id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false))
                UNUserNotificationCenter.current().add(request) { error in
                    DispatchQueue.main.async { self.probes[id]?.registered = error == nil; self.add(error.map { "テスト通知登録エラー: \($0.localizedDescription)" } ?? "テスト通知をOSへ予約: \(id)（検知・表示の証明ではありません）"); self.updateState() }
                }
                }
                // Bound synthetic diagnostics for long-running interactive use.
                if self.probes.count > 100 {
                    let retained = self.probes.values.sorted { $0.dueAt > $1.dueAt }.prefix(100)
                    self.probes = Dictionary(uniqueKeysWithValues: retained.map { ($0.id, $0) })
                }
            }
        }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) { completionHandler([.banner, .list]) }
}
