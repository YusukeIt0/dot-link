<p align="center">
  <img src="assets/brand/orbit/mac-1024.png" alt="Dot Link" width="96" height="96">
</p>

<h1 align="center">Dot Link</h1>
<p align="center"><strong>Your Dot, now on Even G2.</strong></p>
<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink">Even Hub</a> ·
  <a href="docs/setup.md">User guide</a>
</p>

Talk to your existing ChatGPT Dot through Even G2, or type on your phone. Read replies on your glasses, listen aloud, and receive messages from Dot. Your own Mac connects the devices; there is no developer-operated conversation server.

<p align="center">
  <img src="assets/readme/conversation-en.png" alt="Sample conversation in the Even G2 simulator" width="576">
  <br><sub>Simulator example; status indicators may differ on physical glasses.</sub>
</p>

## Requirements

- **Apple Silicon Mac**, macOS 13 or later, kept awake and online during use.
- **Even G2 and an iPhone** with the Even Realities app.
- **Your existing ChatGPT Dot**, with access to OpenAI tunnels and custom MCP connections. Installing Dot Link does not grant this account access.
- **Tailscale** on both Mac and iPhone, signed in to the same account.

## Quickstart

### 1. Install on your Mac

```sh
curl -fsS https://raw.githubusercontent.com/YusukeIt0/dot-link/main/install.sh | /bin/bash
```

Installs the latest stable release in `~/Applications` and opens it. Choose **Prepare this Mac** and follow the app's Tailscale setup. The first run downloads about 490 MB for local speech recognition.

The app is not Apple-notarized: if macOS blocks the first launch, see [Open Anyway](docs/setup.md#first-launch). Prefer a ZIP? See [manual installation](docs/setup.md#manual-installation).

### 2. Connect your Dot

1. In the Mac app, follow **Connect your existing Dot**: create a tunnel, enter its **Tunnel ID** and **API key**, then start the relay.
2. In ChatGPT **Plugins → Add custom MCP server**, choose **Tunnel** and add the connection to your existing Dot.
3. Send the message from **Copy setup message for Dot**, then choose **Check connection to Dot** on the Mac. [Connection details](docs/setup.md#dot-connection).

### 3. Pair Even

1. On your iPhone, install **Tailscale** and connect using the same account as your Mac.
2. Install and open [Dot Link in Even Hub](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink).
3. On the Mac, choose **Connect Even → Create pairing code**. Paste the entire code into the Even companion and connect within two minutes. Each code works once.

### 4. Start a conversation

Hold to speak on G2 and release to stop recording, or type and send a message in the Even companion. Check that your Dot's reply appears on G2. Keep the Mac awake and both devices connected to Tailscale.

## Make it yours

- **Conversation:** browse history, enable read-aloud, and adjust display timeout, wake gestures and the head-raise angle.
- **Speech input:** use free local Whisper or your own speech-service API key. [Speech settings](docs/setup.md#speech).
- **Context:** optionally share [Mac notifications](docs/setup.md#mac-notifications) or your [phone location](docs/setup.md#location-sharing). Both start off; Dot decides what to announce.

## Help and updates

Use **Check for updates** in the Mac app; automatic updates are currently paused. Updates preserve settings and pairing. See the [user guide](docs/setup.md) for manual installation, updates and troubleshooting, and [data handling](docs/privacy.md) for what is sent, stored and deleted.

Recovery after sleep, network loss and extended use is still being validated. Report problems in [Issues](https://github.com/YusukeIt0/dot-link/issues), without credentials or private conversations.

## Contributing

Bug reports, ideas and pull requests are welcome. Start with [Contributing](CONTRIBUTING.md) or [building and testing](docs/development.md). [Even release notes](docs/even-release-notes.md) · [Mac releases](https://github.com/YusukeIt0/dot-link/releases).

## License

[MIT](LICENSE). Dependencies retain their [own licenses](docs/dependencies.md). Dot Link is independent of OpenAI, Even Realities and Tailscale.
