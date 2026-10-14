# Third-party software

Dot Link's own source is MIT-licensed. Dependencies retain their own licenses and copyright notices.

| Component | Pinned version | License / notices |
|---|---|---|
| Node.js | 22.23.3 | Upstream Node license and bundled dependency notices |
| whisper.cpp | 1.9.5 | MIT |
| OpenAI tunnel-client | 0.0.16 | Apache-2.0, upstream NOTICE and bundled dependency notices |
| Sparkle | 2.10.0 | Upstream Sparkle license |
| Even Hub SDK | 0.0.16 | MIT |
| ipaddr.js | 2.5.0 | MIT |
| zod | 4.6.5 | MIT |
| standardwebhooks | 1.1.1 | See the qualification below |
| sherpa-onnx / Zipformer keyword model | 1.13.8 / 2024-01-01 | Apache-2.0; [wake runtime details](wake-word.md) |
| Silero VAD | SHA-256 pinned in wake manifest | MIT |
| Wake WASM: ONNX Runtime / Emscripten | 1.28.2 / 4.0.23 | Bundled third-party notices in `wake-assets/THIRD-PARTY-NOTICES.txt` |
| qrcode and transitive npm dependencies | package-lock.json | Individual package license files |

The Mac bundle includes license texts in `Contents/Resources/licenses` and within the unmodified npm packages in its payload. Frontend license texts are also in `public/THIRD_PARTY_NOTICES.txt`. The Mac transcription model and Tailscale app are not bundled. The Even wake-detection models are bundled.

`standardwebhooks`' npm metadata declares MIT but its package omits a license file, while its upstream repository has an Apache-2.0 license. We include that upstream license and preserve a separate Deno MIT notice for its timing-safe comparison implementation. The implementation is unmodified. See `distribution/licenses/` for the original texts and provenance.

No OcuClaw/OpenClaw source or artwork is included. Dot Link is not affiliated with OpenAI, Even Realities, or Tailscale.
