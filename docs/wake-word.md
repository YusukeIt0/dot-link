# Optional Hey dot input

Enable **Talk with Hey dot** in Operation settings, between Location sharing and Display settings. It starts off. Say **Hey dot** (including the Japanese pronunciation ヘイ、ドット), wait for **Go ahead** on G2, then speak. The activation cue is independent of the interface language. A short silence ends the utterance; the existing automatic-send choice still applies. Say the cue again for each new utterance. Hold-to-talk remains available.

Detection runs locally in the phone's Even WebView worker while Dot Link is active on G2, including app-level display blanking. It does not launch an exited app. iOS suspension, Even background audio delivery, recognition in noise, false activations and battery impact require physical validation; a connected SDK alone is not proof. If audio stops for five seconds, the listener closes and asks for OFF/ON retry instead of accumulating audio.

## Audio path

G2 16 kHz mono PCM → phone-local keyword spotter → post-cue capture → existing Mac transcription endpoint → existing Dot conversation. No wake-detection service, account or API key is introduced. Existing STT provider and read-aloud settings remain in control. Wake detection pauses during transcription, sending, an unsubmitted draft, read-aloud playback and a 600 ms playback cooldown. It also stops on explicit app exit, disconnection and OFF.

The spotter keeps a two-second PCM ring to recover following speech received during decoder latency. The final keyword token timestamp plus 200 ms estimates cue completion; VAD then ends capture after 1.2 seconds of silence. Six seconds without detected speech cancels; capture never exceeds 30 seconds. A held utterance uses manual release instead of silence. There is no wake-listening audio file or network request. The selected STT sees the trimmed utterance; defensive text cleanup removes a leading full activation cue and suppresses cue-only output before Dot submission. This is not speaker authentication: another nearby voice or media can activate it.

## Packaged dependencies

- sherpa-onnx **1.13.8**, source commit `11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf`.
- Int8 Zipformer GigaSpeech 3.3M English keyword model, release `2024-01-01`; fixed tokens `▁HE Y ▁DO T`, score 3, threshold 0.1.
- Silero VAD model; pinned SHA-256 in `distribution/wake/manifest.json`.
- Emscripten **4.0.23**, ONNX Runtime SIMD **1.28.2** as hash-pinned by the sherpa source.

The compiled runtime exports only keyword spotting and VAD APIs. Its WebAssembly heap starts at 64 MiB and has a 256 MiB ceiling; these are heap settings, not measured phone memory or battery consumption. JavaScript, models and WebView memory add overhead. WebAssembly SIMD is required. Failure leaves hold-to-talk available.

`npm run build`, `npm test` and `npm run dev` prepare the assets. Model archives download at build time from official GitHub releases, are checked by size/SHA-256, and are extracted to ignored `public/wake-assets/`. End-user detection loads only packaged assets. `package:beta` verifies their complete filename set and hashes before allowing model/WASM files through its release scanner. The runtime gzip is checked in so normal builds do not need a compiler toolchain.

To rebuild the runtime, install CMake, Git and a C/C++ build tool, then run `node scripts/build-wake-runtime.mjs`. This installs the pinned Emscripten toolchain only under `.runtime/`, applies `distribution/wake/runtime.patch`, strips local source paths, rebuilds the binary/wrappers and updates integrity hashes. Review regenerated files and licenses before committing. Different host/build paths can change binary hashes; the manifest identifies the accepted build, not a claim of byte-identical cross-platform reproducibility. The complete third-party notices are kept compressed in the repository to bound review size and unpacked unchanged for distribution. They are packaged as `wake-assets/THIRD-PARTY-NOTICES.txt`.

## Validation and physical checklist

Automated tests cover cue trimming, no-speech cancellation, silence/manual endpoints, 30-second bounds, microphone ownership, OFF/loading races, stale results, disconnection, close retries, preserved manual input and preference restore races. A runtime test initializes the actual WASM and both models with local files and processes/cancels silent sessions without network access.

Local synthetic English/Japanese samples activated on cue plus command and cue alone. Cue alone produced no clip; two short ordinary-speech samples produced no activation. This is a narrow smoke test, not an accuracy estimate or real-device proof. It does not establish recognition for all voices, accents or environments.

Before merge, install the PR commit through the owner's Even Beta route and record the package version/commit with results:

1. OFF retains normal long-press input. ON persists and places the setting in the requested location.
2. English and Japanese-pronounced cue alone show Go ahead, then return to listening without contacting Dot.
3. Cue → HUD → short and long utterance → silence sends only the intended text, through the selected STT; unchecked automatic send leaves a review draft.
4. Each subsequent turn requires a new cue. Discard, long-press takeover and read-aloud ON/OFF work; a spoken reply containing the cue does not activate recording.
5. Repeat while G2 content is blanked, while the phone is locked and while Even is backgrounded. Record actual behavior rather than inferring it from connection status.
6. Turn OFF, disconnect/reconnect and exit/reopen. Verify microphone closure, clear failure status and manual fallback.
7. Exercise sustained quiet/noisy listening and measure phone/G2 battery and responsiveness before describing the feature as ready for everyday use.

This work changes the Even frontend only; it does not require replacing the Mac app or changing its speech settings.
