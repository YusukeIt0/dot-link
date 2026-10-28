# Optional voice activation

Enable **Talk with Hey XX** in Operation settings, between Location sharing and Display settings. It starts off. Say **Hey dot** (including the Japanese pronunciation ヘイ、ドット), wait for **Go ahead** on G2, then speak. The activation cue is independent of the interface language. A short silence ends the utterance; the existing automatic-send choice still applies. Say the cue again for each new utterance. Hold-to-talk remains available.

To choose another name, enable **Change the name** below the wake switch, enter 1–24 ASCII letters after the fixed **Hey**, and save. Even, Siri and Meta are reserved (case-insensitive). The custom cue replaces Hey dot and uses English pronunciation; recognition depends on the name and speaker. Turning the custom-name option off restores Hey dot. The selected name also appears in conversation speaker labels and reply status; it does not rename your ChatGPT account or Dot Link. Name changes persist separately from the listening switch and never turn listening on. On restore, a valid Even-native record takes precedence over browser storage; an invalid native record restores Dot defaults, while a missing native record keeps the browser choice. A choice saved in the current session wins over a pending restore. A change applies without restarting; an ongoing utterance finishes with its original name before the detector switches.


Detection runs locally in the phone's Even WebView worker while Dot Link is active on G2, including app-level display blanking. It does not launch an exited app. iOS suspension, Even background audio delivery, recognition in noise, false activations and battery impact require physical validation; a connected SDK alone is not proof. If audio stops for five seconds, the listener closes and asks for OFF/ON retry instead of accumulating audio.

## Audio path

G2 16 kHz mono PCM → phone-local keyword spotter → post-cue capture → existing Mac transcription endpoint → existing Dot conversation. No wake-detection service, account or API key is introduced. Existing STT provider and read-aloud settings remain in control. Wake detection pauses during transcription, sending, an unsubmitted draft, read-aloud playback and a 600 ms playback cooldown. It also stops on explicit app exit, unpairing and OFF. A transient update-poll failure pauses new wake input while allowing an active manual or wake utterance to finish; its transcription still uses the existing error handling. An independent timer checks read-aloud completion through long or queued speech. A missing completion callback is recovered when the synthesizer reports neither speech nor pending output after a short grace period, followed by the same playback cooldown. Recovery does not depend on relay updates or user interaction.

The spotter keeps a two-second PCM ring to recover following speech received during decoder latency. The final keyword token timestamp plus 200 ms estimates cue completion; VAD then ends capture after 1.2 seconds of silence. Six seconds without detected speech cancels; capture never exceeds 30 seconds. If a conversation is already displayed, wake capture and transcription update only the status header, leaving the conversation container in place. No-speech or cue-only cancellation returns the header to idle without rewriting that body, so native scrolling is not reset by a replacement prompt. With no conversation displayed, the idle voice prompt remains the fallback. A held utterance uses manual release instead of silence. There is no wake-listening audio file or network request. The Mac checks the completed recording for speech before any STT provider is called, including manual recordings and wake recordings taken over by a long press. This shared presence check does not change wake endpoint timing. The selected STT sees the trimmed utterance only after it passes; defensive text cleanup removes a leading full activation cue and suppresses cue-only output before Dot submission. This is not speaker authentication: another nearby voice or media can activate it.

## Packaged dependencies

- sherpa-onnx **1.13.8**, source commit `11afbd009a7f8c08f4bcf2fc1b265d0df4670fbf`.
- Int8 Zipformer GigaSpeech 3.3M English keyword model, release `2024-01-01`; default tokens `▁HE Y ▁DO T` (replaced by the saved custom cue), score 3, threshold 0.1.
- Silero VAD model; pinned SHA-256 in `distribution/wake/manifest.json`.
- Emscripten **4.0.23**, ONNX Runtime SIMD **1.28.2** as hash-pinned by the sherpa source.

The compiled runtime exports only keyword spotting and VAD APIs. A small source patch preserves absolute keyword token timestamps when sherpa resets its decoder after silence; without it, the reported timestamp can point at older audio after a wait. Out-of-window timestamps never substitute the whole audio ring. Its WebAssembly heap starts at 64 MiB and has a 256 MiB ceiling; these are heap settings, not measured phone memory or battery consumption. JavaScript, models and WebView memory add overhead. WebAssembly SIMD is required. Failure leaves hold-to-talk available.

`npm run build`, `npm test` and `npm run dev` prepare the assets. Model archives download at build time from official GitHub releases, are checked by size/SHA-256, and are extracted to ignored `public/wake-assets/`. End-user detection loads only packaged assets. `package:beta` verifies their complete filename set and hashes before allowing model/WASM files through its release scanner. The runtime gzip is checked in so normal builds do not need a compiler toolchain.

