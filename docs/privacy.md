# Data handling

Implementation baseline: Mac 0.4.0 and Even through 0.2.23, documented October 12, 2026. Location sharing requires compatible versions on both devices; legacy-version differences are noted below.

[Quickstart](https://github.com/YusukeIt0/dot-link#quickstart) · [User guide](setup.md)

Dot Link connects Even G2 to your existing ChatGPT Dot through a relay on a Mac you control. There is no shared conversation server operated by the developer. Your Mac and iPhone need your own Tailscale connection.

## What is collected and sent

- **Audio and conversations:** Hold-to-talk captures G2 audio until release or a stop action, with a 30-second limit. In Even 0.2.39, optional Hey dot input (default off) keeps the G2 microphone open while Dot Link is active and detects the cue locally on the phone. Waiting audio stays in bounded memory and is not sent to a service or written to a recording file. Following speech is captured for up to 30 seconds and ends on silence. OFF, unpairing and app exit stop listening; a transient connection failure pauses new activation without discarding an active utterance; read-aloud and processing pause it. See [wake-word behavior and validation limits](wake-word.md). Audio goes over HTTPS to your Mac. Free local Whisper transcription is the default. If you explicitly select an external service (Soniox, ElevenLabs, Microsoft, OpenAI or AssemblyAI) in Speech input on your Mac, subsequent recordings go directly from your Mac to that service using your API key. Your service account charges and limits apply. Unselected services are not contacted, and failures do not trigger an automatic provider switch. Selecting OpenAI transcription is separate from connecting your existing Dot. Transcribed or manually submitted text goes to your existing Dot through your personal ChatGPT connection. Replies and proactive messages return through the Mac to G2.
- **Pairing and camera:** The current pairing flow pastes a code generated on the Mac. It does not use the camera. Legacy Even packages (0.2.13 and below) and the web UI bundled with Mac 0.2.21 contain hidden QR/camera code. Pairing codes are credentials; do not share them.
- **Head movement:** With “Show when I raise my head” enabled, G2 motion sensor values are used locally to decide when to restore the display. This setting defaults to on and can be disabled in display settings. Dot Link has no code to send these sensor values to the Mac or Dot, or store a movement history. Settings such as the calibrated forward angle are saved.
- **Mac notifications:** This optional prototype reads Notification Center title, description and value strings through macOS Accessibility while monitoring is active. Ordinary application notification strings may be read into memory for classification. With “Share all Mac notifications with Dot” enabled, visible sender names, headings and text from readable new notifications go through the Mac relay to your existing Dot. Sharing defaults to off. Notifications may be shared without an identified source; unknown sources and senders are not inferred. Chats and emails are not opened to retrieve content beyond the notification. Dot decides whether and when to announce it. Not every notification format or immediate arrival is guaranteed, and replying in the source app is not supported. Pausing notifications alone does not stop the conversation relay.
- **Read aloud:** When enabled, Dot replies are passed to the device's Web Speech API. Whether speech processing stays on the device depends on the device and voice engine.

## What is stored

**On the Mac:** With Whisper, recordings and transcription output are temporary working files, removed on normal completion or processing errors. Automatic cleanup after power loss or forced termination is not implemented. Up to 100 conversations, 100 notifications and 1,000 proactive messages are stored. At the proactive-message limit, new submissions are refused. These histories are not automatically deleted by age. Mac history and Dot's own memory and history are separate.

External STT paths send audio and receive transcription in memory without creating recording files. The provider choice is stored in local Mac settings; each service API key is stored in macOS Keychain. You can save, replace and delete it in Speech input. Keychain permission dialogs are never shown during transcription. If access fails, you are directed to explicitly allow access in settings. App updates may require permission again.

The Mac also stores connection and tunnel settings, OpenAI tunnel credentials, relay authentication keys, and event delivery destinations and secrets. These are local files; files containing secrets are given owner-only read/write permissions. They are not all hashed or stored in Keychain. The all-notification sharing choice, paused state, language and update preferences are stored as Mac app settings.

**On the Even side:** WebView storage and the Even SDK's app storage retain the relay address, session credential, expiry, app origin and update-recovery credential. The optional Hey dot choice is saved. Language and display preferences are also saved: idle time, wake gesture, head-raise enablement, angle and calibrated forward angle. Dot Link does not itself implement Keychain storage for these records.

An uncertain outgoing message has a saved ID and SHA-256 text digest for duplicate prevention. This record does not contain the message text. Short-text hashes may be guessable and are not treated as anonymous data.

**Pairing expiry:** Codes last two minutes and can be used once. Sessions last at most 90 days; recovery does not extend the original expiry. Mac pairing records retain hashes of session and recovery credentials, origins and expiry times, without the original tokens. This describes pairing records, not the separate tunnel and other credentials listed above.

## Diagnostics and external services

Timing logs contain processing IDs, stages, timestamps and durations. Notification diagnostics store permission and monitoring states, the sharing setting, legacy selected app names, counts, synthetic test notification bodies, and detection and forwarding results. Ordinary notification strings are handled in memory for classification and deduplication; their bodies are not stored in the notification diagnostic file or delivery ledger. The ledger stores up to 4,096 notification-identifier hashes, delivery IDs, timestamps, stages and attempt counts. Shared notification text is stored in the relay notification history and sent to Dot. These diagnostic files are not automatically sent to the developer. Review their contents before sharing them for support.

Dot Link has no app analytics or advertising SDK. Initial speech-model downloads connect to Hugging Face; update feeds and signed archives come from GitHub. Those hosts receive ordinary connection information such as IP addresses. Dot Link does not attach conversations, recordings, pairing credentials or tunnel credentials to those download requests. Updates require no GitHub token, and Sparkle system-profile reporting is disabled.

Conversations sent to OpenAI, and information handled by the OS, Even and Tailscale, are also subject to those services' rules and settings. This document describes Dot Link's implementation; it does not guarantee storage or deletion behavior inside external services.

When Soniox is selected, its [data handling policy](https://soniox.com/docs/security-and-privacy) and your agreement apply. Dot Link cannot guarantee storage or deletion within Soniox.

The Microsoft endpoint is stored in local Mac settings. Review the official pricing and data handling links in Speech input and your agreement with the selected service. Dot Link does not guarantee provider-side retention or deletion.

## Disconnecting and deleting

- **“Revoke this device” on the Even side:** Requests session revocation on the Mac and removes local connection information. If communication fails, it reports that Mac-side revocation is incomplete. It does not erase Mac conversation history or all Even-side language, display and duplicate-prevention records. Deletion through the Even SDK can also fail; Mac-side revocation is needed to reliably invalidate access.
- **Revoking all devices on the Mac:** The maintenance command `node scripts/beta-pair.mjs revoke-all`, run in the relay working directory, invalidates pairing codes, sessions and recovery credentials. It does not delete conversation history or tunnel credentials.
- **Removing the Mac app:** Use “Uninstall Dot Link…” in the app. It stops the relay and notifications, removes login items, and moves the app, dedicated runtime, speech model, connection settings and conversation history to Trash. All service keys saved by Speech input are deleted from Keychain. If key deletion fails, removal does not proceed. There is no option to retain settings; using the app again requires setup. The older Mac 0.2.21 offered an option to retain settings and history.
- **Removal scope:** Files are moved to Trash, rather than immediately and permanently erased. Development installations remove known target files; custom files, previous backups and some older logs may remain. This does not erase device backups, Even-side storage, update credentials stored in Keychain by earlier development releases, or data held by external services. Mac display and notification preferences are removed after a backup is moved to Trash; if that backup fails, the completion dialog says the preferences were kept.

Stopping services alone does not delete history. Manage or delete information already sent to OpenAI or other services separately with those services.

## Location sharing

Location sharing starts off. When enabled in the Even app, the phone location, measurement time and accuracy (and speed/heading when available) are sent to your connected Mac. Your existing Dot can read the latest location and decide whether to offer useful information. Turning sharing off stops new sharing and location-based announcements. If disconnected, the relay expires sharing 90 seconds after its last update. You control the OS and Even app location permissions.

Dot Link does not save a coordinate trail to disk. The latest location and short-lived decision context remain in Mac memory; preferences, subscriptions and revoked identifiers are saved. Dot's announcements enter ordinary conversation history and may contain place names. OpenAI's handling of locations read by Dot depends on your agreement and settings. Turning sharing off does not delete information already sent. Background operation, actual update intervals and battery impact depend on the device and OS.

## Contact

Use [GitHub Issues](https://github.com/YusukeIt0/dot-link/issues) for non-sensitive reports. Do not attach credentials, pairing codes, recordings, conversations or unreviewed diagnostic files.
