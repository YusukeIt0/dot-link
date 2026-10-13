<p align="center">
  <img src="assets/brand/orbit/mac-1024.png" alt="Dot Link" width="96" height="96">
</p>

<h1 align="center">Dot Link</h1>

<p align="center"><strong>Your Dot, now on Even G2.</strong></p>
<p align="center"><strong>English</strong> · <a href="README.ja.md">日本語</a></p>
<p align="center">
  <a href="https://github.com/YusukeIt0/dot-link/releases/latest">Download for Mac</a> ·
  <a href="https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink">Get it on Even Hub</a> ·
  <a href="docs/setup.md#english">Setup guide</a>
</p>

Dot Link connects your existing ChatGPT Dot with Even G2. Speak through your glasses or type on your phone, then read the reply on G2 or listen to it aloud.

<p align="center">
  <img src="assets/readme/conversation-en.png" alt="Sample conversation displayed in the Even G2 simulator" width="576">
</p>
<p align="center"><sub>Sample conversation in the simulator. It does not fully reproduce the status indicators shown on the physical glasses.</sub></p>

## What you can do

| | With Dot Link |
| --- | --- |
| **Talk or type** | Speak through G2 or enter text on your phone. |
| **Read or listen** | Read replies on G2 or turn on read-aloud. |
| **Stay in touch** | Receive proactive messages from your Dot. |
| **Make it comfortable** | Browse conversation history and adjust display timeout, wake gestures and the head-raise angle. |
| **Share context** | Optionally share readable Mac notifications with Dot. Dot decides what to announce and when. |

Notification sharing is off until you enable it. Support depends on what macOS makes readable; replying in the source app is not supported.

> **Coming to Even Hub:** Optional phone location sharing is implemented, but the compatible Even build is awaiting public release. It starts off and requires Mac 0.4.0+ and Even 0.2.23+. See [location sharing](docs/dot-setup.md#optional-location-sharing-development-builds).

## What you need

- **Even G2** and an **iPhone** with the Even app.
- An **Apple Silicon Mac with macOS 13 or later**.
- **Tailscale** on the Mac and iPhone to connect the devices.
- **Your existing ChatGPT Dot** and access to the required tunnel/plugin features. Check the [Dot connection requirements](docs/dot-setup.md) before installing.

Your Mac must stay awake and online while you use Dot Link. A dedicated Mac mini is not required.

## Get started

Install the latest Mac release with **one Terminal command (recommended)**. See the [installation guide](docs/mac-install.md), or choose [manual ZIP installation](docs/mac-install-finder.md).

1. **Set up your Mac.** Follow the [installation guide](docs/mac-install.md), then choose **Prepare this Mac** in Dot Link.
2. **Install on Even.** Open [Dot Link in Even Hub](https://hub.evenrealities.com/landing?package_id=app.tripsurf.dotlink) from the Even app.
3. **Connect them.** Choose **Connect Even** in the Mac app, then paste the generated code into the Even companion.

The [setup guide](docs/setup.md#english) covers speech, permissions, updates and daily use. The Mac app is not Apple-notarized, so first launch may require confirmation in macOS. Automatic updates are temporarily paused; use **Check for updates** in the app.

## Guides

| Looking for… | Start here |
| --- | --- |
| Installation and everyday use | [Setup](docs/setup.md#english) |
| Connecting your existing Dot | [Dot setup](docs/dot-setup.md) |
| What is sent and stored | [Data handling](docs/privacy.md#english) |
| Building and testing | [Development](docs/development.md) |

Your own Mac relays the conversation. The developer does not operate a shared conversation server. Recovery from sleep, connection loss and extended use remain under testing.

## Contributing

[Issues](https://github.com/YusukeIt0/dot-link/issues) and pull requests are welcome. **dotsweeper** provides an initial review; authors and maintainers can request another with `/dotlink review`. Reviews are advisory. See [Contributing](CONTRIBUTING.md) and [review details](docs/ai-review.md).

## License

[MIT](LICENSE). Dependencies retain their [own licenses](docs/dependencies.md). Dot Link is an independent project, not an official product of OpenAI, Even Realities or Tailscale.
