# User guide

[Quickstart](https://github.com/YusukeIt0/dot-link#quickstart) · [Installation](#manual-installation) · [Dot connection](#dot-connection) · [Speech](#speech) · [Notifications](#mac-notifications) · [Location](#location-sharing) · [Updates](#updates) · [Troubleshooting](#troubleshooting)

## Manual installation

For the recommended one-command install, use the [quickstart](https://github.com/YusukeIt0/dot-link#quickstart).

Download `Dot-Link-…-arm64.zip` from the [latest Mac release](https://github.com/YusukeIt0/dot-link/releases/latest), unzip it, and move **Dot Link.app** to `~/Applications`. Create that folder if needed. Choose the app ZIP, not GitHub's source-code archives. Open the app and continue at [Prepare this Mac](https://github.com/YusukeIt0/dot-link#1-install-on-your-mac).

The installer checks the release checksum, app signature consistency and bundle identity. These checks do not provide Apple notarization. You can [inspect the installer](https://github.com/YusukeIt0/dot-link/blob/main/install.sh).

### First launch

Dot Link is not Apple-notarized. If macOS says it cannot verify the developer and you trust the download, dismiss the warning, then open **System Settings → Privacy & Security → Open Anyway**. Authenticate in the Mac dialog and choose **Open**. A warning that the app is damaged or will harm your computer is different; see [Apple's guidance](https://support.apple.com/en-us/102445).

This guide uses English labels. See [application language](#application-language)
to change the language in either app.

## Tailscale HTTPS setup

Connect the Mac and iPhone to the same Tailscale network. Before starting the relay, enable HTTPS for that network:

1. Open **DNS** in the [Tailscale admin console](https://login.tailscale.com/admin/dns).
2. Enable **MagicDNS** if it is off.
3. Under **HTTPS Certificates**, choose **Enable HTTPS** and review the confirmation that certificate names (including the machine name and tailnet DNS name) will be recorded in the public Certificate Transparency ledger. Ask your network administrator if you cannot change this setting.
4. Return to Dot Link and choose **Start relay** again.

Dot Link uses Tailscale Serve to provision the certificate automatically; you do not need to run `tailscale cert`. The connection stays within your Tailscale network; do not enable Funnel for Dot Link. See Tailscale's [HTTPS instructions](https://tailscale.com/docs/how-to/set-up-https-certificates) and [Serve documentation](https://tailscale.com/docs/features/tailscale-serve).

If Serve is waiting for permission, Dot Link shows `TAILSCALE_SERVE_APPROVAL_REQUIRED` with the steps above, including when the command reaches its timeout. If you run Serve manually and it prints a `https://login.tailscale.com/f/serve…` authorization link, you can also follow that link to grant permission. Dot Link does not include that device-specific link in copied diagnostics.

## Dot connection

Your account needs OpenAI tunnels and custom MCP connections in ChatGPT. Dot Link uses your existing Dot and does not provision access to these features. Setup on a fresh account is still being validated.

- Open **OpenAI connection settings** in the Mac app. Create a separate tunnel for this Mac; keep any tunnel used by another Mac.
- For the app's API key, choose **Restricted → Tunnels: Read and Use**. Creating the tunnel itself also requires **Read and Manage** on your account; the key used by Dot Link does not need Manage.
- Enter the **Tunnel ID** (`tunnel_…`) and **API key** in the Mac app, choose **Save and continue**, then **Start relay**.
- In ChatGPT, open **Plugins → Add → Add custom MCP server**. Enter a name, select **Connection: Tunnel** and this Mac’s tunnel, and choose **Authentication: No authentication**. Review and check **I understand and want to continue**, choose **Create as a plugin**, then connect it.
- Open **Home → Your dot**, choose **+** in the message box, and select the plugin you named. In the Mac app, choose **Copy setup message**, then paste and send it to your dot. When your dot confirms setup, return to the Mac app and choose **Check connection to Dot** before pairing Even.

The tunnel connects Dot to the Mac; Tailscale connects the iPhone to the Mac; the pairing code authorizes the Even companion. Keep API keys and pairing codes private. App updates need no GitHub token.

## Conversation and display

Hold to record on G2 and release to stop, or tap the microphone in the Even companion. Tap the same button again to stop and transcribe; the adjacent trash button discards recording or transcription without sending. Recordings are limited to 30 seconds. **Send after transcription** is on by default; turn it off to edit the text before sending with the up arrow. Use the left/right arrows to browse conversation history and the speaker button to turn read aloud on or off. **Display settings** controls idle timeout, wake gestures and head-raise behavior.

The companion's Mac connection section contains setup instructions, a copyable download URL, pairing-code entry and **Revoke this device**. If copying is unavailable, enter the displayed URL in your Mac browser. Older public companions may show these controls separately. Revoke stops this device immediately. If the Mac is unreachable, Dot Link saves the removal request and retries while running or when reopened. The existing connection section shows whether Mac removal is still pending. If saving fails, keep the app open; reopening may restore the connection. You can also remove connections from the Mac. Update both the Mac and Even companion to use persistent disconnect and cross-origin retry.

## Photos

In the phone composer, tap the camera icon to take a photo or the photo icon to choose one from your library. Allow the corresponding Even app permission when prompted. Add up to four photos, one selection at a time, and use the × on a preview to remove one. Add text by typing or dictating, or send photos on their own.

Selecting or taking a photo adds it to your draft. Tap **Send** when ready, or dictate your message: with automatic speech sending enabled, the completed dictation sends the text and attached photos together. With it disabled, both remain in the draft until you tap **Send**. Selecting a photo alone never sends it. A failed send keeps the draft so you can retry. Closing the app discards unsent photos. Conversation history shows the photo count; it does not retain a photo gallery. Photos require a Mac relay with photo-attachment support; the app asks you to update the Mac if it is too old. Camera and library availability depend on the installed Even host app. Photos waiting for Dot are kept for up to 24 hours. If they expire, select them again and resend. If temporary storage is full, retry later; your draft stays in place.

## Speech

Speech input requires Even 0.2.14 or later. Provider labels and detailed errors require 0.2.19; all six provider/model labels require 0.2.21. If these are missing, update the companion through Even Hub.

**Speech input** on the Mac offers local Whisper small and external services: Soniox, ElevenLabs, Microsoft, OpenAI and AssemblyAI. Enter your own service key in the app. Microsoft also needs an Azure Speech resource endpoint; use **About the endpoint** for instructions.

Local Whisper is free and runs on your Mac. External recordings go directly from the Mac to the selected service, under your account's charges and limits. Changes apply to the next recording; there is no automatic fallback. Saving a key does not test provider access—try a recording. Typed messages do not use speech recognition.

Keys are stored separately in macOS Keychain. Choose **Always Allow** when prompted; an app update may require permission again. To replace a key, delete it and save the new one. Deleting the active service key switches speech input back to Whisper.

Web addresses remain visible as plain text in the phone conversation and do not open when tapped. On the glasses, each address is replaced by a short localized placeholder indicating that the link is shown on the phone. Read-aloud skips both web addresses and these placeholders.

For **read-aloud**, use the switch in the Even companion. It starts OFF on first use and remembers your ON/OFF choice when you reopen the app. Selecting a different interface language turns read-aloud OFF; turn it on again when you want to listen. Reopening does not replay earlier replies. **Speech output** on the Mac identifies the current method as iPhone; external speech-output services are not yet available.

## Mac notifications

In the Mac app, choose **Permissions**, add the installed Dot Link.app under macOS **Accessibility**, and enable access. Then turn on **Share all Mac notifications with Dot**. Tell your Dot which notifications you want to hear about.

Sharing starts off. When enabled, readable new notifications—including sender names, headings and text—go to Dot. Some formats are unreadable; delivery and announcements may be delayed. Dot Link does not open the source chat or email, or reply in the source app. Pausing notification collection alone leaves the conversation relay running.

## Location sharing

Requires Mac 0.4.0 or later and Even 0.2.23 or later.

In ChatGPT **Settings → Plugins → your Dot Link connection**, choose **Update tools** if location tools are missing. The connection may still have the name you chose when creating it. The tools are `get_location_context` and `respond_to_location`, with the `location.updated` event.

Turn on **Share my location** under **Location sharing** in the Even companion and grant the phone's location permission. Then ask your existing Dot to monitor location changes and notify you on G2 only when useful information matches your preferences. Dot must create an event subscription; updating tools alone does not start announcements.

With Mac 0.4.23 or later, nearby streets, paths, areas and terrain references are added automatically while Dot is subscribed. Coordinates remain available during map loading or failure; a first area can take several minutes, while cached areas are faster. No region-download step is needed. References are not navigation or evidence that you entered a venue.

Sharing starts off. Turning it off stops new sharing and clears the relay's current location. If the Mac cannot receive the stop, sharing expires 90 seconds after the last relay update. The subscription stays available for later use but cannot read a location while sharing is off. Stopping does not delete locations already read by Dot, saved announcements or cached map data. The Mac removes map entries after 30 days without use; their contents and use days can reveal approximate past areas. Background updates and battery impact depend on the phone and OS. See [data handling](privacy.md#location-sharing).

## Updates

Use **Check for updates** in the Mac app. Automatic updates are currently paused. No GitHub account or token is required. Starting a manual update interrupts the active conversation while the Mac app restarts. If the app says **Finish the current settings operation, then click Retry update**, finish that operation and choose **Retry update**.

Updates preserve connection settings, pairing and history. You do not need to recreate your tunnel or pairing. Update the Even companion through Even Hub separately. The command-line installer stops if an app already exists in `~/Applications`; it is for installation, not replacement.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Start relay fails | Follow the failed step and guidance shown in the Mac app. For Tailscale errors, check that Tailscale is connected and review MagicDNS, HTTPS Certificates and Serve access in the Tailscale admin console. An existing Serve/Funnel configuration is not replaced automatically. If it still fails, choose **Copy diagnostics** and include that text in your issue. |
| Mac cannot reach Dot | Confirm tunnel ID, API-key permissions and the connection selected in your existing Dot. Send the Mac app's setup message and choose **Check connection to Dot**. |
| Even cannot connect | Keep the Mac awake, resume Dot Link, and connect Mac and iPhone to the same Tailscale network. Generate a fresh code and paste it in full within two minutes. |
| Notifications stop after an update | Remove Dot Link from macOS Accessibility, add the installed app again, and enable access. |
| Speech service rejects a recording | Check the selected service, key, account access and billing; for Microsoft also check the endpoint. Saving a key alone does not verify it. |
| Mac 0.3.0 or 0.3.1 waits for Even to close before Dot was ever connected | Quit Dot Link and replace only the app in `~/Applications` with the latest ZIP. Keep Application Support data; do not uninstall. |

Use **Connection details** in the Even companion to inspect connection status. For unresolved problems, [open an issue](https://github.com/YusukeIt0/dot-link/issues) with the versions, symptoms and steps to reproduce. Exclude credentials, pairing codes, private conversations and unreviewed diagnostic files.

**Copy diagnostics** appears after a Start relay setup failure. The failure guidance and copy button remain available after refreshing the status or returning from Advanced settings. They clear when you start another setup operation, including retrying Start relay. It copies only the failed step, a known error code, available command exit/signal information, and the Mac app version/build. It does not copy keys, hostnames, paths, command output or conversations. The last activation failure is also saved locally in `~/Library/Application Support/Dot Link/.runtime/setup-failure.json` when the installation has been located and that folder is writable; it includes the failure time. Dot Link removes it after activation completes without an error when file permissions allow. This is separate from connection-status checks and is not uploaded automatically. A failed step can have made partial progress, so check the current status before retrying.

Mac 0.4.7 may show only `SETUP_FAILED` and does not provide this diagnostic record. That code alone does not identify Tailscale, API-key permissions or any other specific cause. Avoid deleting settings or repeatedly reinstalling based on that code alone.

## Pause, quit and uninstall

Closing the Mac window keeps Dot Link running. **Pause** stops the relay and notification collection; **Quit** stops the app and its services. Reopen the app to resume with saved settings. Stopping services does not delete history.

**Uninstall Dot Link…** moves the app, runtime, speech model, connection settings and conversation history to Trash and removes speech-service keys from Keychain. There is no option to retain settings; setup is required to use the app again. See [data handling](privacy.md#disconnecting-and-deleting) for removal limits and external-service data.

### Application language

See the README for [supported interface languages](../README.md#make-it-yours).
Each app initially follows its device language, with English as the fallback,
and lets you select another supported language. The choice does not translate
conversations or change pairing, notification sharing, speech-service
configuration, or the wake phrase.
