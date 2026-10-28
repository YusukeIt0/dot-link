import AppKit
import Sparkle
final class ActionButton: NSButton {
    var handler: (() -> Void)?
    @objc func invoke() { handler?() }
    convenience init(_ text: String, _ action: @escaping () -> Void) { self.init(title: text, target: nil, action: nil); handler = action; target = self; self.action = #selector(invoke) }
}
let app = NSApplication.shared
let driver = AppUpdater(automaticUpdatesEnabled: true, presentProgress: false)
driver.localize = { key, parameters in Localization.shared.text(key, language: "ja", parameters) }
var blockedQuitAlerts = 0
driver.runAlert = { alert in
    precondition(alert.messageText.contains("終わるまでお待ちください"))
    blockedQuitAlerts += 1; return .alertFirstButtonReturn
}
func buttons(_ view: NSView) -> [NSButton] { (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons) }
precondition(!buttons(driver.settingsView()).contains { $0.title.contains("キー") || $0.title.contains("access") }, "Public channel must not show credential controls")
driver.canCheck = { true }
try! driver.updater(driver.updater, mayPerform: .updates)
precondition(driver.updater.httpHeaders?["Authorization"] == nil, "Public channel must not send an update key")
driver.updater.automaticallyChecksForUpdates = false
var choice: SPUUserUpdateChoice?
driver.showDownloadDidStartExtractingUpdate()
precondition(!driver.cancelForQuit(), "Do not quit while extraction can install on exit")
driver.showReady(toInstallAndRelaunch: { choice = $0 })
precondition(choice == .skip, "Automatic off must cancel installation")
precondition(driver.cancelForQuit())
driver.dismissUpdateInstallation()
var cancelled = false
driver.showDownloadInitiated(cancellation: { cancelled = true })
precondition(driver.cancelForQuit() && cancelled, "Quit cancels downloading")
driver.dismissUpdateInstallation()
driver.updater.automaticallyChecksForUpdates = true
var preparation: ((String) -> Void)?
var recovered = false
driver.prepare = { interrupt, reply in precondition(!interrupt); preparation = reply }
driver.recover = { reply in recovered = true; reply(true) }
choice = nil
driver.showReady(toInstallAndRelaunch: { choice = $0 })
precondition(driver.preparing && !driver.cancelForQuit())
precondition(blockedQuitAlerts == 2, "Verification and preparation must explain why quit is blocked")
driver.updater.automaticallyChecksForUpdates = false
preparation?("prepared")
precondition(recovered && choice == .skip && !driver.prepared, "Turning off during preparation must restore services and cancel")
driver.dismissUpdateInstallation()
precondition(!driver.working)
print("PASS: extraction quit guard, automatic-off cancellation, download cancellation, disable-during-preparation recovery")
let repository = "owner/project"
let release = "https://github.com/owner/project/releases/download/v1/App.zip"
precondition(AppUpdater.validDownloadURL(URL(string: release)!, repository: repository))
for invalid in [release.replacingOccurrences(of: "https:", with: "http:"), release.replacingOccurrences(of: "github.com/", with: "github.com.evil.example/"), release.replacingOccurrences(of: "owner/project", with: "other/project"), release + "?token=bad", release + "#fragment", "https://user:password@github.com/owner/project/releases/download/v1/App.zip", "https://github.com/owner/project/releases/download/v1/nested/App.zip"] {
    precondition(!AppUpdater.validDownloadURL(URL(string: invalid)!, repository: repository), "Reject untrusted release location")
}
precondition(buttons(driver.settingsView()).count == 2, "Only automatic updates and manual check should be shown")
var acknowledged = false
driver.showUpdateNotFoundWithError(NSError(domain: "fixture", code: 0)) { acknowledged = true }
precondition(acknowledged && driver.message == "最新バージョンです")
print("PASS: public release URL restrictions, no credentials, two update controls, clear up-to-date state")
let automaticToggle = buttons(driver.settingsView()).first { $0.title == "自動更新" }!
automaticToggle.state = .off; app.sendAction(automaticToggle.action!, to: automaticToggle.target, from: automaticToggle)
precondition(!driver.automatic && driver.message == "自動更新はオフです")
automaticToggle.state = .on; app.sendAction(automaticToggle.action!, to: automaticToggle.target, from: automaticToggle)
precondition(driver.automatic && driver.message == "自動更新はオンです")
print("PASS: switching automatic updates updates the visible on/off state")

let locked = AppUpdater(automaticUpdatesEnabled: false, presentProgress: false)
locked.localize = { key, parameters in Localization.shared.text(key, language: "ja", parameters) }
locked.canCheck = { true }
locked.updater.automaticallyChecksForUpdates = true
locked.applyAutomaticUpdatePolicy()
precondition(!locked.automatic && !locked.updater.automaticallyChecksForUpdates)
let lockedToggle = buttons(locked.settingsView()).first { $0.title == "自動更新" }!
precondition(!lockedToggle.isEnabled && lockedToggle.state == .off)
lockedToggle.state = .on; app.sendAction(lockedToggle.action!, to: lockedToggle.target, from: lockedToggle)
precondition(!locked.automatic && lockedToggle.state == .off)
precondition(buttons(locked.settingsView()).first { $0.title == "アップデートを確認" }!.isEnabled)
try! locked.updater(locked.updater, mayPerform: .updates)
do { try locked.updater(locked.updater, mayPerform: .updatesInBackground); preconditionFailure("Background check must be blocked") } catch {}
locked.updater.automaticallyChecksForUpdates = true // Stale preferences cannot override the release policy.
precondition(!locked.automatic)
var lockedChoice: SPUUserUpdateChoice?
var preparedWhileLocked = false
locked.prepare = { _, _ in preparedWhileLocked = true }
locked.showReady(toInstallAndRelaunch: { lockedChoice = $0 })
precondition(lockedChoice == .skip && !preparedWhileLocked)
func labels(_ view: NSView) -> [String] { (view as? NSTextField).map { [$0.stringValue] } ?? view.subviews.flatMap(labels) }
locked.showUpdateNotFoundWithError(NSError(domain: "fixture", code: 0)) {}
let messages = labels(locked.settingsView())
precondition(messages.contains("最新バージョンです") && messages.contains(where: { $0.contains("アクセシビリティ") && $0.contains("追加し直して") }))
locked.localize = { key, parameters in Localization.shared.text(key, language: "en", parameters) }; locked.refreshLanguage()
precondition(labels(locked.settingsView()).contains(where: { $0.contains("Accessibility") && $0.contains("add Dot Link.app again") }))
locked.localize = { key, parameters in Localization.shared.text(key, language: "ko", parameters) }; locked.refreshLanguage()
precondition(locked.message == "최신 버전입니다")
precondition(buttons(locked.settingsView()).contains(where: { $0.title == "업데이트 확인" }))
precondition(labels(locked.settingsView()).contains(where: { $0.contains("손쉬운 사용") }))
driver.applyAutomaticUpdatePolicy()
precondition(driver.updater.automaticallyChecksForUpdates, "Lifting the policy restores the saved preference")
print("PASS: disabled control, background veto, stale-preference install veto, manual check, bilingual recovery guidance, reversible preference")

if CommandLine.arguments.contains("--preview") {
    app.setActivationPolicy(.regular)
    let menu = NSMenu(); let item = NSMenuItem(); menu.addItem(item)
    let submenu = NSMenu(); submenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"); item.submenu = submenu; app.mainMenu = menu
    driver.start()
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 200), styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = "Dot Link — Updates"; window.isReleasedWhenClosed = false
    let view = driver.settingsView(); view.translatesAutoresizingMaskIntoConstraints = false; window.contentView!.addSubview(view)
    NSLayoutConstraint.activate([view.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor, constant: 24), view.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor, constant: -24), view.topAnchor.constraint(equalTo: window.contentView!.topAnchor, constant: 24)])
    window.center(); window.makeKeyAndOrderFront(nil); app.activate(ignoringOtherApps: true)
    withExtendedLifetime(window) { app.run() }
}

