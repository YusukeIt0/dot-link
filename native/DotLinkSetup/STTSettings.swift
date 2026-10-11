import AppKit

extension SetupApp {
    @objc func menuSpeech() {
        showingNotifications = false; showingPairing = false; showingDetails = false
        showingSpeech = true; speechChoice = state["sttProvider"] as? String == "soniox" ? "soniox" : "whisper"
        message = ""; speechMetadata = [:]; render(); showWindow(); refreshSpeechMetadata()
    }
    @objc func changeSpeechProvider(_ sender: NSPopUpButton) {
        speechChoice = sender.indexOfSelectedItem == 1 ? "soniox" : "whisper"
        speechKeyField?.stringValue = ""; message = ""
        if speechChoice == "whisper" { perform("stt-select", input: ["provider": "whisper"]) }
        else if speechMetadata["count"] == "1" { saveSpeech() }
        else { render() }
    }
    func renderSpeech() {
        button(tr("接続に戻る", "Back to connection")) { [weak self] in self?.showingSpeech = false; self?.speechKeyField?.stringValue = ""; self?.message = ""; self?.render() }
        let heading = NSStackView(); heading.orientation = .horizontal; heading.spacing = 10
        heading.addArrangedSubview(label(tr("音声入力", "Speech input"), size: 23, bold: true))
        heading.addArrangedSubview(HelpButton(tr("音声入力について", "About speech input"), tr("音声を文字に変換するサービスを選びます。Mac内での認識は無料です。外部サービスでは、ご自身のAPIキーを使い、このMacから録音を直接送信します。料金は各サービスの条件に従い、キーはMacのキーチェーンに保存します。変更は次の音声入力から反映されます。失敗時に別のサービスへ自動で切り替わることはありません。", "Choose a service to turn speech into text. Recognition on this Mac is free. External services use your own API key and receive recordings directly from this Mac. Charges follow each service's terms, and keys are stored in the Mac Keychain. Changes apply to the next recording. If recognition fails, Dot Link does not automatically switch to another service.")))
        stack.addArrangedSubview(heading)
        let body = NSStackView(); body.orientation = .vertical; body.alignment = .leading; body.spacing = 14
        body.edgeInsets = NSEdgeInsets(top: 18, left: 18, bottom: 18, right: 18)
        let service = NSStackView(); service.orientation = .horizontal; service.spacing = 12
        service.addArrangedSubview(symbol("waveform", size: 24))
        let choice = NSPopUpButton(); choice.addItems(withTitles: [tr("Whisper（無料）", "Whisper (Free)"), "Soniox"])
        choice.selectItem(at: speechChoice == "soniox" ? 1 : 0); choice.target = self; choice.action = #selector(changeSpeechProvider(_:))
        choice.controlSize = .large; choice.isEnabled = !busy && speechMetadata["status"] != nil
        choice.setAccessibilityLabel(tr("音声認識サービス", "Speech recognition service")); service.addArrangedSubview(choice); body.addArrangedSubview(service)
        let active = state["sttProvider"] as? String ?? "whisper"
        let status = label(tr("使用中：", "In use: ") + (active == "whisper" ? "Whisper" : active == "soniox" ? "Soniox" : tr("未確認", "Unknown")), size: 13)
        status.textColor = .secondaryLabelColor; body.addArrangedSubview(status)
        speechMetadataLabel = nil; speechKeyField = nil
        func action(_ title: String, primary: Bool = false, _ handler: @escaping () -> Void) {
            let control = ActionButton(title, handler); control.controlSize = .large; control.isEnabled = !busy
            if primary { control.keyEquivalent = "\r" }
            body.addArrangedSubview(control)
        }
        if speechChoice == "soniox" {
            let saved = label(speechMetadataText(), size: 13); saved.textColor = .secondaryLabelColor
            speechMetadataLabel = saved
            if speechMetadata["count"] != "0" { body.addArrangedSubview(saved) }
            if speechMetadata["status"] == "ok", speechMetadata["count"] == "0" {
                let key = NSSecureTextField(); key.placeholderString = tr("APIキー", "API key"); key.font = .systemFont(ofSize: 15); key.isEnabled = !busy
                key.cell?.wraps = false; key.cell?.isScrollable = true; key.cell?.usesSingleLineMode = true; key.cell?.lineBreakMode = .byClipping
                key.setAccessibilityLabel("Soniox API key"); body.addArrangedSubview(key); speechKeyField = key
                key.widthAnchor.constraint(equalTo: body.widthAnchor, constant: -36).isActive = true; key.heightAnchor.constraint(equalToConstant: 28).isActive = true
            }
            let fee = label(tr("ご自身のAPI料金がかかります。", "Your API usage charges apply."), size: 12); fee.textColor = .secondaryLabelColor; body.addArrangedSubview(fee)
            let permission = label(tr("Dot Linkのキーチェーン確認画面が表示されたら「常に許可」を選択してください。", "If a Keychain access dialog appears for Dot Link, choose Always Allow."), size: 12); permission.textColor = .secondaryLabelColor; body.addArrangedSubview(permission)
            if speechMetadata["count"] == "1" {
                action(tr("キーを削除", "Delete key")) { [weak self] in self?.deleteSpeechKey() }
            } else if speechMetadata["count"] == "0" {
                action(busy ? tr("保存中…", "Saving…") : tr("保存", "Save"), primary: true) { [weak self] in self?.saveSpeech() }
            } else if speechMetadata["status"] != nil {
                action(tr("アクセスを確認", "Check access")) { [weak self] in self?.saveSpeech() }
            }
        }
        if !message.isEmpty { body.addArrangedSubview(label(message, size: 13)) }
        let card = NSBox(); card.boxType = .custom; card.borderColor = .separatorColor; card.borderWidth = 0.5; card.cornerRadius = 12
        card.fillColor = .controlBackgroundColor; card.contentViewMargins = .zero; card.contentView = body
        stack.addArrangedSubview(card); card.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -64).isActive = true
        if speechChoice == "soniox" {
            let links = NSStackView(); links.orientation = .horizontal; links.spacing = 16
            for (title, url) in [(tr("料金", "Pricing"), "https://soniox.com/pricing"), (tr("データの扱い", "Data handling"), "https://soniox.com/docs/security-and-privacy")] {
                let link = ActionButton(title) { [weak self] in self?.open(url) }; link.isBordered = false; link.font = .systemFont(ofSize: 12); links.addArrangedSubview(link)
            }
            stack.addArrangedSubview(links)
        }
    }
    func deleteSpeechKey() {
        guard !busy else { return }
        let alert = NSAlert(); alert.messageText = tr("Sonioxのキーを削除しますか？", "Delete the Soniox key?")
        alert.informativeText = tr("削除後はWhisperへ切り替えます。", "Speech input will switch to Whisper after deletion.")
        alert.addButton(withTitle: tr("削除", "Delete")); alert.addButton(withTitle: tr("キャンセル", "Cancel"))
        if alert.runModal() == .alertFirstButtonReturn { performSpeechCredential("delete") }
    }
    func speechMetadataText() -> String {
        guard let status = speechMetadata["status"] else { return tr("保存済みキーを確認中…", "Checking saved key…") }
        guard status == "ok" else { return tr("保存済みキー：確認できません", "Saved key: unavailable") }
        guard speechMetadata["count"] == "1" else { return "" }
        var when = tr("日時不明", "Date unknown")
        if let raw = speechMetadata["savedAt"], let date = ISO8601DateFormatter().date(from: raw) {
            let formatter = DateFormatter(); formatter.locale = Locale(identifier: language == "ja" ? "ja_JP" : "en_US")
            formatter.dateFormat = language == "ja" ? "yyyy年M月d日 H時mm分" : "MMM d, yyyy, HH:mm"
            when = formatter.string(from: date)
        }
        return tr("最終保存：", "Last saved: ") + when
    }
    func refreshSpeechMetadata() {
        guard let executable = Bundle.main.executableURL else { return }
        speechMetadataGeneration += 1; let generation = speechMetadataGeneration
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let task = Process(); task.executableURL = executable; task.arguments = ["--stt-credential", "metadata"]
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
                guard let self, self.speechMetadataGeneration == generation else { return }
                let changed = self.speechMetadata["status"] != result["status"] || self.speechMetadata["count"] != result["count"]
                self.speechMetadata = result
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
        let value = speechKeyField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if speechMetadata["count"] == "0" && value.isEmpty {
            message = tr("APIキーを入力してください。", "Enter your API key."); render(); return
        }
        speechKeyField?.stringValue = ""
        // Save is one user action: store/reuse the key, then apply the provider.
        performSpeechCredential(value.isEmpty ? "authorize" : "save", key: value) { [weak self] in
            self?.perform("stt-select", input: ["provider": "soniox"])
        }
    }

    func performSpeechCredential(_ operation: String, key: String = "", completion: (() -> Void)? = nil) {
        guard !busy, let executable = Bundle.main.executableURL else { return }
        let input = (try? JSONSerialization.data(withJSONObject: ["key": key])) ?? Data()
        busy = true; message = ""; render()
        let task = Process(); task.executableURL = executable; task.arguments = ["--stt-credential", operation]
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
                    self.message = operation == "delete" ? self.tr("キーを削除しました。", "Key deleted.") : operation == "save" ? self.tr("キーを保存しました。APIとの接続は音声入力時に確認します。", "Key saved. API access will be checked when you use speech input.") : self.tr("保存済みキーにアクセスできました。", "Access to the saved key succeeded.")
                    if operation == "delete" { self.perform("stt-select", input: ["provider": "whisper"]); return }
                } else if result == "missing" {
                    self.refreshSpeechMetadata()
                    self.message = self.tr("APIキーを入力してください。", "Enter your API key.")
                } else if result == "cancelled" {
                    self.message = self.tr("操作をキャンセルしました。再試行はしていません。", "Operation cancelled. No retry was made.")
                } else {
                    self.message = self.tr("キーを利用できません。キーチェーンのロック・アクセス許可、入力したキーを確認してください。", "The key could not be used. Check the Keychain lock, access permission and the entered key.")
                }
                self.render()
            }
        }
    }
}
