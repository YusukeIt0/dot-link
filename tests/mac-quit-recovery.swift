// Compiled with the real SetupApp, replacing only its top-level entry point.
// Test bootstrap bypasses installation/update startup and uses disposable data.
import AppKit

final class QuitFixture: NSObject, NSApplicationDelegate {
    let sut = SetupApp()
    let root = URL(fileURLWithPath: ProcessInfo.processInfo.environment["QUIT_FIXTURE_ROOT"]!)
    let original = Bundle.main.bundleURL
    var displaced: URL { root.appendingPathComponent("Moved Dot Link.app") }
    var phase = 0
    var awaitingQuit = false
    var timer: Timer?
    var deadline = Date().addingTimeInterval(30)
    let baseline = CommandLine.arguments.contains("--baseline")

    func applicationDidFinishLaunching(_ notification: Notification) {
        UserDefaults.standard.register(defaults: ["notificationSettingsImported": true, "monitoringPaused": true,
            "shareAllMacNotifications": false, "selectedApps": [], "notificationSharingIntentID": UUID().uuidString])
        NSApp.setActivationPolicy(.accessory)
        sut.window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 740),
            styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
        sut.window.isReleasedWhenClosed = false
        sut.contentScroll = SetupWindowLayout.install(in: sut.window)
        sut.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        sut.appLocationValidated = true; sut.appLocationReady = true
        sut.state = ["installed": true, "directory": root.appendingPathComponent("data").path,
            "bridge": true, "device": true, "tunnel": true, "subscribed": true, "step": "pair"]
        sut.connectNotifications()
        sut.notifications?.healthTimer?.invalidate()
        sut.render()
        precondition(sut.notifications?.relaySuspended == false)
        displaceBundle()
        timer = Timer.scheduledTimer(withTimeInterval: 0.05, repeats: true) { [self] _ in advance() }
        requestQuit()
    }

    func requestQuit() { awaitingQuit = true; NSApp.terminate(nil) }

    func displaceBundle() {
        if CommandLine.arguments.contains("--remove-bundle") {
            try! FileManager.default.copyItem(at: original, to: displaced)
            try! FileManager.default.removeItem(at: original)
        } else { try! FileManager.default.moveItem(at: original, to: displaced) }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        awaitingQuit = false
        return sut.applicationShouldTerminate(sender)
    }

    func advance() {
        precondition(Date() < deadline, "Quit fixture timed out")
        guard !awaitingQuit, !sut.busy, !sut.quitting, !sut.currentAction.isEmpty else { return }
        if phase == 5 { return }
        #if BASELINE
        guard !sut.message.isEmpty else { return }
        #else
        guard sut.quitFailure != nil else { return }
        #endif
        precondition(!sut.allowTermination, "Only a verified stop may permit exit")
        precondition(!sut.quitting, "A failed attempt must cancel pending termination")
        switch phase {
        case 0, 1:
            #if BASELINE
            precondition(sut.message.contains("HELPER_FAILED"), "phase=\(phase) action=\(sut.currentAction) message=\(sut.message)")
            precondition(sut.notifications?.relaySuspended == true)
            #else
            precondition(sut.quitFailure?.code == "HELPER_LAUNCH_FAILED")
            precondition(sut.quitFailure?.helperStarted == false)
            precondition(sut.quitFailure?.restoreApp == true)
            precondition(sut.notifications?.relaySuspended == false, "Never-started stop must restore prior notification state")
            if phase == 0 { renderLanguages() }
            #endif
            if phase == 0 { phase = 1; requestQuit(); return }
            try! FileManager.default.moveItem(at: displaced, to: original)
            #if !BASELINE
            sut.currentAction = "pause"
            sut.receive(["kind": "error", "code": "SERVICE_STILL_STOPPING"])
            precondition(labels(sut.stack).contains(where: { $0.contains("SERVICE_STILL_STOPPING") }),
                "A later Pause failure must be visible during Quit recovery")
            precondition(!labels(sut.stack).contains(where: { $0.contains(original.path) }),
                "Restoring the bundle must remove obsolete restoration guidance")
            precondition(sut.quitFailure != nil && !sut.allowTermination,
                "Showing a later error must not claim a confirmed stop")
            #endif
            if baseline {
                print("BASELINE reproduced: two failed quits leave GUI open and notification relay suspended; bundle restored")
                phase = 5
            } else {
                // A running helper with no terminal record is a distinct failure.
                try! "no-result".write(to: root.appendingPathComponent("mode"), atomically: true, encoding: .utf8)
                phase = 2
            }
            requestQuit()
        case 2:
            #if !BASELINE
            precondition(sut.quitFailure?.code == "HELPER_NO_RESULT")
            precondition(sut.quitFailure?.helperStarted == true && sut.quitFailure?.restoreApp == false)
            precondition(sut.notifications?.relaySuspended == true)
            precondition(sut.notifications?.notificationSummary == sut.tr("mac.notifications_paused"))
            sut.currentAction = "inspect"
            sut.receive(sut.state.merging(["kind": "result", "bridge": true, "lifecycleStopped": false]) { _, new in new })
            precondition(sut.notifications?.relaySuspended == true,
                "Refreshing a running bridge must preserve suspension after an unconfirmed stop")
            precondition(sut.quitFailure != nil)
            #endif
            try! "stop-error".write(to: root.appendingPathComponent("mode"), atomically: true, encoding: .utf8)
            phase = 3; requestQuit()
        case 3:
            #if !BASELINE
            precondition(sut.quitFailure?.code == "SERVICE_STILL_STOPPING", "Preserve helper-reported failures")
            precondition(sut.quitFailure?.helperStarted == true)
            precondition(sut.notifications?.relaySuspended == true)
            #endif
            // Test a never-started retry after a partly completed/unknown stop:
            // it must preserve suspension, not blindly resume notifications.
            displaceBundle()
            phase = 4; requestQuit()
        case 4:
            #if !BASELINE
            precondition(sut.quitFailure?.helperStarted == false)
            precondition(sut.notifications?.relaySuspended == true)
            #endif
            try! FileManager.default.moveItem(at: displaced, to: original)
            try! "stop".write(to: root.appendingPathComponent("mode"), atomically: true, encoding: .utf8)
            phase = 5; requestQuit()
        default: preconditionFailure("Expected confirmed stop: action=\(sut.currentAction) message=\(sut.message)")
        }
    }

    #if !BASELINE
    func renderLanguages() {
        for language in Localization.shared.languages {
            sut.language = language; sut.render()
            sut.window.contentView!.layoutSubtreeIfNeeded()
            let text = labels(sut.stack)
            precondition(text.contains(sut.tr("mac.quit_still_open")))
            precondition(text.contains(where: { $0.contains(original.path) }))
            precondition(!text.contains(where: { $0.hasPrefix("mac.") }))
            let retry = buttons(sut.stack).first { $0.title == sut.tr("mac.quit_retry") }
            precondition(retry?.isEnabled == true && retry?.keyEquivalent == "\r")
            if let destination = ProcessInfo.processInfo.environment["QUIT_FIXTURE_IMAGES"],
               let bitmap = sut.stack.bitmapImageRepForCachingDisplay(in: sut.stack.bounds) {
                sut.stack.cacheDisplay(in: sut.stack.bounds, to: bitmap)
                try! bitmap.representation(using: .png, properties: [:])!.write(to:
                    URL(fileURLWithPath: destination).appendingPathComponent(language + ".png"))
            }
        }
        sut.language = "en"
        sut.showingDetails = true; sut.render()
        precondition(labels(sut.stack).contains(sut.tr("mac.advanced_settings")), "Recovery must not hide existing settings")
        precondition(sut.quitFailure != nil, "Opening settings must not claim the stop succeeded")
        sut.showingDetails = false; sut.render()
    }
    func labels(_ view: NSView) -> [String] {
        (view as? NSTextField).map { [$0.stringValue] } ?? view.subviews.flatMap(labels)
    }
    func buttons(_ view: NSView) -> [NSButton] {
        (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons)
    }
    #endif

    func applicationWillTerminate(_ notification: Notification) {
        precondition(phase == 5 && sut.allowTermination)
        try! "GUI exited after quitReady".write(to: root.appendingPathComponent("gui-exited"), atomically: true, encoding: .utf8)
        UserDefaults.standard.removePersistentDomain(forName: Bundle.main.bundleIdentifier!)
        print("PASS: real SetupApp quit waits for confirmed stop; restored bundle permits GUI exit")
    }
}
let app = NSApplication.shared
let fixture = QuitFixture()
app.delegate = fixture
app.run()