let manual = AppUpdater(automaticUpdatesEnabled: false, presentProgress: false)
manual.localize = { key, parameters in Localization.shared.text(key, language: "en", parameters) }
manual.canCheck = { true }
manual.runAlert = { alert in
    precondition(alert.informativeText.contains("interrupts the connection and any conversation"))
    return .alertSecondButtonReturn
}
manual.confirmManualUpdate(version: "1.0", notes: "Fixture release notes")
manual.runAlert = { alert in
    precondition(alert.messageText == "Wait for update preparation to finish")
    return .alertFirstButtonReturn
}
var manualChoice: SPUUserUpdateChoice?
var manualAttempts = 0
var finishManual: ((String) -> Void)?
manual.prepare = { interrupt, reply in
    precondition(interrupt, "Explicit manual approval must reach the service helper")
    manualAttempts += 1; finishManual = reply
}
manual.showReady(toInstallAndRelaunch: { manualChoice = $0 })
precondition(manual.blocksActions && !manual.cancelForQuit())
manual.check(); precondition(manualAttempts == 1, "No second prepare during an active attempt")
finishManual?("waiting")
precondition(manualChoice == nil && !manual.blocksActions && manual.message.contains("settings operation"))
precondition(AppUpdater.preparationResult(["kind": "error", "code": "UPDATE_STORAGE_BUSY"]) == "failed")
precondition(AppUpdater.preparationResult(["kind": "error", "code": "UPDATE_ALREADY_PREPARED"]) == "recovery-required")
precondition(AppUpdater.preparationResult([:]) == "recovery-required")
manual.check(); finishManual?(AppUpdater.preparationResult(["kind": "error", "code": "UPDATE_STORAGE_BUSY"]))
precondition(manualChoice == nil && manualAttempts == 2, "Failure keeps the verified installer")
precondition(buttons(manual.settingsView()).contains { $0.title == "Retry update" && $0.isEnabled })
var manualQuitAlerts = 0
manual.runAlert = { alert in
    precondition(alert.informativeText.contains("Quitting discards") || alert.messageText == "Wait for connection recovery to finish")
    manualQuitAlerts += 1; return .alertFirstButtonReturn
}
precondition(!manual.cancelForQuit() && manualChoice == nil, "Keeping the app open preserves the verified installer")
precondition(manualQuitAlerts == 1, "Keep open must not show another wait alert")
manual.check(); finishManual?("recovery-required")
var recoveryReply: ((Bool) -> Void)?
manual.recover = { recoveryReply = $0 }
manual.check()
precondition(manual.recovering && manual.blocksActions && !manual.cancelForQuit())
precondition(manualQuitAlerts == 2, "Recovery must explain why quit is blocked")
manual.check(); precondition(manualAttempts == 3)
recoveryReply?(false)
precondition(manual.recoveryRequired && !manual.recovering)
precondition(buttons(manual.settingsView()).contains { $0.title == "Retry recovery" && $0.isEnabled })
manual.check(); recoveryReply?(true)
precondition(!manual.recoveryRequired && manualChoice == nil)
manual.check(); finishManual?("prepared")
precondition(manual.prepared && manualChoice == .install && manualAttempts == 4)
precondition(manual.cancelForQuit(), "Sparkle's prepared relaunch can terminate")
var installerFailureAlerts = 0
manual.runAlert = { alert in
    precondition(alert.messageText == "Update failed", "Failure alert must not use the changing recovery status")
    installerFailureAlerts += 1; return .alertFirstButtonReturn
}
manual.showUpdaterError(NSError(domain: "fixture", code: 0)) {}
precondition(manual.recovering && !manual.prepared && installerFailureAlerts == 1)
manual.dismissUpdateInstallation()
precondition(manual.blocksActions && manual.working, "Sparkle dismissal must not unblock recovery")
recoveryReply?(false)
precondition(manual.recoveryRequired && manual.message.contains("Retry recovery"))
manual.check(); recoveryReply?(true)
precondition(!manual.blocksActions && !manual.recoveryRequired)
print("PASS: manual interruption consent, bounded settings wait, retained installer retry, recovery gate, installer failure recovery")

