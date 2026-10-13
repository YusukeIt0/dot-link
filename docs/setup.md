# User guide

[Quickstart](https://github.com/YusukeIt0/dot-link#quickstart) · [Installation](#manual-installation) · [Dot connection](#dot-connection) · [Speech](#speech) · [Notifications](#mac-notifications) · [Location](#location-sharing) · [Updates](#updates) · [Troubleshooting](#troubleshooting)

## Manual installation

For the recommended one-command install, use the [quickstart](https://github.com/YusukeIt0/dot-link#quickstart).

Download `Dot-Link-…-arm64.zip` from the [latest Mac release](https://github.com/YusukeIt0/dot-link/releases/latest), unzip it, and move **Dot Link.app** to `~/Applications`. Create that folder if needed. Choose the app ZIP, not GitHub's source-code archives. Open the app and continue at [Prepare this Mac](https://github.com/YusukeIt0/dot-link#1-install-on-your-mac).

The installer checks the release checksum, app signature consistency and bundle identity. These checks do not provide Apple notarization. You can [inspect the installer](https://github.com/YusukeIt0/dot-link/blob/main/install.sh).

### First launch

Dot Link is not Apple-notarized. If macOS says it cannot verify the developer and you trust the download, dismiss the warning, then open **System Settings → Privacy & Security → Open Anyway**. Authenticate in the Mac dialog and choose **Open**. A warning that the app is damaged or will harm your computer is different; see [Apple's guidance](https://support.apple.com/en-us/102445).

The app and installer use Japanese on Japanese Macs and English otherwise. The Even companion also supports Japanese; this guide uses the English labels.

## Dot connection

Your account needs OpenAI tunnels and custom MCP connections in ChatGPT. Dot Link uses your existing Dot and does not provision access to these features. Setup on a fresh account is still being validated.

- Open **OpenAI connection settings** in the Mac app. Create a separate tunnel for this Mac; keep any tunnel used by another Mac.
- For the app's API key, choose **Restricted → Tunnels: Read and Use**. Creating the tunnel itself also requires **Read and Manage** on your account; the key used by Dot Link does not need Manage.
- Enter the **Tunnel ID** (`tunnel_…`) and **API key** in the Mac app, choose **Save and continue**, then **Start relay**.
- In ChatGPT **Plugins → Add custom MCP server**, select **Tunnel** and this Mac's connection. In your existing Dot, enable the connection and send the message copied with **Copy setup message for Dot**. Choose **Check connection to Dot** on the Mac before pairing Even.

The tunnel connects Dot to the Mac; Tailscale connects the iPhone to the Mac; the pairing code authorizes the Even companion. Keep API keys and pairing codes private. App updates need no GitHub token.

## Conversation and display

Hold to record on G2 and release to stop, or use the recording and text controls in the Even companion. Recordings are limited to 30 seconds. **Send after transcription** is on by default; turn it off to review the text before sending. Browse conversation history and use **Display settings** to change idle timeout, wake gestures and head-raise behavior.

The companion's Mac connection section contains setup instructions, a copyable download URL, pairing-code entry and **Revoke this device**. If copying is unavailable, enter the displayed URL in your Mac browser. Older public companions may show these controls separately. To revoke access, keep the Mac reachable; a failed revocation needs to be retried before Mac-side access is considered removed.

## Speech

**Speech input** on the Mac offers local Whisper small and external services: Soniox, ElevenLabs, Microsoft, OpenAI and AssemblyAI. Enter your own service key in the app. Microsoft also needs an Azure Speech resource endpoint; use **About the endpoint** for instructions.

Local Whisper is free and runs on your Mac. External recordings go directly from the Mac to the selected service, under your account's charges and limits. Changes apply to the next recording; there is no automatic fallback. Saving a key does not test provider access—try a recording. Typed messages do not use speech recognition.

Keys are stored separately in macOS Keychain. Choose **Always Allow** when prompted; an app update may require permission again. To replace a key, delete it and save the new one. Deleting the active service key switches speech input back to Whisper.

For **read-aloud**, use the switch in the Even companion. **Speech output** on the Mac identifies the current method as iPhone; external speech-output services are not yet available.

## Mac notifications

In the Mac app, choose **Permissions**, add the installed Dot Link.app under macOS **Accessibility**, and enable access. Then turn on **Share all Mac notifications with Dot**. Tell your Dot which notifications you want to hear about.

Sharing starts off. When enabled, readable new notifications—including sender names, headings and text—go to Dot. Some formats are unreadable; delivery and announcements may be delayed. Dot Link does not open the source chat or email, or reply in the source app. Pausing notification collection alone leaves the conversation relay running.

## Location sharing

Requires Mac 0.4.0 or later and Even 0.2.23 or later.

In ChatGPT **Settings → Plugins → your Dot Link connection**, choose **Update tools** if location tools are missing. The connection may still have the name you chose when creating it. The tools are `get_location_context` and `respond_to_location`, with the `location.updated` event.

Turn on **Share my location** under **Location sharing** in the Even companion and grant the phone's location permission. Then ask your existing Dot to monitor location changes and notify you on G2 only when useful information matches your preferences. Dot must create an event subscription; updating tools alone does not start announcements.

Sharing starts off. Turning it off stops new sharing and clears the relay's current location. If the Mac cannot receive the stop, sharing expires 90 seconds after the last relay update. The subscription stays available for later use but cannot read a location while sharing is off. Stopping does not delete locations already read by Dot or saved announcements. Background updates and battery impact depend on the phone and OS. See [data handling](privacy.md#location-sharing).

## Updates

Use **Check for updates** in the Mac app. Automatic updates are currently paused. No GitHub account or token is required. If the app says **Close Even to apply the update**, close Dot Link in the Even app and let the Mac app restart.

Updates preserve connection settings, pairing and history. You do not need to recreate your tunnel or pairing. Update the Even companion through Even Hub separately. The command-line installer stops if an app already exists in `~/Applications`; it is for installation, not replacement.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Mac cannot reach Dot | Confirm tunnel ID, API-key permissions and the connection selected in your existing Dot. Send the Mac app's setup message and choose **Check connection to Dot**. |
| Even cannot connect | Keep the Mac awake, resume Dot Link, and connect Mac and iPhone to the same Tailscale network. Generate a fresh code and paste it in full within two minutes. |
| Notifications stop after an update | Remove Dot Link from macOS Accessibility, add the installed app again, and enable access. |
| Speech service rejects a recording | Check the selected service, key, account access and billing; for Microsoft also check the endpoint. Saving a key alone does not verify it. |
| Mac 0.3.0 or 0.3.1 waits for Even to close before Dot was ever connected | Quit Dot Link and replace only the app in `~/Applications` with the latest ZIP. Keep Application Support data; do not uninstall. |

Use **Connection details** in the Even companion to inspect connection status. For unresolved problems, [open an issue](https://github.com/YusukeIt0/dot-link/issues) with the versions, symptoms and steps to reproduce. Exclude credentials, pairing codes, private conversations and unreviewed diagnostic files.

## Pause, quit and uninstall

Closing the Mac window keeps Dot Link running. **Pause** stops the relay and notification collection; **Quit** stops the app and its services. Reopen the app to resume with saved settings. Stopping services does not delete history.

**Uninstall Dot Link…** moves the app, runtime, speech model, connection settings and conversation history to Trash and removes speech-service keys from Keychain. There is no option to retain settings; setup is required to use the app again. See [data handling](privacy.md#disconnecting-and-deleting) for removal limits and external-service data.
