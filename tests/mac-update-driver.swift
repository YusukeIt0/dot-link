import AppKit
import Sparkle
final class ActionButton: NSButton {
    var handler: (() -> Void)?
    @objc func invoke() { handler?() }
    convenience init(_ text: String, _ action: @escaping () -> Void) { self.init(title: text, target: nil, action: nil); handler = action; target = self; self.action = #selector(invoke) }
}
let app = NSApplication.shared
let driver = AppUpdater()
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
driver.prepare = { preparation = $0 }
driver.recover = { recovered = true }
choice = nil
driver.showReady(toInstallAndRelaunch: { choice = $0 })
precondition(driver.preparing && !driver.cancelForQuit())
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