To rebuild the runtime, install CMake, Git and a C/C++ build tool, then run `node scripts/build-wake-runtime.mjs`. This installs the pinned Emscripten toolchain only under `.runtime/`, applies `distribution/wake/runtime.patch`, strips local source paths, rebuilds the binary/wrappers and updates integrity hashes. Review regenerated files and licenses before committing. Different host/build paths can change binary hashes; the manifest identifies the accepted build, not a claim of byte-identical cross-platform reproducibility. The complete third-party notices are kept compressed in the repository to bound review size and unpacked unchanged for distribution. They are packaged as `wake-assets/THIRD-PARTY-NOTICES.txt`.

## Speaker-role support

Wake activation uses the Even SDK's per-frame speaker role as a supporting signal.
A cue is suppressed before readiness or capture only when its entire observed interval
(from the first token onset through the existing 200 ms post-token margin) is labelled
`other`. Any `self`, unknown or missing role allows the existing detector result.
Invalid, future or expired cue intervals also retain existing behavior. This conservative
rule avoids choosing an unmeasured majority/confidence threshold; it may allow false
activations when labels are mixed.

Roles stay aligned with the unchanged PCM timeline in a bounded two-second phone-local
buffer and are cleared on cancellation/restart and capture. Suppression keeps listening.
Manual hold-to-talk and post-cue audio ignore roles. No voiceprint enrollment, additional
permission, service, persistent role log or speaker authentication is introduced.
SDK 0.0.16 documents this as an Even App algorithm result; older hosts may report unknown.
Real-device role coverage, false activations and missed owner activations remain unverified.
Before release, check owner speech, nearby speech/media and noise in one bounded session,
including supported lock/background/display-standby behavior and manual fallback.
Record app/device/build versions and false activations separately from missed activations.

## Validation and physical checklist

Automated tests cover cue trimming, no-speech cancellation, silence/manual endpoints, 30-second bounds, microphone ownership, OFF/loading races, stale results, disconnection, close retries, preserved manual input and preference restore races. A runtime test initializes the actual WASM and both models with local files and processes/cancels silent sessions without network access. A second regression uses the upstream model archive's own test sample to verify a 30-second timestamp shift after silence. It fails with the unpatched runtime and passes with the patched runtime. The fixture comes from the same hash-pinned model archive; a missing build cache requires downloading that archive again.

Local synthetic English/Japanese samples activated on cue plus command and cue alone. Both immediate input and input after 30 seconds of silence were checked. Cue alone produced no clip; two short ordinary-speech samples produced no activation. This is a narrow smoke test, not an accuracy estimate or real-device proof. It does not establish recognition for all voices, accents or environments.

Before merge, install the PR commit through the owner's Even Beta route and record the package version/commit with results:

1. OFF retains normal long-press input. ON persists and places the setting in the requested location.
2. English and Japanese-pronounced cue alone show Go ahead, then return to listening without contacting Dot.
3. Cue → HUD → short and long utterance → silence sends only the intended text, through the selected STT; unchecked automatic send leaves a review draft.
4. Each subsequent turn requires a new cue. Discard, long-press takeover and read-aloud ON/OFF work; a spoken reply containing the cue does not activate recording.
5. Repeat while G2 content is blanked, while the phone is locked and while Even is backgrounded. Record actual behavior rather than inferring it from connection status.
6. Interrupt the relay during manual and wake capture, then turn OFF, unpair/reconnect and exit/reopen. Verify microphone closure, clear failure status and manual fallback. Unpairing during transcription must clear the processing display and allow standby to blank again.
7. Exercise sustained quiet/noisy listening and measure phone/G2 battery and responsiveness before describing the feature as ready for everyday use.

This work changes the Even frontend only; it does not require replacing the Mac app or changing its speech settings.

## Custom-name implementation and checks

`distribution/wake/name-vocabulary.json` contains the ASCII pieces and scores exported from the pinned keyword model. Although its upstream filename is `bpe.model`, its SentencePiece trainer type is UNIGRAM. `scripts/export-wake-vocabulary.mjs <model-archive>` verifies the archive hash and exports the vocabulary; the client computes maximum-score segmentation for `HEY <NAME>`. The fixture in `tests/fixtures/wake-name-segmentation.json` was cross-checked against the upstream SentencePiece model. Each worker initializes one selected keyword; the `HEY_DOT` event tag is internal and does not retain a second activation phrase.

Before merging a custom-name change, check a chosen name on G2, the default cue after reverting, labels and waiting status, restart persistence, invalid/reserved names, OFF behavior, and name changes during manual/wake speech. Silent-WASM and lifecycle tests do not establish acoustic accuracy, false-trigger rate or battery impact.
