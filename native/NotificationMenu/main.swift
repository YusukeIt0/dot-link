import AppKit
import ApplicationServices
import UserNotifications

// This prototype reads only Notification Center accessibility elements. It never
// opens chats or invokes AX actions. Selected synthetic probes go to the local bridge.
final class NotificationApp: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    var statusItem: NSStatusItem!
    var window: NSWindow!
    let stateLabel = NSTextField(wrappingLabelWithString: "")
    let connectionLabel = NSTextField(wrappingLabelWithString: "接続を確認しています…")
    let summaryItem = NSMenuItem(title: "接続を確認しています…", action: nil, keyEquivalent: "")
    var tailscaleButton: NSButton!
    let pauseItem = NSMenuItem(title: "通知を開始", action: #selector(togglePause), keyEquivalent: "")
    let results = NSTextView()
    let apps = NSStackView()
    var selected = Set(UserDefaults.standard.stringArray(forKey: "selectedApps") ?? ["Dot Notification Lab"])
    var paused = true
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
    let diagnosticURL = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("diagnostics.json")
    var projectURL: URL { diagnosticURL.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent() }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        UNUserNotificationCenter.current().delegate = self
        // Restore the user's explicit choice; first installs remain paused. Migrate
        // an existing running installation without asking for the same switch again.
        if let saved = UserDefaults.standard.object(forKey: "monitoringPaused") as? Bool { paused = saved }
        else if let data = try? Data(contentsOf: diagnosticURL),
                let prior = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                let saved = prior["paused"] as? Bool { paused = saved }
        UserDefaults.standard.set(paused, forKey: "monitoringPaused")
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.title = ""
        statusItem.button?.image = DotStatus.checking.image()
        let menu = NSMenu()
        menu.addItem(summaryItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "接続と設定…", action: #selector(showWindow), keyEquivalent: "")
        menu.addItem(withTitle: "iPhone接続用QRを表示…", action: #selector(showPairing), keyEquivalent: "")
        menu.addItem(withTitle: "通知の設定と検知結果…", action: #selector(showWindow), keyEquivalent: "")
        menu.addItem(pauseItem)
        menu.addItem(.separator())
        menu.addItem(withTitle: "終了", action: #selector(quit), keyEquivalent: "q")
        for item in menu.items { item.target = self }
        statusItem.menu = menu
        buildWindow()
        let nc = NSWorkspace.shared.notificationCenter
        observers.append(nc.addObserver(forName: NSWorkspace.didLaunchApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.attach() })
        observers.append(nc.addObserver(forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main) { [weak self] _ in self?.attach() })
        observers.append(nc.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: .main) { [weak self] _ in self?.refresh() })
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.refresh() })
        refresh()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in self?.attach(); self?.checkConnection() }
        healthTimer?.tolerance = 5
        if !UserDefaults.standard.bool(forKey: "hasOpenedSettings") { showWindow() }
    }

    func button(_ title: String, _ action: Selector) -> NSButton {
        NSButton(title: title, target: self, action: action)
    }
    func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 840, height: 820), styleMask: [.titled, .closable, .resizable, .miniaturizable], backing: .buffered, defer: false)
        window.title = "Dot — 接続と通知"
        window.isReleasedWhenClosed = false
        window.center()
        let root = NSStackView()
        root.orientation = .vertical
        root.alignment = .leading
        root.spacing = 12
        root.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        root.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(root)
        NSLayoutConstraint.activate([
            root.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor), root.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            root.topAnchor.constraint(equalTo: window.contentView!.topAnchor), root.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor)
        ])
        let heading = NSTextField(labelWithString: "Dot")
        heading.font = .systemFont(ofSize: 22, weight: .semibold)
        root.addArrangedSubview(heading)
        root.addArrangedSubview(connectionLabel)
        tailscaleButton = button("Tailscaleを準備", #selector(openTailscale))
        let setup = NSStackView(views: [button("接続設定を自動で整える", #selector(configureConnection)), button("iPhone接続用QR", #selector(showPairing)), button("導入手順", #selector(openSetupGuide))])
        setup.spacing = 8
        root.addArrangedSubview(setup)
        root.addArrangedSubview(tailscaleButton)
        root.addArrangedSubview(NSTextField(wrappingLabelWithString: "選択したテスト通知は、実際の表示を検知した後、自動でDotへ送信します。一般アプリの通知は転送保留です。診断記録はテスト通知と動作状態のみ保存します。"))
        root.addArrangedSubview(stateLabel)
        let controls = NSStackView(views: [button("開始／一時停止", #selector(togglePause)), button("権限設定を開く", #selector(openPermission)), button("状態を再確認", #selector(refresh)), button("テスト通知", #selector(sendTest))])
        controls.spacing = 8
        root.addArrangedSubview(controls)
        root.addArrangedSubview(button("連続テスト（5件・約25秒）", #selector(sendBatch)))
        root.addArrangedSubview(NSTextField(labelWithString: "検証対象のアプリ（表示上のアプリ名で照合・識別できない通知は保留）"))
        apps.orientation = .vertical
        apps.alignment = .leading
        apps.spacing = 5
        let appScroll = NSScrollView()
        appScroll.hasVerticalScroller = true
        appScroll.documentView = apps
        apps.translatesAutoresizingMaskIntoConstraints = false
        apps.widthAnchor.constraint(equalTo: appScroll.contentView.widthAnchor).isActive = true
        appScroll.heightAnchor.constraint(equalToConstant: 140).isActive = true
        root.addArrangedSubview(appScroll)
        root.addArrangedSubview(NSTextField(labelWithString: "最近の検知結果（最大50件）"))
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        results.isEditable = false
        results.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        results.autoresizingMask = [.width]
        scroll.documentView = results
        root.addArrangedSubview(scroll)
        scroll.heightAnchor.constraint(greaterThanOrEqualToConstant: 170).isActive = true
        for view in [connectionLabel, stateLabel, appScroll, scroll] { view.widthAnchor.constraint(equalTo: root.widthAnchor, constant: -40).isActive = true }
        reloadApps()
    }
    func reloadApps() {
        appNames = Array(Set(NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }.compactMap { $0.localizedName } + ["Dot Notification Lab", "LINE", "Mail", "Slack"])).sorted()
        for view in apps.arrangedSubviews { apps.removeArrangedSubview(view); view.removeFromSuperview() }
        for name in appNames {
            let check = NSButton(checkboxWithTitle: name, target: self, action: #selector(selectApp(_:)))
            check.state = selected.contains(name) ? .on : .off
            apps.addArrangedSubview(check)
        }
    }
    @objc func selectApp(_ sender: NSButton) {
        if sender.state == .on { selected.insert(sender.title) } else { selected.remove(sender.title) }
        UserDefaults.standard.set(Array(selected).sorted(), forKey: "selectedApps")
        updateState()
    }
    @objc func showWindow() { UserDefaults.standard.set(true, forKey: "hasOpenedSettings"); window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true) }
    @objc func quit() { NSApp.terminate(nil) }
    func runHelper(_ action: String, completion: @escaping ([String: Any]) -> Void) {
        if helperRunning {
            if action != "status" { pendingHelper = { [weak self] in self?.runHelper(action, completion: completion) } }
            return
        }
        helperRunning = true
        let project = projectURL
        DispatchQueue.global(qos: .utility).async {
            var result: [String: Any] = ["ready": false, "issues": ["接続の確認に失敗しました。導入手順を確認してください。"]]
            if let node = ["/opt/homebrew/bin/node", "/usr/local/bin/node"].first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
                let process = Process(), pipe = Pipe()
                process.executableURL = URL(fileURLWithPath: node)
                process.arguments = [project.appendingPathComponent("scripts/setup.mjs").path, action]
                process.currentDirectoryURL = project
                process.standardOutput = pipe
                process.standardError = FileHandle.nullDevice
                do {
                    try process.run()
                    let timeout = DispatchWorkItem { if process.isRunning { process.terminate() } }
                    DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: timeout)
                    let data = pipe.fileHandleForReading.readDataToEndOfFile()
                    process.waitUntilExit(); timeout.cancel()
                    if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] { result = object }
                } catch {}
            } else { result["issues"] = ["Node.jsが見つかりません。導入手順を確認してください。"] }
            let response = result
            DispatchQueue.main.async {
                self.helperRunning = false
                completion(response)
                let pending = self.pendingHelper; self.pendingHelper = nil; pending?()
            }
        }
    }
    func checkConnection() {
        runHelper("status") { result in
            self.healthChecked = true
            self.healthReady = result["ready"] as? Bool ?? false
            self.healthIssues = result["issues"] as? [String] ?? []
            self.updateState()
        }
    }
    @objc func configureConnection() {
        setupMessage = "接続先と自動起動を設定しています…"; updateState()
        runHelper("install") { result in
            self.setupMessage = result["message"] as? String ?? (result["issues"] as? [String] ?? ["設定できませんでした。"]).joined(separator: "\n")
            self.updateState(); self.checkConnection()
        }
    }
    @objc func showPairing() {
        runHelper("pair") { result in
            if result["ready"] as? Bool == true {
                NSWorkspace.shared.open(self.projectURL.appendingPathComponent(".runtime/device-pairing.png"))
                self.setupMessage = "iPhoneでTailscaleを接続し、Evenアプリの開発モードからQRを読み込んでください。QRは他の人に共有しないでください。"
            } else { self.setupMessage = (result["issues"] as? [String] ?? ["QRを作成できませんでした。"]).joined(separator: "\n"); self.showWindow() }
            self.updateState()
        }
    }
    @objc func openSetupGuide() {
        if let url = Bundle.main.url(forResource: "Setup", withExtension: "html") { NSWorkspace.shared.open(url) }
    }
    func tailscaleApplication() -> URL? {
        for id in ["io.tailscale.ipn.macsys", "io.tailscale.ipn.macos"] {
            if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) { return url }
        }
        return [URL(fileURLWithPath: "/Applications/Tailscale.app"), FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Applications/Tailscale.app")].first { FileManager.default.fileExists(atPath: $0.path) }
    }
    @objc func openTailscale() {
        if let url = tailscaleApplication() { NSWorkspace.shared.open(url) }
        else { NSWorkspace.shared.open(URL(string: "https://tailscale.com/download/mac")!) }
    }
    @objc func openPermission() {
        // Trigger only on this explicit user action; never grant permission itself.
        _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")!)
    }
    @objc func togglePause() {
        paused.toggle()
        UserDefaults.standard.set(paused, forKey: "monitoringPaused")
        if paused { detach() } else { attach() }
        updateState()
    }
    @objc func refresh() {
        reloadApps(); attach(); updateState()
        checkConnection()
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
        tailscaleButton?.title = tailscaleApplication() == nil ? "Tailscaleをインストール…" : "Tailscaleを開く…"
        stateLabel.stringValue = "アクセシビリティ: \(AXIsProcessTrusted() ? "許可済み" : "未許可")　検知: \(paused ? "一時停止" : observer == nil ? "接続待ち" : "監視中")\nイベント \(eventCount) 件 / 新規候補 \(candidateCount) 件 / テスト要求 \(testCount) 件\n監視登録: \(registrations.isEmpty ? "なし" : registrations.joined(separator: ", "))"
        var reasons = healthIssues
        if !paused && !AXIsProcessTrusted() { reasons.append("通知を再開するにはアクセシビリティを許可してください。") }
        else if !paused && observer == nil { reasons.append("通知の監視に再接続しています。") }
        if probes.values.contains(where: { $0.forwarding.hasPrefix("送信未確認") || $0.forwarding == "通知用接続設定なし" }) {
            reasons.append("中継への転送を確認できないテスト通知があります。検知結果を確認してください。")
        }
        currentIcon = !healthChecked ? .checking : !healthReady || !reasons.isEmpty ? .attention : paused ? .paused : .ready
        let summary = currentIcon == .checking ? "接続を確認しています" : currentIcon == .attention ? "確認が必要です" : paused ? "会話の中継は正常 · 通知は一時停止" : "会話の中継・通知監視は正常"
        statusItem.button?.image = currentIcon.image()
        statusItem.button?.toolTip = "Dot — \(summary)"
        statusItem.button?.setAccessibilityLabel("Dot — \(summary)")
        summaryItem.title = summary
        pauseItem.title = paused ? "通知を開始" : "通知を一時停止"
        connectionLabel.stringValue = ([summary] + reasons + (setupMessage.isEmpty ? [] : [setupMessage]) + ["G2の実表示・iPhoneの接続状態は、このMacからは確認できません。"] ).joined(separator: "\n")
        stateLabel.stringValue += "\nテスト通知の表示権限: \(notificationPermission)"
        saveDiagnostics()
    }
    func saveDiagnostics() {
        struct Diagnostic: Codable {
            let version: Int, pid: Int32
            let updatedAt: Double
            let trusted: Bool, paused: Bool, observing: Bool
            let notificationPermission: String
            let eventCount: Int, candidateCount: Int
            let selectedApps: [String], registrations: [String]
            let icon: String, connectionReady: Bool
            let probes: [Probe]
        }
        let record = Diagnostic(version: 1, pid: ProcessInfo.processInfo.processIdentifier,
            updatedAt: Date().timeIntervalSince1970, trusted: AXIsProcessTrusted(), paused: paused,
            observing: observer != nil, notificationPermission: notificationPermission,
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
        guard !paused, AXIsProcessTrusted() else { detach(); updateState(); return }
        guard let target = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.notificationcenterui").first else { detach(); updateState(); return }
        if observer != nil && observedPID == target.processIdentifier { return }
        detach()
        var created: AXObserver?
        let result = AXObserverCreate(target.processIdentifier, { _, _, _, ref in
            guard let ref else { return }
            Unmanaged<NotificationApp>.fromOpaque(ref).takeUnretainedValue().onEvent()
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
        guard !paused else { return }
        eventCount += 1
        guard !pendingScan else { return }
        pendingScan = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in
            guard let self else { return }; self.pendingScan = false
            if !self.paused { self.scan() }
        }
    }
    func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    func scan() {
        guard observedPID != 0, AXIsProcessTrusted() else { detach(); updateState(); return }
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
                    probe.sourceLabelMatched = probe.sourceLabelMatched || matches.contains("Dot Notification Lab")
                    probe.attributes = attributeNames.sorted()
                    if probe.detectedAt == nil {
                        probe.detectedAt = Date().timeIntervalSince1970
                        probe.selectedAtDetection = selected.contains("Dot Notification Lab")
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
        guard !paused, AXIsProcessTrusted(), observer != nil,
              selected.contains("Dot Notification Lab"), let probe = probes[marker],
              probe.registered, probe.bodyMatched, probe.selectedAtDetection == true,
              let detectedAt = probe.detectedAt else { return }
        do {
            let runtime = diagnosticURL.deletingLastPathComponent().deletingLastPathComponent()
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
            URLSession.shared.dataTask(with: request) { _, response, error in
                DispatchQueue.main.async {
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    if error == nil && (200..<300).contains(status) {
                        self.probes[marker]?.forwarding = "中継受領済み"
                        self.add("自動転送: \(marker) — 中継受領済み（Dotの案内・G2表示は別途確認）")
                    } else {
                        self.probes[marker]?.forwarding = "送信未確認 HTTP \(status)"
                        self.add("自動転送: \(marker) — 送信未確認 HTTP \(status)")
                        if attempt < 2 {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
                                self.forwardProbe(marker, attempt: attempt + 1)
                            }
                        }
                    }
                    self.updateState()
                }
            }.resume()
        } catch {
            probes[marker]?.forwarding = "通知用接続設定なし"
            add("自動転送: \(marker) — 通知用接続設定を確認してください")
            updateState()
        }
    }
    func add(_ message: String) {
        let time = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium)
        entries.insert("\(time)  \(message)", at: 0)
        entries = Array(entries.prefix(50)); results.string = entries.joined(separator: "\n\n")
    }
    @objc func sendTest() { scheduleTests(count: 1) }
    @objc func sendBatch() { scheduleTests(count: 5) }
    func scheduleTests(count: Int) {
        guard Date() >= batchUntil else { add("前の連続テストが完了するまでお待ちください。"); return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            DispatchQueue.main.async {
                guard granted else { self.add("テスト通知の許可なし: \(error?.localizedDescription ?? "システム設定 → 通知で確認")"); self.refresh(); return }
                self.notificationPermission = "許可済み"
                self.batchUntil = Date().addingTimeInterval(Double(count * 4 + 5))
                for index in 0..<count {
                self.testCount += 1
                let id = "DOT-LAB-\(UUID().uuidString.prefix(8))"
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

// A LaunchAgent and a Finder launch must never create two observers.
if NSRunningApplication.runningApplications(withBundleIdentifier: "local.even-g2-dot.notification-lab").contains(where: { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }) {
    exit(0)
}
let app = NSApplication.shared
let delegate = NotificationApp()
app.delegate = delegate
app.run()
