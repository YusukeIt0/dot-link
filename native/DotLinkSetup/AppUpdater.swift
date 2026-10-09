import AppKit
import Sparkle

final class AppUpdater: NSObject, SPUUpdaterDelegate, SPUUserDriver {
    var updater: SPUUpdater!
    var changed: (() -> Void)?
    var tr: (String, String) -> String = { ja, _ in ja }
    var canCheck: () -> Bool = { false }
    var prepare: (@escaping (String) -> Void) -> Void = { $0("failed") }
    var recover: () -> Void = {}
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
    private(set) var preparing = false
    private let repository = Bundle.main.object(forInfoDictionaryKey: "DotLinkUpdateRepository") as? String ?? ""
    var silentRelaunch: Bool { !manuallyApproved }
    var automatic: Bool { updater?.automaticallyChecksForUpdates ?? true }
    override init() {
        super.init()
        updater = SPUUpdater(hostBundle: .main, applicationBundle: .main, userDriver: self, delegate: self)
    }
    func start() {
        updater.automaticallyDownloadsUpdates = false // All installation goes through our service preparation.
        updater.sendsSystemProfile = false
        do {
            try updater.start()
            status("アップデートを確認できます", "Ready to check for updates")
        } catch { status("更新を開始できません", "Updates could not start") }
    }
    private func status(_ ja: String, _ en: String, working: Bool = false) {
        statusText = (ja, en)
        let next = tr(ja, en); if message == next && self.working == working { return }
        self.working = working; message = next; statusLabel?.stringValue = message; changed?()
    }
    func refreshLanguage() { if let (ja, en) = statusText { message = tr(ja, en); statusLabel?.stringValue = message; changed?() } }
    func settingsView() -> NSView {
        let box = NSStackView(); box.orientation = .vertical; box.alignment = .leading; box.spacing = 10
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let title = NSTextField(labelWithString: tr("アプリの更新", "App updates") + " · " + version); title.font = .systemFont(ofSize: 15, weight: .semibold); box.addArrangedSubview(title)
        let toggle = NSButton(checkboxWithTitle: tr("自動更新", "Automatic updates"), target: self, action: #selector(toggleAutomatic(_:))); toggle.state = automatic ? .on : .off; box.addArrangedSubview(toggle)
        box.addArrangedSubview(ActionButton(tr("アップデートを確認", "Check for updates")) { [weak self] in self?.check() })
        let detail = NSTextField(wrappingLabelWithString: message.isEmpty ? tr("自動更新は、Evenを使っていない間に適用します。", "Automatic updates install while Even is not in use.") : message); detail.font = .systemFont(ofSize: 12); detail.textColor = .secondaryLabelColor; box.addArrangedSubview(detail); statusLabel = detail
        return box
    }
    @objc private func toggleAutomatic(_ sender: NSButton) {
        updater.automaticallyChecksForUpdates = sender.state == .on
        if !automatic && !manuallyApproved && !preparing {
            retry?.invalidate(); retry = nil; cancelDownload?(); cancelDownload = nil
            let reply = readyReply; readyReply = nil; reply?(.skip)
            status("自動更新はオフです", "Automatic updates are off")
        }
    }
    func check() {
        manualCheck = true; updater.checkForUpdates()
    }
    @discardableResult func cancelForQuit() -> Bool {
        if extracting || preparing { return false }
        retry?.invalidate(); retry = nil
        if !prepared { let reply = readyReply; readyReply = nil; reply?(.skip); cancelDownload?(); cancelDownload = nil }
        return true
    }
    func updater(_ updater: SPUUpdater, mayPerform updateCheck: SPUUpdateCheck) throws {
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
    func show(_ request: SPUUpdatePermissionRequest, reply: @escaping (SUUpdatePermissionResponse) -> Void) { reply(SUUpdatePermissionResponse(automaticUpdateChecks: true, sendSystemProfile: false)) }
    func showUserInitiatedUpdateCheck(cancellation: @escaping () -> Void) { cancelDownload = cancellation; status("更新を確認中…", "Checking for updates…") }
    func showUpdateFound(with appcastItem: SUAppcastItem, state: SPUUserUpdateState, reply: @escaping (SPUUserUpdateChoice) -> Void) {
        cancelDownload = nil; manuallyApproved = false
        status("新しいバージョンがあります · " + appcastItem.displayVersionString, "Update available · " + appcastItem.displayVersionString)
        guard !appcastItem.isInformationOnlyUpdate else { reply(.dismiss); return }
        if !state.userInitiated && automatic { reply(.install); return }
        guard state.userInitiated else { reply(.dismiss); return }
        let alert = NSAlert(); alert.messageText = tr("新しいバージョンがあります", "An update is available") + " · " + appcastItem.displayVersionString
        alert.informativeText = String((appcastItem.itemDescription ?? tr("Dot Linkを更新します。設定と履歴は引き継ぎます。", "Update Dot Link. Your settings and history are preserved.")).prefix(4000))
        alert.addButton(withTitle: tr("あとで", "Later")); alert.addButton(withTitle: tr("更新する", "Update"))
        manuallyApproved = alert.runModal() == .alertSecondButtonReturn
        if !manuallyApproved { status("更新はあとで適用できます", "You can install this update later") }
        reply(manuallyApproved ? .install : .dismiss)
    }
    func showUpdateReleaseNotes(with downloadData: SPUDownloadData) {}
    func showUpdateReleaseNotesFailedToDownloadWithError(_ error: Error) {}
    func showUpdateNotFoundWithError(_ error: Error, acknowledgement: @escaping () -> Void) {
        status("最新バージョンです", "You’re up to date")
        if manualCheck { let alert = NSAlert(); alert.messageText = message; alert.runModal() }
        acknowledgement()
    }
    func showUpdaterError(_ error: Error, acknowledgement: @escaping () -> Void) {
        extracting = false
        status("更新できませんでした。あとで再確認してください。", "Update failed. Check again later.")
        if prepared { UserDefaults.standard.removeObject(forKey: "updateBackgroundRelaunchAt"); prepared = false; recover() }
        if manualCheck { let alert = NSAlert(); alert.messageText = message; alert.informativeText = error.localizedDescription; alert.runModal() }
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
        guard readyReply != nil, !preparing else { return }
        preparing = true
        prepare { [weak self] result in
            guard let self else { return }; self.preparing = false
            if result == "prepared" && !self.automatic && !self.manuallyApproved {
                self.recover(); let reply = self.readyReply; self.readyReply = nil; reply?(.skip)
                self.status("自動更新はオフです", "Automatic updates are off")
            } else if result == "prepared" {
                self.prepared = true; self.retry?.invalidate(); self.retry = nil
                self.status("更新を適用中…", "Installing update…", working: true)
                let reply = self.readyReply; self.readyReply = nil; reply?(.install)
            } else if result == "waiting" {
                self.status("Evenを閉じると更新を適用します", "Close Even to apply the update")
                if self.retry == nil { self.retry = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.attemptInstall() } }
            } else {
                let reply = self.readyReply; self.readyReply = nil; reply?(.skip)
                self.status("更新の準備に失敗しました。あとで再確認してください。", "Update preparation failed. Check again later.")
            }
        }
    }
    func showInstallingUpdate(withApplicationTerminated applicationTerminated: Bool, retryTerminatingApplication: @escaping () -> Void) { status("更新を適用中…", "Installing update…", working: true) }
    func showUpdateInstalledAndRelaunched(_ relaunched: Bool, acknowledgement: @escaping () -> Void) { acknowledgement() }
    func dismissUpdateInstallation() { extracting = false; cancelDownload = nil; retry?.invalidate(); retry = nil; readyReply = nil; manualCheck = false; manuallyApproved = false; working = false; changed?() }
}
