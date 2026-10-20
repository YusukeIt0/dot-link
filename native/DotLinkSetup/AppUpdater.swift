import AppKit
import Sparkle

final class AppUpdater: NSObject, SPUUpdaterDelegate, SPUUserDriver {
    var updater: SPUUpdater!
    let automaticUpdatesEnabled: Bool
    private let savedAutomaticPreferenceKey = "DotLinkAutomaticChecksBeforePolicyPause"
    var changed: (() -> Void)?
    var tr: (String, String) -> String = { ja, _ in ja }
    var canCheck: () -> Bool = { false }
    var prepare: (Bool, @escaping (String) -> Void) -> Void = { _, reply in reply("failed") }
    var recover: (@escaping (Bool) -> Void) -> Void = { $0(false) }
    var runAlert: (NSAlert) -> NSApplication.ModalResponse = { $0.runModal() }
    var prepared = false
    var working = false
    var message = ""
    private var statusText: (String, String)?
    private var manuallyApproved = false
    private var manualCheck = false
    private var cancelDownload: (() -> Void)?
    private var readyReply: ((SPUUserUpdateChoice) -> Void)?
    private var retry: Timer?
    private var extracting = false
    private var received: UInt64 = 0
    private var expected: UInt64 = 0
    private var statusLabel: NSTextField?
    private var checkButton: NSButton?
    private(set) var recoveryRequired = false
    private(set) var recovering = false
    private(set) var preparing = false
    var blocksActions: Bool { preparing || recovering || prepared }
    var checkTitle: String {
        recoveryRequired ? tr("復旧を再試行", "Retry recovery") : readyReply != nil ? tr("更新を再試行", "Retry update") : tr("アップデートを確認", "Check for updates")
    }
    private let repository = Bundle.main.object(forInfoDictionaryKey: "DotLinkUpdateRepository") as? String ?? ""
    var silentRelaunch: Bool { !manuallyApproved }
    var automatic: Bool { automaticUpdatesEnabled && (updater?.automaticallyChecksForUpdates ?? false) }
    init(automaticUpdatesEnabled: Bool? = nil) {
        self.automaticUpdatesEnabled = automaticUpdatesEnabled ?? (Bundle.main.object(forInfoDictionaryKey: "DotLinkAutomaticUpdatesEnabled") as? Bool ?? false)
        super.init()
        updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: self, delegate: self)
    }
    // Keep the previous user preference so a future build can lift the policy
    // pause without deleting the updater or losing the user's setting.
    func applyAutomaticUpdatePolicy() {
        let defaults = UserDefaults.standard
        if !automaticUpdatesEnabled {
            if defaults.object(forKey: savedAutomaticPreferenceKey) == nil {
                defaults.set(updater.automaticallyChecksForUpdates, forKey: savedAutomaticPreferenceKey)
            }
            updater.automaticallyChecksForUpdates = false
        } else if defaults.object(forKey: savedAutomaticPreferenceKey) != nil {
            updater.automaticallyChecksForUpdates = defaults.bool(forKey: savedAutomaticPreferenceKey)
            defaults.removeObject(forKey: savedAutomaticPreferenceKey)
        }
    }
    func start() {
        applyAutomaticUpdatePolicy()
        updater.automaticallyDownloadsUpdates = false // All installation goes through our service preparation.
        updater.sendsSystemProfile = false
        do {
            try updater.start()
            if !automaticUpdatesEnabled { status("手動でアップデートを確認できます", "Check for updates manually") }
            else if automatic { status("アップデートを確認できます", "Ready to check for updates") }
            else { status("自動更新はオフです", "Automatic updates are off") }
        } catch { status("更新を開始できません", "Updates could not start") }
    }
    private func status(_ ja: String, _ en: String, working: Bool = false) {
        statusText = (ja, en)
        let next = tr(ja, en); if message == next && self.working == working { return }
        self.working = working; message = next; statusLabel?.stringValue = message; refreshCheckButton(); changed?()
    }
    private func refreshCheckButton() {
        checkButton?.title = checkTitle
        checkButton?.isEnabled = !blocksActions && !extracting
    }
    func refreshLanguage() { if let (ja, en) = statusText { message = tr(ja, en); statusLabel?.stringValue = message; refreshCheckButton(); changed?() } }
    func settingsView() -> NSView {
        let box = NSStackView(); box.orientation = .vertical; box.alignment = .leading; box.spacing = 10
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") + ((Bundle.main.object(forInfoDictionaryKey: "DotLinkBeta") as? Bool == true) ? " Beta" : "")
        let title = NSTextField(labelWithString: tr("バージョン：", "Version: ") + version); title.font = .systemFont(ofSize: 15, weight: .semibold); box.addArrangedSubview(title)
        let toggle = NSButton(checkboxWithTitle: tr("自動更新", "Automatic updates"), target: self, action: #selector(toggleAutomatic(_:))); toggle.state = automatic ? .on : .off; toggle.isEnabled = automaticUpdatesEnabled; toggle.toolTip = automaticUpdatesEnabled ? nil : tr("自動更新は一時的に利用できません。手動で更新できます。", "Automatic updates are temporarily unavailable. You can update manually."); box.addArrangedSubview(toggle)
        let check = ActionButton(tr("アップデートを確認", "Check for updates")) { [weak self] in self?.check() }
        checkButton = check; refreshCheckButton(); box.addArrangedSubview(check)
        let detail = NSTextField(wrappingLabelWithString: message.isEmpty ? tr("自動更新は、Evenを使っていない間に適用します。", "Automatic updates install while Even is not in use.") : message); detail.font = .systemFont(ofSize: 12); detail.textColor = .secondaryLabelColor; box.addArrangedSubview(detail); statusLabel = detail
        let guidance = NSTextField(wrappingLabelWithString: tr(
            "自動更新は一時停止中です。更新する場合は「アップデートを確認」を押してください。\n更新後、通知を共有できなくなった場合：\nシステム設定 → プライバシーとセキュリティ → アクセシビリティで、Dot Linkを一度削除し、インストール先のDot Link.appを追加し直してオンにしてください。",
            "Automatic updates are temporarily disabled. To update, click Check for updates.\nIf notification sharing stops after an update:\nOpen System Settings → Privacy & Security → Accessibility. Remove Dot Link, add Dot Link.app again from its installation folder, then turn access on."))
        guidance.font = .systemFont(ofSize: 12); guidance.textColor = .secondaryLabelColor
        guidance.isSelectable = true; guidance.maximumNumberOfLines = 0
        guidance.setContentCompressionResistancePriority(.required, for: .vertical)
        if !automaticUpdatesEnabled {
            box.addArrangedSubview(guidance)
            guidance.widthAnchor.constraint(equalTo: box.widthAnchor).isActive = true
        }
        return box
    }
    @objc private func toggleAutomatic(_ sender: NSButton) {
        guard automaticUpdatesEnabled else { sender.state = .off; return }
        updater.automaticallyChecksForUpdates = sender.state == .on
        if automatic && !working && !preparing { status("自動更新はオンです", "Automatic updates are on") }
        if !automatic && !manuallyApproved && !preparing {
            retry?.invalidate(); retry = nil; cancelDownload?(); cancelDownload = nil
            let reply = readyReply; readyReply = nil; reply?(.skip)
            status("自動更新はオフです", "Automatic updates are off")
        }
    }
    func check() {
        guard !blocksActions && !extracting else { return }
        if recoveryRequired { restoreService(); return }
        if readyReply != nil { attemptInstall(); return }
        manualCheck = true; updater.checkForUpdates()
    }
    @discardableResult func cancelForQuit(discardConfirmed: Bool = false) -> Bool {
        if extracting || preparing || recovering {
            let alert = NSAlert()
            alert.messageText = recovering ? tr("接続の復旧が終わるまでお待ちください", "Wait for connection recovery to finish")
                : extracting ? tr("更新の検証が終わるまでお待ちください", "Wait for update verification to finish")
                : tr("更新の準備が終わるまでお待ちください", "Wait for update preparation to finish")
            _ = runAlert(alert)
            return false
        }
        if readyReply != nil && manuallyApproved && !discardConfirmed {
            let alert = NSAlert()
            alert.messageText = tr("更新せずに終了しますか？", "Quit without updating?")
            alert.informativeText = tr("ダウンロード済みの更新は破棄されます。再ダウンロードせずに再試行するには、Dot Linkを開いたままにしてください。", "Quitting discards the downloaded update. Keep Dot Link open to retry without downloading again.")
            alert.addButton(withTitle: tr("開いたままにする", "Keep open"))
            alert.addButton(withTitle: tr("更新せず終了", "Quit without updating"))
            guard runAlert(alert) == .alertSecondButtonReturn else { return false }
        }
        retry?.invalidate(); retry = nil
        if !prepared { let reply = readyReply; readyReply = nil; reply?(.skip); cancelDownload?(); cancelDownload = nil }
        return true
    }
    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        guard automaticUpdatesEnabled || updateCheck == .updates else {
            throw NSError(domain: "DotLinkUpdate", code: 4, userInfo: [NSLocalizedDescriptionKey: tr("自動更新は一時停止中です。手動で確認してください。", "Automatic updates are temporarily disabled. Check manually.")])
        }
        guard canCheck() else { throw NSError(domain: "DotLinkUpdate", code: 1, userInfo: [NSLocalizedDescriptionKey: tr("Macの準備が終わってから確認してください。", "Finish Mac setup before checking for updates.")]) }
    }
    static func validDownloadURL(_ url: URL, repository: String) -> Bool {
        url.scheme == "https" && url.host == "github.com" && url.user == nil && url.password == nil &&
        url.query == nil && url.fragment == nil && url.port == nil &&
        url.path.hasPrefix("/" + repository + "/releases/download/") &&
        url.path.split(separator: "/").count == 6 && url.path.hasSuffix(".zip")
    }
    func updater(_ updater: SPUUpdater, shouldProceedWithUpdate updateItem: SUAppcastItem, updateCheck: SPUUpdateCheck) throws {
        guard let url = updateItem.fileURL, Self.validDownloadURL(url, repository: repository),
              updateItem.releaseNotesURL == nil, !updateItem.isInformationOnlyUpdate else {
            throw NSError(domain: "DotLinkUpdate", code: 3)
        }
    }
    func updater(_ updater: SPUUpdater, willDownloadUpdate item: SUAppcastItem, with request: NSMutableURLRequest) {
        request.setValue("application/octet-stream", forHTTPHeaderField: "Accept")
    }
    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) { reply(SUUpdatePermissionResponse(automaticUpdateChecks: automaticUpdatesEnabled, sendSystemProfile: false)) }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { cancelDownload = cancellation; status("更新を確認中…", "Checking for updates…") }
    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        cancelDownload = nil; manuallyApproved = false
        status("新しいバージョンがあります · " + appcastItem.displayVersionString, "Update available · " + appcastItem.displayVersionString)
        guard !appcastItem.isInformationOnlyUpdate else { reply(.dismiss); return }
        if !state.userInitiated && automatic {
            if state.stage == .installing { showReady(toInstallAndRelaunch: reply) } else { reply(.install) }
            return
        }
        guard state.userInitiated else { reply(state.stage == .installing ? .skip : .dismiss); return }
        confirmManualUpdate(version: appcastItem.displayVersionString, notes: appcastItem.itemDescription)
        if state.stage == .installing {
            if manuallyApproved { showReady(toInstallAndRelaunch: reply) } else { reply(.skip) }
        } else { reply(manuallyApproved ? .install : .dismiss) }
    }
    func confirmManualUpdate(version: String, notes: String?) {
        let alert = NSAlert(); alert.messageText = tr("新しいバージョンがあります", "An update is available") + " · " + version
        alert.informativeText = String((notes ?? tr("Dot Linkを更新します。設定と履歴は引き継ぎます。", "Update Dot Link. Your settings and history are preserved.")).prefix(4000))
        alert.informativeText += "\n\n" + tr("更新時に接続と進行中の会話を中断し、アプリを再起動します。更新後は元の接続状態に戻ります。送信できなかった発言は、もう一度話しかけてください。", "Updating interrupts the connection and any conversation in progress, then restarts the app. Your previous connection state is restored afterward. Please repeat anything that was not sent.")
        alert.addButton(withTitle: tr("あとで", "Later")); alert.addButton(withTitle: tr("更新する", "Update"))
        manuallyApproved = runAlert(alert) == .alertSecondButtonReturn
        if !manuallyApproved { status("更新はあとで適用できます", "You can install this update later") }
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        status("最新バージョンです", "You’re up to date")
        if manualCheck { let alert = NSAlert(); alert.messageText = message; alert.runModal() }
        acknowledgement()
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        let showAlert = manualCheck || manuallyApproved
        extracting = false
        retry?.invalidate(); retry = nil; readyReply = nil
        if prepared {
            UserDefaults.standard.removeObject(forKey: "updateBackgroundRelaunchAt"); prepared = false
            restoreService()
        } else if recoveryRequired {
            if !recovering { status("接続を復旧できませんでした。「復旧を再試行」を押してください。", "The connection could not be restored. Click Retry recovery.") }
        } else { status("更新できませんでした。「アップデートを確認」で再試行してください。", "Update failed. Click Check for updates to retry.") }
        if showAlert {
            let alert = NSAlert(); alert.messageText = tr("更新できませんでした", "Update failed")
            alert.informativeText = error.localizedDescription; _ = runAlert(alert)
        }
        acknowledgement()
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) { received = 0; expected = 0; cancelDownload = cancellation; status("更新をダウンロード中…", "Downloading update…", working: true) }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { expected = expectedContentLength }
    func showDownloadDidReceiveData(ofLength length: UInt64) { received += length; if expected > 0 { let p = min(100, Int(Double(received) / Double(expected) * 100)); status("更新をダウンロード中… \(p)%", "Downloading update… \(p)%", working: true) } }
    func showDownloadDidStartExtractingUpdate() { extracting = true; cancelDownload = nil; status("更新を検証中…", "Verifying update…", working: true) }
    func showExtractionReceivedProgress(_ progress: Double) {}
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        extracting = false; readyReply = reply
        if !automatic && !manuallyApproved { readyReply = nil; reply(.skip); return }
        attemptInstall()
    }
    private func attemptInstall() {
        guard readyReply != nil, !blocksActions, !recoveryRequired else { return }
        retry?.invalidate(); retry = nil
        preparing = true
        status("更新の準備中…", "Preparing update…", working: true)
        prepare(manuallyApproved) { [weak self] result in
            guard let self else { return }; self.preparing = false
            // An installer error may arrive while the helper is still stopping services.
            // Its callback must recover, not leave a completed preparation orphaned.
            guard self.readyReply != nil else {
                if result == "prepared" || result == "recovery-required" { self.restoreService() }
                else { self.refreshCheckButton(); self.changed?() }
                return
            }
            if result == "prepared" && !self.automatic && !self.manuallyApproved {
                let reply = self.readyReply; self.readyReply = nil; reply?(.skip)
                self.restoreService()
            } else if result == "prepared" {
                self.prepared = true
                self.status("更新を適用中…", "Installing update…", working: true)
                let reply = self.readyReply; self.readyReply = nil; reply?(.install)
            } else if result == "waiting" {
                if self.manuallyApproved {
                    self.status("設定の操作が終わったら「更新を再試行」を押してください。ダウンロードは保持しています。", "Finish the current settings operation, then click Retry update. The download is kept.")
                } else {
                    self.status("Evenを閉じると更新を適用します", "Close Even to apply the update")
                    self.retry = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.attemptInstall() }
                }
            } else if result == "recovery-required" {
                self.recoveryRequired = true
                self.status("接続を復旧できませんでした。「復旧を再試行」を押してください。", "The connection could not be restored. Click Retry recovery.")
            } else {
                // Keep the verified installer for an in-session retry. Dismiss is unsafe:
                // Sparkle can install on exit before service preparation has succeeded.
                self.status("更新を準備できませんでした。「更新を再試行」を押してください。ダウンロードは保持しています。", "Update preparation failed. Click Retry update. The download is kept.")
            }
        }
    }
    private func restoreService() {
        guard !recovering else { return }
        recovering = true; recoveryRequired = true
        status("接続を復旧中…", "Restoring connection…", working: true)
        recover { [weak self] success in
            guard let self else { return }
            self.recovering = false; self.recoveryRequired = !success
            if !success { self.status("接続を復旧できませんでした。「復旧を再試行」を押してください。", "The connection could not be restored. Click Retry recovery.") }
            else if self.readyReply != nil { self.status("元の接続状態に戻しました。「更新を再試行」を押してください。", "Previous connection state restored. Click Retry update.") }
            else { self.status("元の接続状態に戻しました。「アップデートを確認」で再試行してください。", "Previous connection state restored. Click Check for updates to retry.") }
        }
    }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) { status("更新を適用中…", "Installing update…", working: true) }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }
    func dismissUpdateInstallation() { extracting = false; cancelDownload = nil; retry?.invalidate(); retry = nil; readyReply = nil; manualCheck = false; manuallyApproved = false; working = recovering; refreshCheckButton(); changed?() }
}