let abandoned = AppUpdater(automaticUpdatesEnabled: false, presentProgress: false)
abandoned.runAlert = { _ in .alertSecondButtonReturn }
abandoned.confirmManualUpdate(version: "1.0", notes: nil)
abandoned.prepare = { _, reply in reply("failed") }
var abandonedChoice: SPUUserUpdateChoice?
abandoned.showReady(toInstallAndRelaunch: { abandonedChoice = $0 })
precondition(abandonedChoice == nil)
precondition(abandoned.cancelForQuit() && abandonedChoice == .skip, "Explicit discard cancels install-on-exit")
print("PASS: explicit quit explains and discards the pending installer")

let failedRecovery = AppUpdater(automaticUpdatesEnabled: false, presentProgress: false)
failedRecovery.localize = { key, parameters in Localization.shared.text(key, language: "en", parameters) }
failedRecovery.runAlert = { _ in .alertSecondButtonReturn }
failedRecovery.confirmManualUpdate(version: "1.0", notes: nil)
failedRecovery.prepare = { _, reply in reply("recovery-required") }
failedRecovery.showReady(toInstallAndRelaunch: { _ in preconditionFailure("Recovery must precede installation") })
failedRecovery.runAlert = { alert in
    precondition(alert.messageText == "Update failed"); return .alertFirstButtonReturn
}
failedRecovery.showUpdaterError(NSError(domain: "fixture", code: 0)) {}
precondition(failedRecovery.recoveryRequired && failedRecovery.message.contains("Retry recovery"))
precondition(failedRecovery.checkTitle == "Retry recovery")
print("PASS: installer errors preserve the recovery guidance and use a fixed failure title")

