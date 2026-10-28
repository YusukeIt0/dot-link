import AppKit
import Sparkle

final class AppUpdater: NSObject, SPUUpdaterDelegate, SPUUserDriver {
    static func preparationResult(_ result: [String: Any]) -> String {
        if result["prepared"] as? Bool == true { return "prepared" }
        if result["kind"] == nil || ["UPDATE_RECOVERY_REQUIRED", "UPDATE_ALREADY_PREPARED"].contains(result["code"] as? String ?? "") { return "recovery-required" }
        return result["waiting"] as? Bool == true ? "waiting" : "failed"
    }
    private let progressDefaults: UserDefaults
    private let presentProgress: Bool
    private let progressMarkerKey = "DotLinkManualUpdateProgress"
    private var progressWindow: UpdateProgressWindow?
    private(set) var progressActive = false
    private(set) var progressFraction: Double?
    private var targetBuild: String?
    private var startupProgress = false
    var retryStartupRecovery: (() -> Void)?
    var updater: SPUUpdater!
    let automaticUpdatesEnabled: Bool
    private let savedAutomaticPreferenceKey = "DotLinkAutomaticChecksBeforePolicyPause"
    var changed: (() -> Void)?
    var localize: (String, [String: String]) -> String = { key, parameters in Localization.shared.text(key, language: "en", parameters) }
    func tr(_ key: String, _ parameters: [String: String] = [:]) -> String { localize(key, parameters) }
    var canCheck: () -> Bool = { false }
    var prepare: (Bool, @escaping (String) -> Void) -> Void = { _, reply in reply("failed") }
    var recover: (@escaping (Bool) -> Void) -> Void = { $0(false) }
    var runAlert: (NSAlert) -> NSApplication.ModalResponse = { $0.runModal() }
    var prepared = false
    var working = false
    var message = ""
    private var statusText: LocalizedMessage?
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
        recoveryRequired ? tr("mac.retry_recovery") : readyReply != nil ? tr("mac.retry_update") : tr("mac.check_for_updates")
    }
    private let repository = Bundle.main.object(forInfoDictionaryKey: "DotLinkUpdateRepository") as? String ?? ""
    var silentRelaunch: Bool { !manuallyApproved }
    var automatic: Bool { automaticUpdatesEnabled && (updater?.automaticallyChecksForUpdates ?? false) }
    init(automaticUpdatesEnabled: Bool? = nil, presentProgress: Bool = true, progressDefaults: UserDefaults = .standard) {
        self.presentProgress = presentProgress; self.progressDefaults = progressDefaults
        self.automaticUpdatesEnabled = automaticUpdatesEnabled ?? (Bundle.main.object(forInfoDictionaryKey: "DotLinkAutomaticUpdatesEnabled") as? Bool ?? false)
        super.init()
        updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: self, delegate: self)
    }
    private func renderProgress() {
        guard progressActive, presentProgress else { return }
        if progressWindow == nil { progressWindow = UpdateProgressWindow() }
        let retryable = !working && (readyReply != nil || recoveryRequired || startupProgress)
        progressWindow?.render(title: tr("mac.update_progress_title"), message: message,
            fraction: progressFraction, working: working,
            actionTitle: working ? nil : retryable ? (startupProgress ? tr("mac.retry_recovery") : checkTitle) : tr("mac.update_progress_close"),
            action: { [weak self] in
                guard let self else { return }
                if retryable {
                    if self.startupProgress { self.retryStartupRecovery?() } else { self.check() }
                } else { self.progressWindow?.close(); self.progressActive = false }
            })
    }
    private func beginProgress() {
        progressActive = true; renderProgress(); progressWindow?.present()
    }
    // Only a prepared manual install leaves a handoff. The target build prevents an
    // aborted installer or an ordinary restart from being reported as an update.
    private func saveProgressHandoff() {
        guard manuallyApproved, let targetBuild else { return }
        progressDefaults.set(["target": targetBuild, "at": Date().timeIntervalSince1970], forKey: progressMarkerKey)
        progressDefaults.synchronize()
    }
    func beginStartupRecovery(now: Date = Date()) {
        guard let marker = progressDefaults.dictionary(forKey: progressMarkerKey),
              let at = marker["at"] as? Double, now.timeIntervalSince1970 - at >= 0,
              now.timeIntervalSince1970 - at < 86400, let target = marker["target"] as? String else {
            progressDefaults.removeObject(forKey: progressMarkerKey); return
        }
        targetBuild = target; startupProgress = true; progressFraction = nil
        status("mac.restoring_connection", working: true); beginProgress()
    }
    func startupRecoveryFinished(success: Bool, currentBuild: String = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") {
        guard startupProgress else { return }
        if !success { status("mac.the_connection_could_not_be_restored_click_retry_recovery"); return }
        startupProgress = false
        progressDefaults.removeObject(forKey: progressMarkerKey)
        status(currentBuild == targetBuild ? "mac.update_progress_complete" : "mac.update_failed_click_check_for_updates_to_retry")
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
            if !automaticUpdatesEnabled { status("mac.check_for_updates_manually") }
            else if automatic { status("mac.ready_to_check_for_updates") }
            else { status("mac.automatic_updates_are_off") }
        } catch { status("mac.updates_could_not_start") }
    }
    private func status(_ key: String, _ parameters: [String: String] = [:], working: Bool = false) {
        statusText = LocalizedMessage(key, parameters)
        let next = tr(key, parameters); if message == next && self.working == working { renderProgress(); return }
        self.working = working; message = next; statusLabel?.stringValue = message; refreshCheckButton(); renderProgress(); changed?()
    }
    private func refreshCheckButton() {
        checkButton?.title = checkTitle
        checkButton?.isEnabled = !blocksActions && !extracting
    }
    func refreshLanguage() { defer { renderProgress() }; if let value = statusText { message = tr(value.key, value.parameters); statusLabel?.stringValue = message; refreshCheckButton(); changed?() } }
    func settingsView() -> NSView {
        let box = NSStackView(); box.orientation = .vertical; box.alignment = .leading; box.spacing = 10
        let version = (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "") + ((Bundle.main.object(forInfoDictionaryKey: "DotLinkBeta") as? Bool == true) ? " Beta" : "")
        let title = NSTextField(labelWithString: tr("mac.version") + version); title.font = .systemFont(ofSize: 15, weight: .semibold); box.addArrangedSubview(title)
        let toggle = NSButton(checkboxWithTitle: tr("mac.automatic_updates"), target: self, action: #selector(toggleAutomatic(_:))); toggle.state = automatic ? .on : .off; toggle.isEnabled = automaticUpdatesEnabled; toggle.toolTip = automaticUpdatesEnabled ? nil : tr("mac.automatic_updates_are_temporarily_unavailable_you_can_update_manually"); box.addArrangedSubview(toggle)
        let check = ActionButton(tr("mac.check_for_updates")) { [weak self] in self?.check() }
        checkButton = check; refreshCheckButton(); box.addArrangedSubview(check)
        let detail = NSTextField(wrappingLabelWithString: message.isEmpty ? tr("mac.automatic_updates_install_while_even_is_not_in_use") : message); detail.font = .systemFont(ofSize: 12); detail.textColor = .secondaryLabelColor; box.addArrangedSubview(detail); statusLabel = detail
        let guidance = NSTextField(wrappingLabelWithString: tr("mac.automatic_updates_are_temporarily_disabled_to_update_click_check_for_upd"))
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
        if automatic && !working && !preparing { status("mac.automatic_updates_are_on") }
        if !automatic && !manuallyApproved && !preparing {
            retry?.invalidate(); retry = nil; cancelDownload?(); cancelDownload = nil
            let reply = readyReply; readyReply = nil; reply?(.skip)
            status("mac.automatic_updates_are_off")
        }
    }
    func check() {
        if working && progressActive { progressWindow?.present(); return }
        guard !blocksActions && !extracting else { return }
        if recoveryRequired { restoreService(); return }
        if readyReply != nil { attemptInstall(); return }
        manualCheck = true; updater.checkForUpdates()
    }
    @discardableResult func cancelForQuit(discardConfirmed: Bool = false) -> Bool {
        if extracting || preparing || recovering {
            let alert = NSAlert()
            alert.messageText = recovering ? tr("mac.wait_for_connection_recovery_to_finish")
                : extracting ? tr("mac.wait_for_update_verification_to_finish")
                : tr("mac.wait_for_update_preparation_to_finish")
            _ = runAlert(alert)
            return false
        }
        if readyReply != nil && manuallyApproved && !discardConfirmed {
            let alert = NSAlert()
            alert.messageText = tr("mac.quit_without_updating")
            alert.informativeText = tr("mac.quitting_discards_the_downloaded_update_keep_dot_link_open_to_retry_with")
            alert.addButton(withTitle: tr("mac.keep_open"))
            alert.addButton(withTitle: tr("mac.quit_without_updating_19"))
            guard runAlert(alert) == .alertSecondButtonReturn else { return false }
        }
        retry?.invalidate(); retry = nil
        if !prepared { let reply = readyReply; readyReply = nil; reply?(.skip); cancelDownload?(); cancelDownload = nil }
        return true
    }
    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
        guard automaticUpdatesEnabled || updateCheck == .updates else {
            throw NSError(domain: "DotLinkUpdate", code: 4, userInfo: [NSLocalizedDescriptionKey: tr("mac.automatic_updates_are_temporarily_disabled_check_manually")])
        }
        guard canCheck() else { throw NSError(domain: "DotLinkUpdate", code: 1, userInfo: [NSLocalizedDescriptionKey: tr("mac.finish_mac_setup_before_checking_for_updates")]) }
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
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { cancelDownload = cancellation; status("mac.checking_for_updates") }
    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        cancelDownload = nil; manuallyApproved = false; targetBuild = appcastItem.versionString
        status("mac.update_available_version", ["version": appcastItem.displayVersionString])
        guard !appcastItem.isInformationOnlyUpdate else { reply(.dismiss); return }
        if !state.userInitiated && automatic {
            if state.stage == .installing { showReady(toInstallAndRelaunch: reply) } else { reply(.install) }
            return
        }
        guard state.userInitiated else { reply(state.stage == .installing ? .skip : .dismiss); return }
        confirmManualUpdate(version: appcastItem.displayVersionString, notes: appcastItem.itemDescription, build: appcastItem.versionString)
        if state.stage == .installing {
            if manuallyApproved { showReady(toInstallAndRelaunch: reply) } else { reply(.skip) }
        } else { reply(manuallyApproved ? .install : .dismiss) }
    }
    func confirmManualUpdate(version: String, notes: String?, build: String? = nil) {
        if let build { targetBuild = build }
        let alert = NSAlert(); alert.messageText = tr("mac.an_update_is_available") + " · " + version
        alert.informativeText = String((notes ?? tr("mac.update_dot_link_your_settings_and_history_are_preserved")).prefix(4000))
        alert.informativeText += "\n\n" + tr("mac.updating_interrupts_the_connection_and_any_conversation_in_progress_then")
        alert.addButton(withTitle: tr("mac.later")); alert.addButton(withTitle: tr("mac.update"))
        manuallyApproved = runAlert(alert) == .alertSecondButtonReturn
        if !manuallyApproved { status("mac.you_can_install_this_update_later") }
        else { progressFraction = nil; status("mac.downloading_update", working: true); beginProgress() }
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        status("mac.you_re_up_to_date")
        if manualCheck { let alert = NSAlert(); alert.messageText = message; alert.runModal() }
        acknowledgement()
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        let showAlert = manualCheck || manuallyApproved
        extracting = false; progressFraction = nil
        progressDefaults.removeObject(forKey: progressMarkerKey)
        retry?.invalidate(); retry = nil; readyReply = nil
        if prepared {
            UserDefaults.standard.removeObject(forKey: "updateBackgroundRelaunchAt"); prepared = false
            restoreService()
        } else if recoveryRequired {
            if !recovering { status("mac.the_connection_could_not_be_restored_click_retry_recovery") }
        } else { status("mac.update_failed_click_check_for_updates_to_retry") }
        if showAlert {
            let alert = NSAlert(); alert.messageText = tr("mac.update_failed")
            alert.informativeText = error.localizedDescription; _ = runAlert(alert)
        }
        acknowledgement()
    }
    func showDownloadInitiated(cancellation: @escaping () -> Void) { received = 0; expected = 0; progressFraction = nil; cancelDownload = cancellation; status("mac.downloading_update", working: true) }
    func showDownloadDidReceiveExpectedContentLength(_ expectedContentLength: UInt64) { expected = expectedContentLength }
    func showDownloadDidReceiveData(ofLength length: UInt64) { received += length; if expected > 0 { progressFraction = min(1, Double(received) / Double(expected)); let p = min(100, Int(Double(received) / Double(expected) * 100)); status("mac.downloading_update_p", ["p": String(p)], working: true) } }
    func showDownloadDidStartExtractingUpdate() { extracting = true; progressFraction = nil; cancelDownload = nil; status("mac.verifying_update", working: true) }
    func showExtractionReceivedProgress(_ progress: Double) { guard extracting, progress.isFinite else { return }; progressFraction = min(1, max(0, progress)); renderProgress() }
    func showReady(toInstallAndRelaunch reply: @escaping (SPUUserUpdateChoice) -> Void) {
        extracting = false; progressFraction = nil; readyReply = reply
        if !automatic && !manuallyApproved { readyReply = nil; reply(.skip); return }
        attemptInstall()
    }
    private func attemptInstall() {
        guard readyReply != nil, !blocksActions, !recoveryRequired else { return }
        retry?.invalidate(); retry = nil
        preparing = true
        status("mac.preparing_update", working: true)
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
                self.prepared = true; self.saveProgressHandoff()
                self.status("mac.installing_update", working: true)
                let reply = self.readyReply; self.readyReply = nil; reply?(.install)
            } else if result == "waiting" {
                if self.manuallyApproved {
                    self.status("mac.finish_the_current_settings_operation_then_click_retry_update_the_downlo")
                } else {
                    self.status("mac.close_even_to_apply_the_update")
                    self.retry = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.attemptInstall() }
                }
            } else if result == "recovery-required" {
                self.recoveryRequired = true
                self.status("mac.the_connection_could_not_be_restored_click_retry_recovery")
            } else {
                // Keep the verified installer for an in-session retry. Dismiss is unsafe:
                // Sparkle can install on exit before service preparation has succeeded.
                self.status("mac.update_preparation_failed_click_retry_update_the_download_is_kept")
            }
        }
    }
    private func restoreService() {
        guard !recovering else { return }
        progressFraction = nil
        recovering = true; recoveryRequired = true
        status("mac.restoring_connection", working: true)
        recover { [weak self] success in
            guard let self else { return }
            self.recovering = false; self.recoveryRequired = !success
            if !success { self.status("mac.the_connection_could_not_be_restored_click_retry_recovery") }
            else if self.readyReply != nil { self.status("mac.previous_connection_state_restored_click_retry_update") }
            else { self.status("mac.previous_connection_state_restored_click_check_for_updates_to_retry") }
        }
    }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) { status("mac.installing_update", working: true) }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }
    func dismissUpdateInstallation() { defer { if !prepared && !recovering && !preparing { progressWindow?.close(); progressActive = false } }; extracting = false; cancelDownload = nil; retry?.invalidate(); retry = nil; readyReply = nil; manualCheck = false; manuallyApproved = false; working = recovering; refreshCheckButton(); changed?() }
}
