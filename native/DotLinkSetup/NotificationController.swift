import AppKit
import ApplicationServices
import UserNotifications

final class NotificationSourcesStack: NSStackView { override var isFlipped: Bool { true } }

// This prototype reads only Notification Center accessibility elements. It never
// opens chats or invokes AX actions. Sharing readable notifications is explicitly opt-in.
final class NotificationController: NSObject, UNUserNotificationCenterDelegate {
    let stateLabel = NSTextField(wrappingLabelWithString: "")
    let connectionLabel = NSTextField(wrappingLabelWithString: "")
    let connectionStatusIcon = NSImageView()
    let summaryItem = NSMenuItem(title: "", action: nil, keyEquivalent: "")
    var tailscaleButton: NSButton!
    let pauseItem = NSMenuItem(title: "", action: #selector(togglePause), keyEquivalent: "")
    let results = NSTextView()
    let apps = NotificationSourcesStack()
    var selected = Set<String>()
    var shareAllNotifications = false
    var paused = true
    var relaySuspended = false
    var forwardingTasks: [String: URLSessionDataTask] = [:]
    var activityGeneration = 0
    var observer: AXObserver?
    var observedPID: pid_t = 0
    var observers: [NSObjectProtocol] = []
    var seen: [String: Date] = [:]
    var entries: [(Date, LocalizedMessage)] = []
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
    lazy var lineDelivery = NotificationForwarder(runtime: projectURL.appendingPathComponent(".runtime"),
        allowed: { [weak self] in
            guard let self else { return false }
            return !self.paused && !self.relaySuspended && !self.legacyRunning && self.shareAllNotifications && self.observer != nil && AXIsProcessTrusted()
        }, changed: { [weak self] in self?.updateState() })
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
        var forwardingResult: NotificationProbeResult = .pending
    }
    var probes: [String: Probe] = [:]
    var structureSnapshots: [NotificationStructureProbe.Snapshot] = []
    var structureProbeConfiguration: [String: Any]? {
        let url = projectURL.appendingPathComponent(".runtime/notification-menu-unified/structure-probe.json")
        guard let data = try? Data(contentsOf: url), data.count < 8192,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let until = object["expiresAt"] as? Double,
              NotificationStructureProbe.enabled(until: until, now: Date().timeIntervalSince1970)
        else { return nil }
        return object
    }
    var structureProbeEnabled: Bool { structureProbeConfiguration != nil }
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
    var localize: (String, [String: String]) -> String = { key, parameters in Localization.shared.text(key, language: "en", parameters) }
    func tr(_ key: String, _ parameters: [String: String] = [:]) -> String { localize(key, parameters) }
    var notificationSummary: String {
        if relaySuspended { return tr("mac.dot_link_is_paused") }
        if legacyRunning { return tr("mac.waiting_to_move_notifications") }
        if paused { return tr("mac.notifications_paused") }
        if !AXIsProcessTrusted() { return tr("mac.notification_access_needed") }
        return observer == nil ? tr("mac.checking_notifications") : tr("mac.watching_notifications")
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
        shareAllNotifications = defaults.bool(forKey: "shareAllMacNotifications")
        paused = defaults.bool(forKey: "monitoringPaused")
        try? FileManager.default.createDirectory(at: diagnosticURL.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        UNUserNotificationCenter.current().delegate = self
        let nc = NSWorkspace.shared.notificationCenter
        observers.append(nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.attach() })
        observers.append(nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.attach() })
        observers.append(nc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.refresh() })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.refresh() })
        healthTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in self?.attach(); self?.continueMigration(); self?.lineDelivery.refreshStatus(); self?.continueDiagnosticProbe() }
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
            self.add("mac.the_notification_test_did_not_complete_the_old_app_is_still_running")
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
        heading.addArrangedSubview(HelpButton(title + tr("mac.help"), help)); body.addArrangedSubview(heading)
        heading.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -36).isActive = true
        let box = NSBox(); box.boxType = .custom; box.borderColor = .separatorColor; box.borderWidth = 0.5; box.cornerRadius = 12; box.fillColor = .controlBackgroundColor; box.contentViewMargins = .zero; box.contentView = body
        root.addArrangedSubview(box); box.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
        box.heightAnchor.constraint(equalTo: body.heightAnchor).isActive = true
        return body
    }
    func makeView() -> NSView {
        let root = NSStackView(); root.orientation = .vertical; root.alignment = .leading; root.spacing = 14
        root.translatesAutoresizingMaskIntoConstraints = false
        let heading = text(tr("mac.notifications"), size: 22); heading.font = .systemFont(ofSize: 22, weight: .semibold); root.addArrangedSubview(heading)
        let status = card(root, title: tr("mac.notification_status"), icon: "bell", help: tr("mac.share_new_notifications_displayed_on_this_mac_with_dot_only_visible_send"))
        connectionLabel.font = .systemFont(ofSize: 12, weight: .semibold); connectionLabel.maximumNumberOfLines = 0; connectionLabel.lineBreakMode = .byWordWrapping
        connectionStatusIcon.imageScaling = .scaleProportionallyDown
        connectionStatusIcon.widthAnchor.constraint(equalToConstant: 21).isActive = true
        connectionStatusIcon.heightAnchor.constraint(equalToConstant: 21).isActive = true
        let notificationState = NSStackView(views: [connectionStatusIcon, connectionLabel])
        notificationState.orientation = .horizontal; notificationState.alignment = .centerY; notificationState.spacing = 4
        status.addArrangedSubview(notificationState)
        notificationState.widthAnchor.constraint(equalTo: status.widthAnchor, constant: -36).isActive = true
        let permissionHelp = text(tr("mac.open_accessibility_with_permissions_click_and_add_dot_link_app_from_its"), size: 12, secondary: true)
        permissionHelp.maximumNumberOfLines = 0; permissionHelp.lineBreakMode = .byWordWrapping; permissionHelp.isSelectable = true
        status.addArrangedSubview(permissionHelp)
        permissionHelp.widthAnchor.constraint(equalTo: status.widthAnchor, constant: -36).isActive = true
        let controls = NSStackView(); controls.spacing = 10
        if legacyRunning {
            controls.addArrangedSubview(button(tr("mac.move_notifications"), #selector(beginMigration)))
            status.addArrangedSubview(text(tr("mac.keep_your_sources_and_pause_setting_the_old_app_closes_after_verificatio"), size: 12, secondary: true))
        } else {
            controls.addArrangedSubview(button(paused ? tr("mac.start_notifications") : tr("mac.pause"), #selector(togglePause)))
        }
        controls.addArrangedSubview(button(tr("mac.permissions"), #selector(openPermission)))
        let refreshButton = button("", #selector(refresh)); refreshButton.image = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil); refreshButton.isBordered = false; refreshButton.toolTip = tr("mac.check_status"); refreshButton.setAccessibilityLabel(refreshButton.toolTip!); controls.addArrangedSubview(refreshButton); status.addArrangedSubview(controls)
        let sources = card(root, title: tr("mac.notification_sharing"), icon: "bell.badge", help: tr("mac.when_enabled_new_notifications_displayed_on_this_mac_are_shared_with_you"))
        let share = NSButton(checkboxWithTitle: tr("mac.share_all_mac_notifications_with_dot"), target: self, action: #selector(toggleShareAll(_:)))
        share.state = shareAllNotifications ? .on : .off; share.isEnabled = !legacyRunning
        sources.addArrangedSubview(share)
        sources.addArrangedSubview(text(tr("mac.shares_sender_names_headings_and_text_shown_in_notifications"), size: 12, secondary: true))
        sources.addArrangedSubview(text(tr("mac.tell_dot_directly_which_notifications_you_d_like_to_hear_about"), size: 12, secondary: true))
        let test = card(root, title: tr("mac.try_a_notification"), icon: "paperplane", help: tr("mac.display_a_test_notification_on_this_mac_to_check_detection_and_forwardin"))
        test.addArrangedSubview(button(tr("mac.send_test_notification"), #selector(sendTest)))
        let details = button(detailsVisible ? tr("mac.hide_details") : tr("mac.detection_details"), #selector(toggleDetails)); details.isBordered = false; details.image = NSImage(systemSymbolName: detailsVisible ? "chevron.down" : "chevron.right", accessibilityDescription: nil); details.imagePosition = .imageLeading; details.setAccessibilityLabel(details.title); root.addArrangedSubview(details)
        if detailsVisible {
            root.addArrangedSubview(stateLabel)
            let scroll = NSScrollView(); scroll.hasVerticalScroller = true; results.isEditable = false; results.font = .monospacedSystemFont(ofSize: 12, weight: .regular); results.autoresizingMask = [.width]; scroll.documentView = results
            scroll.heightAnchor.constraint(equalToConstant: 180).isActive = true; root.addArrangedSubview(scroll); scroll.widthAnchor.constraint(equalTo: root.widthAnchor).isActive = true
            root.addArrangedSubview(button(tr("mac.test_5_notifications"), #selector(sendBatch)))
        }
        settingsView = root; reloadApps(); updateState(); return root
    }
    var rebuildView: (() -> Void)?
    @objc func toggleDetails() { detailsVisible.toggle(); rebuildView?() }
    func reloadApps() { /* Common notification sharing has no per-app selection list. */ }
    @objc func toggleShareAll(_ sender: NSButton) {
        lineDelivery.cancel()
        shareAllNotifications = sender.state == .on
        defaults.set(shareAllNotifications, forKey: "shareAllMacNotifications")
        if shareAllNotifications { baselineCurrentNotifications() }
        updateState()
    }
    @objc func openPermission() {
        // Open one permission surface. The asynchronous macOS prompt would otherwise
        // remain behind System Settings. This also works when macOS suppresses repeat prompts.
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
        stateLabel.stringValue = tr("mac.notification_details", [
            "access": tr(AXIsProcessTrusted() ? "mac.notification_allowed" : "mac.notification_denied"),
            "detection": tr(paused ? "mac.notification_paused" : observer == nil ? "mac.notification_waiting" : "mac.notification_watching"),
            "events": String(eventCount), "candidates": String(candidateCount), "tests": String(testCount),
            "registrations": registrations.isEmpty ? tr("mac.notification_none") : registrations.joined(separator: ", ")])
        var reasons = healthIssues
        if shareAllNotifications {
            if !lineDelivery.ledger.healthy { reasons.append(tr("mac.check_the_notification_ledger_notification_sharing_is_on_hold")) }
            if lineDelivery.statusAvailable && lineDelivery.subscriptionReady == false { reasons.append(tr("mac.connect_dot_to_notification_events")) }
        }
        if !paused && !AXIsProcessTrusted() { reasons.append(tr("mac.notification_resume_permission")) }
        else if !paused && observer == nil { reasons.append(tr("mac.notification_reconnecting")) }
        if probes.values.contains(where: { $0.forwardingResult.needsAttention }) {
            reasons.append(tr("mac.notification_forward_unconfirmed"))
        }
        currentIcon = !healthChecked ? .checking : !healthReady || !reasons.isEmpty ? .attention : paused ? .paused : .ready
        connectionLabel.stringValue = notificationSummary + (migrationRequested && !AXIsProcessTrusted() ? tr("mac.nallow_dot_link_in_system_settings_migration_continues_when_you_return") : "")
        let statusSymbol: String
        let statusColor: NSColor
        if relaySuspended || paused {
            statusSymbol = "pause.circle"; statusColor = .secondaryLabelColor
        } else if legacyRunning || !AXIsProcessTrusted() {
            statusSymbol = "exclamationmark.circle"; statusColor = .systemOrange
        } else if observer == nil {
            statusSymbol = "arrow.triangle.2.circlepath"; statusColor = .secondaryLabelColor
        } else {
            statusSymbol = "checkmark.circle.fill"; statusColor = .systemGreen
        }
        connectionStatusIcon.image = NSImage(systemSymbolName: statusSymbol, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 13, weight: .regular))
        connectionStatusIcon.contentTintColor = statusColor
        changed?()
        stateLabel.stringValue += tr("mac.notification_display_permission", ["permission": permissionText])
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
            let shareAllNotifications: Bool
            let structureProbeActive: Bool
            let structureSnapshots: [NotificationStructureProbe.Snapshot]
            let lineExtractions: [NotificationForwarder.ExtractionEvent]
            let lineDeliveries: [NotificationDeliveryLedger.Entry]
            let lineLedgerHealthy: Bool
            let notificationSubscriptionReady: Bool?
            let notificationStatusAvailable: Bool
        }
        let record = Diagnostic(version: 3, pid: ProcessInfo.processInfo.processIdentifier,
            updatedAt: Date().timeIntervalSince1970, trusted: AXIsProcessTrusted(), paused: paused,
            observing: observer != nil, relaySuspended: relaySuspended, notificationPermission: notificationPermission,
            eventCount: eventCount, candidateCount: candidateCount, selectedApps: selected.sorted(),
            registrations: registrations, icon: currentIcon.rawValue, connectionReady: healthReady,
            probes: probes.values.sorted { $0.dueAt < $1.dueAt },
            shareAllNotifications: shareAllNotifications, structureProbeActive: structureProbeEnabled, structureSnapshots: structureSnapshots,
            lineExtractions: lineDelivery.extractionEvents,
            lineDeliveries: Array(lineDelivery.ledger.entries.suffix(100)), lineLedgerHealthy: lineDelivery.ledger.healthy,
            notificationSubscriptionReady: lineDelivery.subscriptionReady, notificationStatusAvailable: lineDelivery.statusAvailable)
        do {
            let data = try JSONEncoder().encode(record)
            try data.write(to: diagnosticURL, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: diagnosticURL.path)
        } catch { /* Diagnostics must not stop notification observation. */ }
    }
    func detach() {
        lineDelivery.cancel()
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
        guard result == .success, let created else { add("mac.notification_observer_failed", ["code": String(result.rawValue)]); return }
        let element = AXUIElementCreateApplication(target.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.3)
        let ref = Unmanaged.passUnretained(self).toOpaque()
        var registeredCount = 0
        registrations = [kAXWindowCreatedNotification, kAXLayoutChangedNotification, kAXUIElementDestroyedNotification].map { name in
            let error = AXObserverAddNotification(created, element, name as CFString, ref)
            if error == .success { registeredCount += 1 }
            return "\(name)=\(error.rawValue)"
        }
        guard registeredCount > 0 else { add("mac.notification_events_unsupported"); updateState(); return }
        observer = created; observedPID = target.processIdentifier
        baselineCurrentNotifications()
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
        updateState()
        // Baseline reads identifiers/roles only, never prior notification text.
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
    func continueDiagnosticProbe() {
        // Developer-only, expiring local request; no hidden permanent test loop.
        guard !paused, !relaySuspended, !legacyRunning, observer != nil, AXIsProcessTrusted(),
              let config = structureProbeConfiguration,
              let requestID = config["syntheticRequestID"] as? String, UUID(uuidString: requestID) != nil,
              defaults.string(forKey: "lastDiagnosticSyntheticRequest") != requestID,
              let count = config["syntheticCount"] as? Int, (1...5).contains(count) else { return }
        defaults.set(requestID, forKey: "lastDiagnosticSyntheticRequest")
        scheduleTests(count: count)
    }
    struct WindowRead {
        var root: NotificationAXNode
        var strings: [String]
        var nodes: Int
        var truncated: Bool
    }
    func readWindow(_ window: AXUIElement, index: Int, metadataOnly: Bool = false) -> WindowRead {
        let config = metadataOnly ? nil : structureProbeConfiguration
        let capture = config != nil
        let expected = config?["expectedTexts"] as? [String] ?? []
        var structure: [NotificationStructureProbe.Node] = []
        var strings: [String] = []
        var nodes = 0
        var truncated = false
        let deadline = Date().addingTimeInterval(0.25)
        func walk(_ element: AXUIElement, depth: Int, path: String) -> NotificationAXNode {
            guard depth < 16, nodes < 400, Date() < deadline else { truncated = true; return .init(role: "truncated") }
            AXUIElementSetMessagingTimeout(element, 0.05)
            nodes += 1
            let role = attribute(element, kAXRoleAttribute) as? String ?? ""
            let subrole = attribute(element, kAXSubroleAttribute) as? String ?? ""
            let identifier = attribute(element, kAXIdentifierAttribute) as? String ?? ""
            let stacking = attribute(element, "AXStackingIdentifier") as? String ?? ""
            var fields: [String] = []
            var matched = Set<String>()
            var value = ""
            if !metadataOnly {
                for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
                    if let text = attribute(element, key) as? String, !text.isEmpty {
                        if !strings.contains(text) { strings.append(String(text.prefix(4000))) }
                        if key == kAXValueAttribute { value = text }
                        if capture { fields.append(key as String); matched.formUnion(NotificationStructureProbe.matches(text, expected: expected)) }
                    }
                }
            }
            if capture {
                var supported: CFArray?
                _ = AXUIElementCopyAttributeNames(element, &supported)
                let names = (supported as? [String] ?? []).filter { $0.range(of: "^AX[A-Za-z]{1,80}$", options: .regularExpression) != nil }.sorted()
                structure.append(.init(path: path, role: NotificationStructureProbe.safeRole(role),
                    fields: fields.sorted(), matches: matched.sorted(),
                    subrole: NotificationReader.notificationSubroles.contains(subrole) ? subrole : "other",
                    identifierPresent: !identifier.isEmpty, stackingPresent: !stacking.isEmpty,
                    lineStackingMatch: NotificationReader.isLine(stacking),
                    ownStackingMatch: stacking == "app.tripsurf.dotlink.mac" || stacking.hasPrefix("app.tripsurf.dotlink.mac;"),
                    supportedAttributes: names))
            }
            let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            if children.count > 400 { truncated = true }
            return .init(role: role, subrole: subrole, identifier: identifier, stackingIdentifier: stacking, value: value,
                children: children.prefix(400).enumerated().map { walk($0.element, depth: depth + 1, path: "\(path).\($0.offset)") })
        }
        let root = walk(window, depth: 0, path: "w\(index)")
        if capture, !structure.isEmpty {
            structureSnapshots.append(.init(observedAt: Date().timeIntervalSince1970, window: index, nodes: structure, truncated: truncated))
            structureSnapshots = Array(structureSnapshots.suffix(100))
        }
        return .init(root: root, strings: strings, nodes: nodes, truncated: truncated)
    }
    func baselineCurrentNotifications() {
        guard observedPID != 0, AXIsProcessTrusted() else { return }
        let root = AXUIElementCreateApplication(observedPID)
        for (index, window) in ((attribute(root, kAXWindowsAttribute) as? [AXUIElement]) ?? []).prefix(10).enumerated() {
            let read = readWindow(window, index: index, metadataOnly: true)
            if !read.truncated { lineDelivery.baseline(NotificationReader.extract(read.root)) }
        }
    }
    func scan() {
        guard !relaySuspended, observedPID != 0, AXIsProcessTrusted() else { detach(); updateState(); return }
        let root = AXUIElementCreateApplication(observedPID)
        let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
        seen = seen.filter { Date().timeIntervalSince($0.value) < 120 }
        for (index, window) in windows.prefix(10).enumerated() {
            let read = readWindow(window, index: index)
            // The migration marker uses one direct receipt even when sharing is enabled.
            // Do not let the general ledger reserve or send the same notification.
            if !read.truncated {
                let extractions = NotificationReader.extract(read.root).filter {
                    !(validating && migrationProbe != nil && $0.notification?.title == migrationProbe)
                }
                lineDelivery.observe(extractions, selected: shareAllNotifications)
            }
            let strings = read.strings
            guard !strings.isEmpty else { continue }
            let fingerprint = strings.joined(separator: "\u{1f}")
            guard seen[fingerprint] == nil else { continue }
            seen[fingerprint] = Date(); candidateCount += 1
            let markers = strings.filter { probes[$0] != nil }
            if !markers.isEmpty {
                for marker in markers {
                    guard var probe = probes[marker] else { continue }
                    probe.observations += 1
                    probe.bodyMatched = probe.bodyMatched || strings.contains(probe.body)
                    probe.sourceLabelMatched = probe.sourceLabelMatched || strings.contains("Dot Link")
                    if probe.detectedAt == nil {
                        probe.detectedAt = Date().timeIntervalSince1970
                        probe.selectedAtDetection = shareAllNotifications || validating || selected.contains("Dot Notification Lab")
                        add("mac.notification_test_detected", ["marker": marker, "matched": String(probe.bodyMatched)])
                    }
                    let directProbe = NotificationProbeResult.usesDirectProbe(shareAll: shareAllNotifications,
                        validating: validating, marker: marker, migrationProbe: migrationProbe)
                    if !directProbe, let extraction = NotificationReader.extract(read.root).first(where: { $0.notification?.title == marker && $0.notification?.body == probe.body }),
                       let identity = extraction.identity, let entry = lineDelivery.ledger.entry(identity) {
                        probe.notificationID = entry.id; probe.forwarding = entry.stage; probe.forwardingResult = .ledgerManaged
                    }
                    probes[marker] = probe
                    if directProbe && probe.registered && probe.bodyMatched && probe.selectedAtDetection == true && probe.forwardingResult == .pending { forwardProbe(marker) }
                }
            } else {
                add("mac.notification_candidate", ["nodes": String(read.nodes)])
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
            probes[marker]?.forwardingResult = .sending
            probes[marker]?.forwarding = "送信中"
            updateState()
            let generation = activityGeneration
            let task = URLSession.shared.dataTask(with: request) { _, response, error in
                DispatchQueue.main.async {
                    self.forwardingTasks.removeValue(forKey: marker)
                    guard !self.relaySuspended, self.activityGeneration == generation else { return }
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    if error == nil && (200..<300).contains(status) {
                        self.probes[marker]?.forwardingResult = .relayAccepted
                        self.probes[marker]?.forwarding = "中継受領済み"
                        if self.validating && self.migrationProbe == marker { self.validating = false; self.detach(); self.saveDiagnostics(); self.requestMigration?() }
                        self.add("mac.notification_relay_accepted", ["marker": marker])
                    } else {
                        self.probes[marker]?.forwardingResult = .sendUnconfirmed
                        self.probes[marker]?.forwarding = "送信未確認 HTTP \(status)"
                        self.add("mac.notification_relay_unconfirmed", ["marker": marker, "status": String(status)])
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
            probes[marker]?.forwardingResult = .missingCredentials
            probes[marker]?.forwarding = "通知用接続設定なし"
            add("mac.notification_credentials", ["marker": marker])
            if legacyRunning { migrationFailed() }
            updateState()
        }
    }
    // Keep diagnostic wire values stable; translate only their UI presentation.
    var permissionText: String {
        let keys = ["確認中": "mac.notification_checking", "許可済み": "mac.notification_allowed", "未許可（システム設定 → 通知で変更）": "mac.notification_permission_denied", "未設定": "mac.notification_unset", "不明": "mac.notification_unknown"]
        return tr(keys[notificationPermission] ?? "mac.notification_unknown")
    }
    func refreshLanguage() { updateState(); renderEntries() }
    func renderEntries() {
        results.string = entries.map { date, value in
            let time = DateFormatter.localizedString(from: date, dateStyle: .none, timeStyle: .medium)
            return time + "  " + tr(value.key, value.parameters)
        }.joined(separator: "\n\n")
    }
    func add(_ key: String, _ parameters: [String: String] = [:]) {
        entries.insert((Date(), LocalizedMessage(key, parameters)), at: 0)
        entries = Array(entries.prefix(50)); renderEntries()
    }
    @objc func sendTest() { if legacyRunning { beginMigration() } else { scheduleTests(count: 1) } }
    @objc func sendBatch() { guard !legacyRunning else { return }; scheduleTests(count: 5) }
    func scheduleTests(count: Int) {
        guard !relaySuspended else { return }
        guard Date() >= batchUntil else { add("mac.notification_batch_wait"); return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            DispatchQueue.main.async {
                guard !self.relaySuspended else { return }
                guard granted else { self.add("mac.notification_test_denied", ["reason": error?.localizedDescription ?? self.tr("mac.notification_permission_help")]); self.testScheduled = false; self.migrationRequested = false; self.validating = false; self.detach(); self.refresh(); return }
                self.notificationPermission = "許可済み"
                self.batchUntil = Date().addingTimeInterval(Double(count * 4 + 5))
                for index in 0..<count {
                self.testCount += 1
                let id = "DOT-LAB-\(UUID().uuidString.prefix(8))"
                if self.validating { self.migrationProbe = id }
                let content = UNMutableNotificationContent()
                content.title = id
                content.body = self.tr("mac.notification_test_body", ["count": String(self.testCount)])
                let delay = Double(3 + index * 4)
                self.probes[id] = Probe(id: id, body: content.body, dueAt: Date().timeIntervalSince1970 + delay)
                let request = UNNotificationRequest(identifier: id, content: content, trigger: UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false))
                UNUserNotificationCenter.current().add(request) { error in
                    DispatchQueue.main.async { self.probes[id]?.registered = error == nil; if let error { self.add("mac.notification_schedule_error", ["reason": error.localizedDescription]) } else { self.add("mac.notification_scheduled", ["id": id]) }; self.updateState() }
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
