# User guide

[Quickstart](https://github.com/YusukeIt0/dot-link#quickstart) · [Installation](#manual-installation) · [Dot connection](#dot-connection) · [Speech](#speech) · [Notifications](#mac-notifications) · [Location](#location-sharing) · [Updates](#updates) · [Troubleshooting](#troubleshooting)

## Manual installation

Mac releases using Node 26 require macOS 13.5 or later. On macOS 13.0–13.4,
update macOS first. The updater filters incompatible releases and leaves your
existing app and stored data in place.

For the recommended one-command install, use the [quickstart](https://github.com/YusukeIt0/dot-link#quickstart).

Download `Dot-Link-…-arm64.zip` from the [latest Mac release](https://github.com/YusukeIt0/dot-link/releases/latest), unzip it, and move **Dot Link.app** to `~/Applications`. Create that folder if needed. Choose the app ZIP, not GitHub's source-code archives. Open the app and continue at [Prepare this Mac](https://github.com/YusukeIt0/dot-link#1-install-on-your-mac).

The installer checks the release checksum, app signature and bundle identity, and that the app is signed by this project's developer (Team ID `27K9A27SGR`). From Mac 0.5.4, releases are signed with a Developer ID and notarized by Apple. You can [inspect the installer](https://github.com/YusukeIt0/dot-link/blob/main/install.sh).

From Mac 0.4.37, opening Dot Link elsewhere restores a missing app in `~/Applications`
and opens the installed copy before connecting. If an equal or newer verified copy
is already installed there, Dot Link opens it without replacing it. If the installed
copy is older or cannot be verified, follow the app's replacement guidance. Replace
only the app; keep your saved settings and do not use **Uninstall**. Finder may
display Applications in your language; **Go → Go to Folder → `~/Applications`**
opens the intended folder.

### First launch

From Mac 0.5.4, Dot Link is notarized by Apple. When you open a downloaded copy for the first time, macOS asks you to confirm opening an app from the internet; choose **Open**.

Earlier releases are not notarized. If macOS says it cannot verify the developer and you trust the download, dismiss the warning, then open **System Settings → Privacy & Security → Open Anyway**. Authenticate in the Mac dialog and choose **Open**. A warning that the app is damaged or will harm your computer is different; see [Apple's guidance](https://support.apple.com/en-us/102445).

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

### If the connection does not return

While a configured Mac shows **Reconnecting**, it checks the relay automatically. If a service stays offline, **Resume** in the Dot Link menu can retry relay startup.

When the Mac recognizes an earlier conversation connection, it shows reconnection help first. First-time setup remains available if you removed the plugin. If a previously connected Mac returns to the ChatGPT connection screen, choose **Open ChatGPT**, sign in if needed, and ask your existing Dot: “Check the connection to Dot Link and resume the event subscription for receiving utterances from G2.” Then return to the Mac app and choose **Check connection to Dot**. This button checks the connection; it does not create a subscription. Reuse your existing plugin and pairing.

Dot Link retains subscriptions across restarts. On builds that include the 24-hour conversation lease, the longer lifetime takes effect at the next successful registration or renewal. Mac 0.4.40 (120) formal uses a one-hour default. If your Mac comes back online before that deadline, the same connection can resume. Restarting or logging out of macOS preserves the relay’s login settings. Choosing Quit in Dot Link still stops its services. A shorter requested lifetime still applies. [ChatGPT automatically refreshes subscriptions before their expiration](https://developers.openai.com/plugins/build/mcp-events#refresh-a-subscription), but the documented behavior does not specify how long it retries after a refresh fails while the Mac is offline. Use the recovery steps above if the connection remains unavailable; a restart alone does not mean the saved setup was erased.

## Conversation and display

The first answer is shown with its question. Follow-up answers appear on separate pages. Independent messages initiated by Dot appear without a question; they are not attached to a nearby conversation just because they arrived close together.

With Mac 0.5.5 and Even 0.4.3, Dot checks the G2 when an answer or suggestion is ready. If the glasses report that you are wearing them, the message goes to G2. If they are in the case, or the companion cannot confirm that G2 is available, Dot can continue in your existing ChatGPT Dot chat. A question asked there stays in that chat. On G2s that report only case status, a connected pair outside its case can receive a message while sitting on a desk. Opening or closing the case does not start a message.

If your Mac updates first and you still have Even 0.4.2, you can keep asking questions from G2. Open your usual Dot chat for the answer. The glasses show a short cue in the question's history and finish waiting. Updating the companion enables G2 delivery when the glasses are available.

Keep Dot Link running in Even Hub to let it answer the Mac while you use another app. Even Hub handles background operation automatically. If answers stop reaching Dot chat or announcements about shared Mac notifications stop after the Mac update, choose **Update tools** for your existing Dot Link connection in ChatGPT. Finish any active work and restart that same Dot. The updated tools let Dot confirm which notification was shared with it and claim a reply for your chat. Your existing pairing and sharing choices carry over.

Hold to record on G2 and release to stop, or tap the microphone in the Even companion. Tap the same button again to stop and transcribe; the adjacent trash button discards recording or transcription without sending. Recordings are limited to 30 seconds. **Send after transcription** is on by default; turn it off to edit the text before sending with the up arrow. Use the left/right arrows to browse conversation history and the speaker button to turn read aloud on or off. **Display settings** controls idle timeout, wake gestures and head-raise behavior.

In **Operation settings**, **Disable hold-to-record** blocks manual recording on both G2 and the phone and discards any manual recording in progress. It does not enable wake listening; use separately enabled Hey dot or text input.

The companion's Mac connection section contains setup instructions, a copyable download URL, pairing-code entry and **Revoke this device**. If copying is unavailable, enter the displayed URL in your Mac browser. Older public companions may show these controls separately. Revoke stops this device immediately. If the Mac is unreachable, Dot Link saves the removal request and retries while running or when reopened. The existing connection section shows whether Mac removal is still pending. If saving fails, keep the app open; reopening may restore the connection. You can also remove connections from the Mac. Update both the Mac and Even companion to use persistent disconnect and cross-origin retry.

## Photos

In the phone composer, tap the camera icon to take a photo or the photo icon to choose one from your library. Allow the corresponding Even app permission when prompted. Add up to four photos, one selection at a time, and use the × on a preview to remove one. Add text by typing or dictating, or send photos on their own.

Selecting or taking a photo adds it to your draft. Tap **Send** when ready, or dictate your message: with automatic speech sending enabled, the completed dictation sends the text and attached photos together. With it disabled, both remain in the draft until you tap **Send**. Selecting a photo alone never sends it. A failed send keeps the draft so you can retry. Closing the app discards unsent photos. Conversation history shows the photo count; it does not retain a photo gallery. Photos require a Mac relay with photo-attachment support; the app asks you to update the Mac if it is too old. Camera and library availability depend on the installed Even host app. Photos waiting for Dot are kept for up to 24 hours. If they expire, select them again and resend. If temporary storage is full, retry later; your draft stays in place.

## Speech

Speech input requires Even 0.2.14 or later. Provider labels and detailed errors require 0.2.19; all six provider/model labels require 0.2.21. If these are missing, update the companion through Even Hub.

**Speech input** on the Mac offers local Whisper small and external services: Soniox, ElevenLabs, Microsoft, OpenAI and AssemblyAI. Enter your own service key in the app. Microsoft also needs an Azure Speech resource endpoint; use **About the endpoint** for instructions.

Local Whisper is free and runs on your Mac. External recordings go directly from the Mac to the selected service, under your account's charges and limits. Changes apply to the next recording; there is no automatic fallback. Saving a key does not test provider access—try a recording. Typed messages do not use speech recognition. Your Mac checks recordings for speech before using any recognition service. A recording with no detected speech sends no message, even when automatic sending is enabled. The check uses the same policy for every language; it does not authenticate the speaker.

Keys are stored separately in macOS Keychain. Choose **Always Allow** when prompted; an app update may require permission again. To replace a key, delete it and save the new one. Deleting the active service key switches speech input back to Whisper.

Web addresses remain visible as plain text in the phone conversation and do not open when tapped. On the glasses, each address is replaced by a short localized placeholder indicating that the link is shown on the phone. Read-aloud skips both web addresses and these placeholders.

For **read-aloud**, use the switch in the Even companion. It starts OFF on first use and remembers your ON/OFF choice when you reopen the app. Selecting a different interface language turns read-aloud OFF; turn it on again when you want to listen. Reopening does not replay earlier replies. **Speech output** on the Mac identifies the current method as iPhone; external speech-output services are not yet available.

## Mac notifications

If Dot chooses to tell you about a shared notification, it uses the same G2 or Dot chat destination as a conversation message. A notification Dot marks silent stays silent. A deferred notification can be reconsidered later.

In the Mac app, choose **Permissions**, add the installed Dot Link.app under macOS **Accessibility**, and enable access. Then turn on **Share all Mac notifications with Dot**. With Mac 0.4.35 or later, Dot Link asks your existing Dot to receive shared notifications automatically; no separate event setup is needed. You can tell your Dot which notifications you want to hear about.

Sharing starts off. When enabled, readable new notifications—including sender names, headings and text—go to Dot. Some formats are unreadable; delivery and announcements may be delayed. Dot Link does not open the source chat or email, or reply in the source app. Turning sharing off, pausing collection or removing Accessibility access stops new notification sharing. If the app stops unexpectedly, the relay stops accepting new notifications within 30 seconds. Pausing notification collection alone leaves the conversation relay running. Notifications arriving before reception is ready use the existing bounded retries and may be dropped; no offline archive is created. An explicit request to Dot to stop notification reception is preserved until you enable sharing again or explicitly resume reception.

## Location sharing

Requires Mac 0.4.0 or later and Even 0.2.23 or later.

In ChatGPT **Settings → Plugins → your Dot Link connection**, choose **Update tools** if location tools are missing. The connection may still have the name you chose when creating it. The tools include `get_location_context`, `get_mobility_context`, `respond_to_location` and `respond_to_context`, with the `location.updated` event. The combined response tool lets Dot use relevant shared sources in one answer; no additional sharing switch is needed.

For automatic context reception, update to Mac 0.4.34 or later. Turn on **Share my location** under **Sharing settings** in the Even companion and grant the phone's location permission. Dot Link connects that choice to your existing Dot's context reception. There is no separate monitoring switch or follow-up setup request. Dot decides whether useful information warrants an announcement, and can remain silent. The status shows when Dot is ready. With **Weather context** enabled, weather for the shared current location joins those same decisions.

With Mac 0.4.23 or later, nearby streets, paths, areas and terrain references are added automatically while Dot is subscribed. Coordinates remain available during map loading or failure; a first area can take several minutes, while cached areas are faster. No region-download step is needed. References are not navigation or evidence that you entered a venue.

Sharing starts off. Turning it off stops new sharing and clears the relay's current location. If the Mac cannot receive the stop, sharing expires 90 seconds after the last relay update. The subscription stays available for later use but cannot read a location while sharing is off. Stopping does not delete locations already read by Dot, saved announcements or cached map data. The Mac removes map entries after 30 days without use; their contents and use days can reveal approximate past areas. Background updates and battery impact depend on the phone and OS. See [data handling](privacy.md#location-sharing).

For walking and terrain evidence, also enable **Walking and terrain information**.
This separately permits the external queries explained beside the switch. It is off
by default and requires Dot Link for Mac v0.4.27 or later and Even v0.3.50 or later. If the Mac does
not support it, the option is unavailable with an update note; ordinary location
sharing continues. Ask Dot a normal
walking or hill question with a known destination; no route-mode or account setup
is needed. Public-transport data is not included. Dot interprets the evidence and
its limits; model time, slope and endpoints do not establish safe access. Turning
the option off stops pending queries when the Mac receives the stop. The saved
choice belongs to the selected Mac. Open **Data sources and privacy** for the
bundled English disclosure, support contact and full attribution.

### Remember recent places

On compatible versions that offer **Remember recent places** (starting with
Mac 0.4.30 and Even 0.3.53), open **Sharing settings** and turn it on separately
from **Share my location**. This lets Dot
refer to up to seven days of recorded places and movement. Collection needs both
options; old companions keep ordinary location sharing and do not upload history.
Refresh your existing ChatGPT connection's tools after updating the Mac relay.
Dot can use shared history to answer a question or suggest something during an
existing activity. You can ask Dot for fewer suggestions in conversation.

Turning current-location sharing off leaves existing history readable. Turn
**Remember recent places** off to stop collection and historical access, or choose
**Delete history** to erase the local history too. A failed control must be retried
when the Mac is reachable. See [retention and deletion](privacy.md#recent-places).

### Looking back with Dot

With Mac 0.5.0 and an Even companion that includes **Sharing settings → History**,
open that panel on the phone. Choose what the paired Mac can
save for your existing Dot and how long it can keep new records. The default
period is seven days. You can also choose one month, six months or one year.
Changing the period leaves each existing record’s original expiry in place.
Reopening the app or reconnecting restores the selected Mac’s choices.

| Source | What Dot can look back on |
| --- | --- |
| Phone locations and nearby places | Shared phone fixes, accuracy, available motion and phone time, and nearby map references. Recording requires current-location sharing. |
| Polar health observations | Shared sleep, activity, synced heart rate, recovery and exercise observations. The latest registered profile stays under **Health context**. |
| Weather forecasts and their revisions | Forecasts already obtained for a shared location or a place you asked about, including which forecast was available at the time. |
| Planned walks and model terrain | Requested routes, their endpoints, steps, geometry and available terrain estimates. A saved plan does not establish where you walked. |

Turn a history source off to stop recording and block Dot’s access to that
archive. Previously saved records continue to expire. **Delete** also erases that
source’s saved history on this Mac. Deleting Polar history clears both the
seven-day observations and extended history while keeping the latest profile.
With **Health context** still on, your Mac can collect new seven-day observations.
Stopping ordinary health sharing also stops extended Polar recording. Authorizing
a different Polar connection or using an older app that rewrites its health vault
requires a new choice before that archive can record again.
Existing seven-day location and health sharing keep their original scope until
you choose a source in **History**. Weather and walking history each need their
own opt-in in addition to permission to obtain the live evidence.

In your normal conversation, you might ask “How did my activity compare on those
two afternoons?” or “What rain was forecast for Saturday when we planned the
walk on Thursday?” Dot selects relevant fields from available local records.
Reading history makes no new provider request. [Storage, access and deletion](privacy.md#history-settings).

## Updates

Use **Check for updates** in the Mac app. Automatic updates are currently paused. No GitHub account or token is required. Starting a manual update interrupts the active conversation while the Mac app restarts. After you choose **Update**, Dot Link first refreshes the running app and continues the approved update automatically; you do not need to quit, reopen it, or approve the same update again. A progress window shows download, verification, preparation and installation; after restart it shows connection recovery, then automatically opens Dot Link and closes the progress window. A paused connection stays paused. Percentages are shown only when progress is measured. Closing the progress window does not cancel the update. If the app says **Finish the current settings operation, then click Retry update**, finish that operation and choose **Retry update**.

Updates preserve connection settings, pairing and history. After recovery succeeds, obsolete app backups are automatically removed, keeping one verified rollback generation; older accumulated backups are also cleaned up. No manual storage cleanup or extra setting is required. You do not need to recreate your tunnel or pairing. Update the Even companion through Even Hub separately. The command-line installer stops if an app already exists in `~/Applications`; it is for installation, not replacement.

When an update changes Dot's tools, open **ChatGPT Settings → Plugins → your Dot Link connection → Update tools**. If your existing Dot still uses the previous tools, finish any active work and choose **Restart** from that Dot's action menu. In the conversation-ordering update, updating the registered tools alone did not refresh an already-running Dot; restarting it made the new question-reference inputs available. If the new tool is still unavailable after these steps, ask the same Dot to rediscover the tools on its Dot Link connection; this was also needed when adding walking and terrain information. Keep the existing Dot and connection. This step concerns tool-definition changes, not every app update.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Start relay fails | Follow the failed step and guidance shown in the Mac app. For Tailscale errors, check that Tailscale is connected and review MagicDNS, HTTPS Certificates and Serve access in the Tailscale admin console. An existing Serve/Funnel configuration is not replaced automatically. If it still fails, choose **Copy diagnostics** and include that text in your issue. |
| A previous setup or update is unfinished | Choose **Retry recovery**. Dot Link completes the interrupted change using the installed app and keeps your connection settings, keys, pairing and history. Do not delete recovery files or uninstall. If the app reports that it cannot verify itself, replace only the app with an official download, keeping Application Support data, then reopen it. |
| The app asks you to check its location | Quit Dot Link and follow the replacement guidance for `~/Applications/Dot Link.app`. This location requires a regular Applications folder and a full app copy; replace a link at either path rather than replacing files at its destination. Keep Application Support data and update records. Open the installed app afterward; you do not need to recreate your tunnel, keys or pairing. |
| Mac cannot reach Dot | Confirm tunnel ID, API-key permissions and the connection selected in your existing Dot. Send the Mac app's setup message and choose **Check connection to Dot**. |
| Phone offline | Check the phone’s internet connection. Dot Link retries automatically. |
| Mac connection error | The paired address responded, but the connection could not be completed. Check Dot Link on the Mac. |
| Mac unreachable | Check Tailscale on the phone and that the Mac is awake, connected to Tailscale and running Dot Link. The app cannot distinguish a missing phone VPN from an unreachable Mac. It reconnects automatically; keep the existing pairing. |
| Even cannot pair | Keep the Mac awake, resume Dot Link, and connect Mac and iPhone to the same Tailscale network. Generate a fresh code and paste it in full within two minutes. |
| Notifications stop after an update | If the Mac already has Accessibility access and notification sharing is on, choose **Update tools** for the existing ChatGPT connection and restart the same Dot. For the first update from a release before 0.5.4, remove Dot Link from macOS Accessibility, add the installed app again, and enable access. Later updates keep that access. |
| Speech service rejects a recording | Check the selected service, key, account access and billing; for Microsoft also check the endpoint. Saving a key alone does not verify it. |
| Mac 0.3.0 or 0.3.1 waits for Even to close before Dot was ever connected | Quit Dot Link and replace only the app in `~/Applications` with the latest ZIP. Keep Application Support data; do not uninstall. |

Use **Connection details** in the Even companion to inspect connection status. For unresolved problems, [open an issue](https://github.com/YusukeIt0/dot-link/issues) with the versions, symptoms and steps to reproduce. Exclude credentials, pairing codes, private conversations and unreviewed diagnostic files.

**Copy diagnostics** appears after a Start relay setup failure. The failure guidance and copy button remain available after refreshing the status or returning from Advanced settings. They clear when you start another setup operation, including retrying Start relay. It copies only the failed step, a known error code, available command exit/signal information, and the Mac app version/build. It does not copy keys, hostnames, paths, command output or conversations. The last activation failure is also saved locally in `~/Library/Application Support/Dot Link/.runtime/setup-failure.json` when the installation has been located and that folder is writable; it includes the failure time. Dot Link removes it after activation completes without an error when file permissions allow. This is separate from connection-status checks and is not uploaded automatically. A failed step can have made partial progress, so check the current status before retrying.

Mac 0.4.7 may show only `SETUP_FAILED` and does not provide this diagnostic record. That code alone does not identify Tailscale, API-key permissions or any other specific cause. Avoid deleting settings or repeatedly reinstalling based on that code alone.

## Pause, quit and uninstall

Closing the Mac window keeps Dot Link running. **Pause** stops the relay and notification collection; **Quit** stops the app and its services. Reopen the app to resume with saved settings. Stopping services does not delete history.

From Mac 0.4.38, if the running app is moved or removed, Quit may be unable to start its stop
helper. Dot Link stays open and shows the original app location. Restore the
complete app there, keeping your saved settings, then choose **Retry Quit**.
Sharing is not confirmed stopped until Quit succeeds. If the helper never
started, notification forwarding returns to its previous state. If a stop began
but could not be confirmed, notification forwarding stays paused while other
sharing may still be running. Force-quitting the window does not confirm that
the background services stopped.

**Uninstall Dot Link…** moves the app, runtime, speech model, connection settings and conversation history to Trash and removes speech-service keys from Keychain. There is no option to retain settings; setup is required to use the app again. See [data handling](privacy.md#disconnecting-and-deleting) for removal limits and external-service data.

### Application language

See the README for [supported interface languages](../README.md#make-it-yours).
Each app initially follows its device language, with English as the fallback,
and lets you select another supported language. The choice does not translate
conversations or change pairing, notification sharing, speech-service
configuration, or the wake phrase.

## Optional weather context

Open **Sharing settings → Weather context** on the companion for your selected Mac.
Read the disclosure and the MET Norway service terms. With Even 0.4.1 and Mac
0.5.0, turning Weather on shares both forecasts and satellite estimates of recent
rainfall nearby. Weather starts off.

If you were already sharing forecasts only, forecasts continue. The first time
you use the updated companion in the foreground and it can confirm that setting
with your paired Mac, choose **Use nearby rain estimates** or **Keep forecasts
only** in the prompt. If you keep forecasts only or leave the prompt, you can add
nearby rain later in **Sharing settings → Weather context**. Choose **Forecasts
and nearby rain** and confirm. Your forecasts stay on while you make this change.
If you already share both, or have Weather off, the companion keeps your setting.
Earlier versions that support forecasts continue to work with their existing
Weather settings.

Your Mac sends rounded coordinates to MET Norway. It downloads a global NOAA
file from Amazon S3 and estimates nearby rain locally. Both services see the
Mac's outgoing IP address. Current-location weather needs fresh phone location
sharing. You can also ask about a particular place. Ordinary weather requests
work with the existing Dot. A cold satellite lookup can finish after the forecast
arrives. The Mac reuses the downloaded file for other places. If the Weather
tool itself is missing from an older ChatGPT connection, see the connector
setup instructions for refreshing that connection.

Turning Weather off stops live weather after the Mac acknowledges the change.
Turning location sharing off stops current-location weather. **Sharing settings
→ History** controls saved weather separately, including retention and deletion.
If you previously enabled weather history, adding NOAA allows newly acquired
nearby summaries to be saved for the selected period. [Weather sources and privacy](../public/weather-sources.html).

## Polar health context

1. Open **Healthcare settings** in the Mac app, then **Open Polar registration**.
   Register an AccessLink client with redirect address
   `http://localhost:3464/polar/callback`.
2. Enter its **Client ID** and **Client Secret**, choose **Connect Polar**, and complete
   Polar login and consent in the browser. The callback stays on this Mac.
3. In the Even companion, open **Sharing settings → Health context** to enable sharing.
   The same Dot can use relevant health context with your conversation and other
   permitted information; there is no separate health agent or notification switch.
   Tool descriptions and health results include guidance for interpreting possible
   fatigue, tension and energy and adapting conversation or suggestions. No setup
   chat is required to teach this guidance. These are tentative interpretations,
   not measured state labels or guaranteed detection.

Keep Polar Flow synchronized. Acquisition runs about every 30 minutes while sharing
is on; missing categories can be normal. Profile values are registered information,
not measurements made by Loop. **Fetch profile again** updates height, weight and
date of birth after a successful Polar read. Sharing OFF also blocks profile refresh.

**Delete health data** stops sharing and removes the local profile and measurements.
Earlier measurements will not return if you enable sharing again. The profile can
be fetched again explicitly. Offline changes are not shown as completed: reconnect
to the Mac and retry. Local deletion does not erase context already delivered to Dot.

Use **Reconnect Polar** after authorization expires or is revoked. Saved application
credentials are reused. **Disconnect Polar** removes local health data and deregisters
the connection at Polar. A pending disconnect needs retrying or revocation in your
Polar account; local reset alone cannot confirm remote revocation. Encrypted data
cannot be recovered without its Keychain key. See [data handling](privacy.md#optional-polar-health-context).