let uninstall = AppUpdater(automaticUpdatesEnabled: false, presentProgress: false)
uninstall.runAlert = { _ in .alertSecondButtonReturn }
uninstall.confirmManualUpdate(version: "1.0", notes: nil)
uninstall.prepare = { _, reply in reply("failed") }
var uninstallChoice: SPUUserUpdateChoice?
uninstall.showReady(toInstallAndRelaunch: { uninstallChoice = $0 })
uninstall.runAlert = { _ in preconditionFailure("Uninstall already confirmed discarding the app") }
precondition(uninstall.cancelForQuit(discardConfirmed: true) && uninstallChoice == .skip)
print("PASS: confirmed uninstall cancels the retained installer without a quit dialog")

let interruptedPreparation = AppUpdater(automaticUpdatesEnabled: false, presentProgress: false)
interruptedPreparation.runAlert = { _ in .alertSecondButtonReturn }
interruptedPreparation.confirmManualUpdate(version: "1.0", notes: nil)
var delayedPreparation: ((String) -> Void)?
var restoredAfterError = false
interruptedPreparation.prepare = { _, reply in delayedPreparation = reply }
interruptedPreparation.recover = { reply in restoredAfterError = true; reply(true) }
interruptedPreparation.showReady(toInstallAndRelaunch: { _ in preconditionFailure("Failed installer must never install") })
interruptedPreparation.showUpdaterError(NSError(domain: "fixture", code: 0)) {}
interruptedPreparation.dismissUpdateInstallation()
precondition(interruptedPreparation.blocksActions, "Keep service operations blocked until the helper returns")
delayedPreparation?("prepared")
precondition(restoredAfterError && !interruptedPreparation.prepared && !interruptedPreparation.blocksActions)
print("PASS: installer error during preparation restores services after the helper returns")

