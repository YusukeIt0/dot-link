import AppKit

extension SetupApp {
    @objc func menuSpeech() {
        showingNotifications = false; showingPairing = false; showingDetails = false; showingSpeechOutput = false
        showingSpeech = true; let active = state["sttProvider"] as? String ?? "whisper"
        speechChoice = STTProviderInfo.order.contains(active) ? active : "whisper"
        speechEndpointDraft = state["sttMicrosoftEndpoint"] as? String ?? ""
        messageRecord = nil; speechMetadata = [:]; render(); showWindow(); refreshSpeechMetadata()
    }
    @objc func menuSpeechOutput() {
        showingNotifications = false; showingPairing = false; showingDetails = false; showingSpeech = false
        showingSpeechOutput = true; speechKeyField?.stringValue = ""; messageRecord = nil
        render(); showWindow()
    }
    func renderSpeechOutput() {
        button(tr("mac.back_to_connection")) { [weak self] in self?.showingSpeechOutput = false; self?.render() }
        let heading = NSStackView(); heading.orientation = .horizontal; heading.spacing = 10
        heading.addArrangedSubview(label(tr("mac.speech_output"), size: 23, bold: true))
        heading.addArrangedSubview(HelpButton(tr("mac.about_speech_output"), tr("mac.choose_a_service_to_turn_text_into_speech_speech_synthesis_on_your_iphon")))
        stack.addArrangedSubview(heading)
        stack.addArrangedSubview(label(tr("mac.turn_read_aloud_on_or_off_in_dot_link_inside_the_even_app"), size: 13))
        let body = NSStackView(); body.orientation = .vertical; body.alignment = .leading; body.spacing = 14
        body.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
        let service = NSStackView(); service.orientation = .horizontal; service.spacing = 12
        service.addArrangedSubview(symbol("speaker.wave.2", size: 24))
        let choice = NSPopUpButton(); choice.addItem(withTitle: "iPhone"); choice.selectItem(at: 0)
        choice.controlSize = .large; choice.setAccessibilityLabel(tr("mac.speech_output_method"))
        service.addArrangedSubview(choice); body.addArrangedSubview(service)
        let detail = label(tr("mac.iphone_system_voice"), size: 13); detail.textColor = .secondaryLabelColor; body.addArrangedSubview(detail)
        let card = NSBox(); card.boxType = .custom; card.borderColor = .separatorColor; card.borderWidth = 0.5; card.cornerRadius = 12
        card.fillColor = .controlBackgroundColor; card.contentViewMargins = .zero; card.contentView = body
        stack.addArrangedSubview(card); card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
    }
    @objc func changeSpeechProvider(_ sender: NSPopUpButton) {
        guard STTProviderInfo.order.indices.contains(sender.indexOfSelectedItem) else { return }
        speechEndpointDraft = speechEndpointField?.stringValue ?? speechEndpointDraft
        speechChoice = STTProviderInfo.order[sender.indexOfSelectedItem]
        speechKeyField?.stringValue = ""; messageRecord = nil; speechMetadata = [:]
        speechMetadataGeneration += 1
        if speechChoice == "whisper" {
            speechMetadata = ["status": "ok", "count": "0"]
            perform("stt-select", input: ["provider": "whisper"])
        } else { render(); refreshSpeechMetadata(applySelection: true) }
    }
    @objc func speechEndpointChanged(_ sender: NSTextField) { speechEndpointDraft = sender.stringValue }
    func validSpeechEndpoint() -> String? {
        let value = (speechEndpointField?.stringValue ?? speechEndpointDraft).trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URLComponents(string: value), url.scheme == "https", url.user == nil, url.password == nil,
              url.port == nil, url.query == nil, url.fragment == nil, ["", "/"].contains(url.path),
              let host = url.host, host.range(of: #"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cognitiveservices\.azure\.com$"#, options: .regularExpression) != nil else { return nil }
        return "https://" + host
    }
    func renderSpeech() {
        button(tr("mac.back_to_connection")) { [weak self] in self?.showingSpeech = false; self?.speechKeyField?.stringValue = ""; self?.messageRecord = nil; self?.render() }
        let heading = NSStackView(); heading.orientation = .horizontal; heading.spacing = 10
        heading.addArrangedSubview(label(tr("mac.speech_input"), size: 23, bold: true))
        heading.addArrangedSubview(HelpButton(tr("mac.about_speech_input"), tr("mac.choose_a_service_to_turn_speech_into_text_recognition_on_this_mac_is_fre")))
        stack.addArrangedSubview(heading)
        let body = NSStackView(); body.orientation = .vertical; body.alignment = .leading; body.spacing = 14
        body.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
        let service = NSStackView(); service.orientation = .horizontal; service.spacing = 12
        service.addArrangedSubview(symbol("waveform", size: 24))
        let choice = NSPopUpButton(); choice.addItems(withTitles: STTProviderInfo.order.map { provider in
            let title = STTProviderInfo.catalog[provider]?.label ?? provider
            return provider == "whisper" ? title + tr("mac.free") : title
        })
        choice.selectItem(at: STTProviderInfo.order.firstIndex(of: speechChoice) ?? 0); choice.target = self; choice.action = #selector(changeSpeechProvider(_:))
        choice.controlSize = .large; choice.isEnabled = !busy && speechMetadata["status"] != nil
        choice.setAccessibilityLabel(tr("mac.speech_recognition_service")); service.addArrangedSubview(choice); body.addArrangedSubview(service)
        let active = state["sttProvider"] as? String ?? "whisper"
        let status = label(tr("mac.in_use") + (STTProviderInfo.catalog[active]?.label ?? tr("mac.unknown")), size: 13)
        status.textColor = .secondaryLabelColor; body.addArrangedSubview(status)
        speechMetadataLabel = nil; speechKeyField = nil; speechEndpointField = nil
        func action(_ title: String, primary: Bool = false, _ handler: @escaping () -> Void) {
            let control = ActionButton(title, handler); control.controlSize = .large; control.isEnabled = !busy
            if primary { control.keyEquivalent = "\r" }
            body.addArrangedSubview(control)
        }
        if speechChoice != "whisper" {
            if speechChoice == "microsoft" {
                body.addArrangedSubview(label(tr("mac.endpoint"), size: 13))
                let endpoint = NSTextField(string: speechEndpointDraft)
                endpoint.placeholderString = "https://your-resource.cognitiveservices.azure.com"
                endpoint.setAccessibilityLabel(tr("mac.microsoft_endpoint"))
                endpoint.isEnabled = !busy; endpoint.cell?.isScrollable = true
                endpoint.target = self; endpoint.action = #selector(speechEndpointChanged(_:))
                body.addArrangedSubview(endpoint); speechEndpointField = endpoint
                endpoint.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -36).isActive = true
            }
            let saved = label(speechMetadataText(), size: 13); saved.textColor = .secondaryLabelColor
            speechMetadataLabel = saved
            if speechMetadata["count"] != "0" { body.addArrangedSubview(saved) }
            if speechMetadata["status"] == "ok", speechMetadata["count"] == "0" {
                let key = NSSecureTextField(); key.placeholderString = tr("mac.api_key"); key.font = .systemFont(ofSize: 15); key.isEnabled = !busy
                key.cell?.wraps = false; key.cell?.isScrollable = true; key.cell?.usesSingleLineMode = true; key.cell?.lineBreakMode = .byClipping
                key.setAccessibilityLabel((STTProviderInfo.catalog[speechChoice]?.name ?? speechChoice) + " API key"); body.addArrangedSubview(key); speechKeyField = key
                key.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -36).isActive = true; key.heightAnchor.constraint(equalToConstant: 28).isActive = true
            }
            let fee = label(tr("mac.your_api_usage_charges_apply"), size: 12); fee.textColor = .secondaryLabelColor; body.addArrangedSubview(fee)
            let permission = label(tr("mac.if_a_keychain_access_dialog_appears_for_dot_link_choose_always_allow"), size: 12); permission.textColor = .secondaryLabelColor; body.addArrangedSubview(permission)
            if speechMetadata["count"] == "1" {
                if speechChoice == "microsoft" || active != speechChoice {
                    action(tr("mac.save"), primary: true) { [weak self] in self?.saveSpeech() }
                }
                action(tr("mac.delete_key")) { [weak self] in self?.deleteSpeechKey() }
            } else if speechMetadata["count"] == "0" {
                action(busy ? tr("mac.saving") : tr("mac.save"), primary: true) { [weak self] in self?.saveSpeech() }
            } else if speechMetadata["status"] != nil {
                action(tr("mac.check_access")) { [weak self] in self?.saveSpeech() }
            }
        }
        if !message.isEmpty { body.addArrangedSubview(label(message, size: 13)) }
        let card = NSBox(); card.boxType = .custom; card.borderColor = .separatorColor; card.borderWidth = 0.5; card.cornerRadius = 12
        card.fillColor = .controlBackgroundColor; card.contentViewMargins = .zero; card.contentView = body
        stack.addArrangedSubview(card); card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
        if speechChoice != "whisper" {
            let links = NSStackView(); links.orientation = .horizontal; links.spacing = 16
            let info = STTProviderInfo.catalog[speechChoice]
            var destinations = [(tr("mac.pricing"), info?.pricing ?? ""), (tr("mac.data_handling"), info?.privacy ?? "")]
            if speechChoice == "microsoft" {
                destinations.append((tr("mac.about_the_endpoint"), "https://learn.microsoft.com/en-us/azure/ai-services/speech-service/llm-speech?pivots=programming-language-javascript#retrieve-resource-information"))
            }
            for (title, url) in destinations where !url.isEmpty {
                let link = ActionButton(title) { [weak self] in self?.open(url) }; link.isBordered = false; link.font = .systemFont(ofSize: 12); links.addArrangedSubview(link)
            }
            stack.addArrangedSubview(links)
        }
    }
    func deleteSpeechKey() {
        guard !busy else { return }
        let name = STTProviderInfo.catalog[speechChoice]?.name ?? speechChoice
        let alert = NSAlert(); alert.messageText = tr("mac.delete_provider_key", ["name": name])
        alert.informativeText = state["sttProvider"] as? String == speechChoice
            ? tr("mac.speech_input_will_switch_to_whisper_after_deletion")
            : tr("mac.the_key_saved_on_this_mac_will_be_deleted")
        alert.addButton(withTitle: tr("mac.delete")); alert.addButton(withTitle: tr("mac.cancel"))
        if alert.runModal() == .alertFirstButtonReturn { performSpeechCredential("delete") }
    }
    func speechMetadataText() -> String {
        guard let status = speechMetadata["status"] else { return tr("mac.checking_saved_key") }
        guard status == "ok" else { return tr("mac.saved_key_unavailable") }
        guard speechMetadata["count"] == "1" else { return "" }
        var when = tr("mac.date_unknown")
        if let raw = speechMetadata["savedAt"], let date = ISO8601DateFormatter().date(from: raw) {
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: Localization.shared.metadata[language]?.dateLocale ?? "en_US")
            formatter.dateFormat = Localization.shared.metadata[language]?.dateFormat ?? "MMM d, yyyy, HH:mm"
            when = formatter.string(from: date)
        }
        return tr("mac.last_saved") + when
    }
    func refreshSpeechMetadata(applySelection: Bool = false) {
        if speechChoice == "whisper" { speechMetadata = ["status": "ok", "count": "0"]; if showingSpeech { render() }; return }
        let provider = speechChoice
        guard let executable = Bundle.main.executableURL else { return }
        speechMetadataGeneration += 1; let generation = speechMetadataGeneration
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let task = Process(); task.executableURL = executable; task.arguments = ["--stt-credential", "metadata", provider]
            let output = Pipe(); task.standardOutput = output; task.standardError = FileHandle.nullDevice; task.standardInput = FileHandle.nullDevice
            var metadata = ["status": "unavailable"]
            do {
                try task.run()
                let watchdog = DispatchWorkItem { if task.isRunning { kill(task.processIdentifier, SIGKILL) } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 8, execute: watchdog)
                let data = output.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit(); watchdog.cancel()
                if task.terminationStatus == 0, data.count < 2048, let result = try? JSONSerialization.jsonObject(with: data) as? [String: String] { metadata = result }
            } catch {}
            let result = metadata
            DispatchQueue.main.async {
                guard let self, self.speechMetadataGeneration == generation, self.speechChoice == provider else { return }
                let changed = self.speechMetadata["status"] != result["status"] || self.speechMetadata["count"] != result["count"]
                self.speechMetadata = result
                if applySelection && result["status"] == "ok" && result["count"] == "1" && (provider != "microsoft" || self.validSpeechEndpoint() != nil) {
                    self.saveSpeech(); return
                }
                // Rebuild only when key availability changes, never for a timestamp refresh.
                if changed && self.showingSpeech { self.render() }
                else { self.speechMetadataLabel?.stringValue = self.speechMetadataText() }
            }
        }
    }

    func saveSpeech() {
        guard !busy else { return }
        if speechChoice == "whisper" { perform("stt-select", input: ["provider": "whisper"]); return }
        guard speechMetadata["status"] != nil else { return }
        var selection = ["provider": speechChoice]
        if speechChoice == "microsoft" {
            speechEndpointDraft = speechEndpointField?.stringValue ?? speechEndpointDraft
            guard let endpoint = validSpeechEndpoint() else {
                messageRecord = LocalizedMessage("mac.enter_your_azure_endpoint_see_about_the_endpoint_below"); render(); return
            }
            speechEndpointDraft = endpoint; selection["endpoint"] = endpoint
        }
        let value = speechKeyField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if speechMetadata["count"] == "0" && value.isEmpty {
            messageRecord = LocalizedMessage("mac.enter_your_api_key"); render(); return
        }
        speechKeyField?.stringValue = ""
        // Save is one user action: store/reuse the key, then apply the provider.
        performSpeechCredential(value.isEmpty ? "authorize" : "save", key: value) { [weak self] in
            self?.perform("stt-select", input: selection)
        }
    }

    func performSpeechCredential(_ operation: String, key: String = "", completion: (() -> Void)? = nil) {
        guard !busy, let executable = Bundle.main.executableURL else { return }
        let provider = speechChoice
        speechEndpointDraft = speechEndpointField?.stringValue ?? speechEndpointDraft
        let input = (try? JSONSerialization.data(withJSONObject: ["key": key])) ?? Data()
        busy = true; messageRecord = nil; render()
        let task = Process(); task.executableURL = executable; task.arguments = ["--stt-credential", operation, provider]
        let output = Pipe(), stdin = Pipe(); task.standardOutput = output; task.standardInput = stdin; task.standardError = FileHandle.nullDevice; helper = task
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var status = "unavailable"
            do {
                try task.run()
                let watchdog = DispatchWorkItem { if task.isRunning { kill(task.processIdentifier, SIGKILL) } }
                DispatchQueue.global().asyncAfter(deadline: .now() + 60, execute: watchdog)
                if operation == "save" { stdin.fileHandleForWriting.write(input) }; try? stdin.fileHandleForWriting.close()
                let data = output.fileHandleForReading.readDataToEndOfFile(); task.waitUntilExit(); watchdog.cancel()
                if task.terminationStatus == 0, data.count < 8192, let result = try? JSONSerialization.jsonObject(with: data) as? [String: String] { status = result["status"] ?? "unavailable" }
            } catch {}
            let result = status
            DispatchQueue.main.async {
                guard let self else { return }; self.busy = false; self.helper = nil
                if result == "ok" {
                    self.refreshSpeechMetadata()
                    if let completion { completion(); return }
                    self.messageRecord = operation == "delete" ? LocalizedMessage("mac.key_deleted") : operation == "save" ? LocalizedMessage("mac.key_saved_api_access_will_be_checked_when_you_use_speech_input") : LocalizedMessage("mac.access_to_the_saved_key_succeeded")
                    if operation == "delete" && self.state["sttProvider"] as? String == provider { self.speechChoice = "whisper"; self.perform("stt-select", input: ["provider": "whisper"]); return }
                } else if result == "missing" {
                    self.refreshSpeechMetadata()
                    self.messageRecord = LocalizedMessage("mac.enter_your_api_key")
                } else if result == "cancelled" {
                    self.messageRecord = LocalizedMessage("mac.operation_cancelled_no_retry_was_made")
                } else {
                    self.messageRecord = LocalizedMessage("mac.the_key_could_not_be_used_check_the_keychain_lock_access_permission_and")
                }
                self.render()
            }
        }
    }
}
