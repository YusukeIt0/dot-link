import AppKit

extension SetupApp {
    @objc func menuHealthcare() {
        showingNotifications = false; showingPairing = false; showingDetails = false; showingSpeech = false; showingSpeechOutput = false
        showingHealthcare = true; messageRecord = nil; render(); showWindow()
        perform("health", input: ["action":"status"])
    }
    func renderHealthcare() {
        button(tr("mac.back_to_connection")) { [weak self] in
            guard let self else { return }; self.showingHealthcare = false; self.healthPoll?.invalidate(); self.healthSecretField?.stringValue = ""; self.render()
        }
        add(tr("mac.health_settings"), size: 23, bold: true)
        let configured = healthState["configured"] as? Bool == true
        let status = healthState["status"] as? String ?? "loading"
        let body = NSStackView(); body.orientation = .vertical; body.alignment = .leading; body.spacing = 12
        body.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
        let heading = NSStackView(); heading.orientation = .horizontal; heading.spacing = 10
        heading.addArrangedSubview(symbol("heart", size: 24)); heading.addArrangedSubview(label("Polar", size: 20, bold: true)); body.addArrangedSubview(heading)
        let statusKey: String
        switch status {
        case "locked", "HEALTH_KEY_UNAVAILABLE": statusKey = "mac.health_locked"
        case "connecting": statusKey = "mac.health_connecting"
        case "disconnect_pending": statusKey = "mac.health_disconnect_pending"
        case "loading": statusKey = "mac.health_loading"
        case "ready": statusKey = configured ? "mac.health_connected" : "mac.health_not_connected"
        case "HEALTH_RECONNECT_REQUIRED": statusKey = "mac.health_authorization_error"
        case "HEALTH_CREDENTIALS_REQUIRED": statusKey = "mac.health_credentials_error"
        case "HEALTH_CALLBACK_UNAVAILABLE": statusKey = "mac.health_callback_error"
        case "HEALTH_RATE_LIMITED": statusKey = "mac.health_rate_limit"
        case "HEALTH_NETWORK_UNAVAILABLE": statusKey = "mac.health_network_error"
        case "HEALTH_STORAGE_UNAVAILABLE": statusKey = "mac.health_storage_error"
        case "HEALTH_REQUEST_FAILED", "HEALTH_INVALID_RESPONSE": statusKey = "mac.health_request_error"
        default: statusKey = "mac.health_error"
        }
        let locked = status == "locked" || status == "HEALTH_KEY_UNAVAILABLE"
        let connected = status == "ready" && configured
        let checking = status == "loading" || status == "connecting"
        let statusIcon = connected ? "checkmark.circle.fill" : checking ? "arrow.triangle.2.circlepath" : "exclamationmark.circle"
        let statusColor: NSColor = connected ? .systemGreen : checking ? .secondaryLabelColor : .systemOrange
        let statusRow = NSStackView(views: [symbol(statusIcon, size: 13, color: statusColor), label(tr(statusKey), size: 12, bold: true)])
        statusRow.orientation = .horizontal; statusRow.alignment = .centerY; statusRow.spacing = 4
        body.addArrangedSubview(statusRow)
        statusRow.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -36).isActive = true
        func action(_ key: String, _ handler: @escaping () -> Void) {
            let control = ActionButton(tr(key), handler); control.controlSize = .large; control.isEnabled = !busy; body.addArrangedSubview(control)
        }
        if !configured && !locked && status != "disconnect_pending" {
            body.addArrangedSubview(label(tr("mac.health_step1"), size: 14, bold: true))
            action("mac.health_register") { [weak self] in self?.open("https://admin.polaraccesslink.com/") }
            body.addArrangedSubview(label(tr("mac.health_redirect"), size: 12))
            let redirect = label("http://localhost:3464/polar/callback", size: 12); redirect.isSelectable = true; body.addArrangedSubview(redirect)
            body.addArrangedSubview(label(tr("mac.health_step2"), size: 14, bold: true))
            let client = NSTextField(string: healthClientDraft); client.placeholderString = "Client ID"; client.setAccessibilityLabel("Polar Client ID"); client.isEnabled = !busy
            body.addArrangedSubview(client); client.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -36).isActive = true; healthClientField = client
            let secret = NSSecureTextField(); secret.placeholderString = "Client Secret"; secret.setAccessibilityLabel("Polar Client Secret"); secret.isEnabled = !busy; secret.cell?.isScrollable = true
            body.addArrangedSubview(secret); secret.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -36).isActive = true; healthSecretField = secret
            action("mac.health_connect") { [weak self] in
                guard let self else { return }; let id = self.healthClientField?.stringValue ?? "", secret = self.healthSecretField?.stringValue ?? ""
                self.healthClientDraft = id; self.healthSecretField?.stringValue = ""
                self.perform("health", input: ["action":"connect", "clientId":id, "clientSecret":secret])
            }
        } else if configured && !locked && status != "disconnect_pending" {
            action("mac.health_reconnect") { [weak self] in self?.perform("health", input: ["action":"connect"]) }
            action("mac.health_disconnect") { [weak self] in self?.confirmHealthAction("disconnect", key:"mac.health_disconnect_confirm") }
        }
        body.addArrangedSubview(label(tr("mac.health_step3"), size: 14, bold: true))
        body.addArrangedSubview(label(tr("mac.health_even"), size: 13))
        body.addArrangedSubview(label(tr("mac.health_encrypted"), size: 12))
        if locked { action("mac.check_access") { [weak self] in self?.perform("health", input: ["action":"unlock"]) } }
        if status == "disconnect_pending" {
            action("mac.health_retry") { [weak self] in self?.perform("health", input: ["action":"disconnect"]) }
        }
        if locked || status == "disconnect_pending" {
            action("mac.health_polar_account") { [weak self] in self?.open("https://flow.polar.com/") }
            action("mac.health_reset") { [weak self] in self?.confirmHealthAction("reset", key:"mac.health_reset_confirm") }
        }
        if status != "ready" && status != "loading" && status != "connecting" && !locked && status != "disconnect_pending" { action("mac.health_retry") { [weak self] in self?.perform("health", input: ["action":status == "HEALTH_STORAGE_UNAVAILABLE" ? "retry_storage" : "status"]) } }
        for case let text as NSTextField in body.arrangedSubviews where !text.isEditable {
            text.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -36).isActive = true
        }
        let card = NSBox(); card.boxType = .custom; card.borderColor = .separatorColor; card.borderWidth = 0.5; card.cornerRadius = 12
        card.fillColor = .controlBackgroundColor; card.contentViewMargins = .zero; card.contentView = body
        stack.addArrangedSubview(card); card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
    }
    func confirmHealthAction(_ action: String, key: String) {
        let alert = NSAlert(); alert.messageText = tr(key); alert.addButton(withTitle: tr("mac.health_continue")); alert.addButton(withTitle: tr("mac.cancel"))
        if alert.runModal() == .alertFirstButtonReturn { perform("health", input:["action":action]) }
    }
}