// Use isolated preferences: no real application handoff is created by this test.
let progressSuite = "app.tripsurf.dotlink.progress-test.\(UUID().uuidString)"
let progressDefaults = UserDefaults(suiteName: progressSuite)!
defer { progressDefaults.removePersistentDomain(forName: progressSuite) }
let progressDriver = AppUpdater(automaticUpdatesEnabled: false, presentProgress: false, progressDefaults: progressDefaults)
progressDriver.runAlert = { _ in .alertSecondButtonReturn }
progressDriver.confirmManualUpdate(version: "0.4.26", notes: nil, build: "102")
precondition(progressDriver.progressActive && progressDriver.working)
progressDriver.showDownloadInitiated(cancellation: {})
precondition(progressDriver.progressFraction == nil)
progressDriver.showDownloadDidReceiveExpectedContentLength(100)
progressDriver.showDownloadDidReceiveData(ofLength: 35)
precondition(progressDriver.progressFraction == 0.35)
progressDriver.showDownloadDidStartExtractingUpdate()
precondition(progressDriver.progressFraction == nil)
progressDriver.showExtractionReceivedProgress(0.6)
precondition(progressDriver.progressFraction == 0.6)
progressDriver.showExtractionReceivedProgress(.nan)
precondition(progressDriver.progressFraction == 0.6)
var progressPrepare: ((String) -> Void)?
progressDriver.prepare = { _, reply in progressPrepare = reply }
progressDriver.showReady(toInstallAndRelaunch: { precondition($0 == .install) })
precondition(progressDriver.progressFraction == nil && progressDriver.preparing)
precondition(progressDefaults.dictionary(forKey: "DotLinkManualUpdateProgress") == nil)
progressPrepare?("prepared")
precondition(progressDefaults.dictionary(forKey: "DotLinkManualUpdateProgress")?["target"] as? String == "102")
let relaunched = AppUpdater(automaticUpdatesEnabled: false, presentProgress: false, progressDefaults: progressDefaults)
relaunched.beginStartupRecovery()
precondition(relaunched.progressActive && relaunched.working && relaunched.message == "Restoring connection…")
relaunched.startupRecoveryFinished(success: false, currentBuild: "102")
precondition(!relaunched.working && relaunched.message.contains("Retry recovery") && relaunched.checkTitle == "Retry recovery")
precondition(progressDefaults.dictionary(forKey: "DotLinkManualUpdateProgress") != nil)
var startupRetries = 0
relaunched.retryStartupRecovery = { startupRetries += 1; relaunched.beginStartupRecovery() }
relaunched.check()
precondition(startupRetries == 1 && relaunched.working, "Check must retry startup recovery, not start a competing update")
relaunched.startupRecoveryFinished(success: true, currentBuild: "102")
precondition(relaunched.message == "Dot Link is up to date." && !relaunched.working)
precondition(progressDefaults.dictionary(forKey: "DotLinkManualUpdateProgress") == nil)
progressDefaults.set(["target": "103", "at": Date().timeIntervalSince1970], forKey: "DotLinkManualUpdateProgress")
relaunched.beginStartupRecovery(); relaunched.startupRecoveryFinished(success: true, currentBuild: "102")
precondition(relaunched.message.contains("Update failed"), "An aborted replacement cannot claim update success")
progressDefaults.set(["target": "102", "at": Date().timeIntervalSince1970 - 90000], forKey: "DotLinkManualUpdateProgress")
let stale = AppUpdater(automaticUpdatesEnabled: false, presentProgress: false, progressDefaults: progressDefaults)
stale.beginStartupRecovery()
precondition(!stale.progressActive && progressDefaults.dictionary(forKey: "DotLinkManualUpdateProgress") == nil)
print("PASS: measured progress, indeterminate stages, prepared-only handoff, restart recovery, failure/retry, target match and stale handoff")

let preview = UpdateProgressWindow()
for language in Localization.shared.languages {
    let tr: (String) -> String = { Localization.shared.text($0, language: language) }
    for key in ["mac.downloading_update_p", "mac.verifying_update", "mac.preparing_update", "mac.installing_update", "mac.restoring_connection", "mac.update_progress_complete", "mac.update_preparation_failed_click_retry_update_the_download_is_kept", "mac.the_connection_could_not_be_restored_click_retry_recovery"] {
        let text = Localization.shared.text(key, language: language, ["p": "35"])
        preview.render(title: tr("mac.update_progress_title"), message: text, fraction: 0.35, working: true, actionTitle: tr("mac.retry_recovery"), action: {})
        let content = preview.window!.contentView!
        precondition(preview.stage.frame.minX >= 0 && preview.stage.frame.maxX <= content.bounds.width)
        precondition(preview.stage.frame.height >= ceil((text as NSString).boundingRect(with: NSSize(width: preview.stage.frame.width, height: 1000), options: [.usesLineFragmentOrigin, .usesFontLeading], attributes: [.font: preview.stage.font!]).height) - 1)
        precondition(preview.indicator.frame.maxY < preview.stage.frame.minY, "Progress cannot overlap stage text")
        precondition(preview.actionButton.frame.maxY < preview.indicator.frame.minY, "Action cannot overlap progress")
        precondition(preview.actionButton.intrinsicContentSize.width <= 392)
    }
}
print("PASS: all seven locales fit the real native progress window")
if CommandLine.arguments.contains("--preview-progress") {
    preview.render(title: "Dot Linkを更新中", message: "アップデートをダウンロード中… 35%", fraction: 0.35, working: true, actionTitle: nil, action: nil)
    preview.present(); app.run()
}

precondition(!AppUpdater.recoveredStateIsReady([:]))
precondition(!AppUpdater.recoveredStateIsReady(["installed": true, "bridge": true, "device": false, "tunnel": true]))
precondition(AppUpdater.recoveredStateIsReady(["installed": true, "bridge": true, "device": true, "tunnel": true]))
precondition(AppUpdater.recoveredStateIsReady(["installed": true, "lifecycleStopped": true]))
print("PASS: completion requires the actual running or paused installation")
