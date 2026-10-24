# Post-transcription wake cue rules

`src/wake-transcript-rules.ts` registers evidence-backed default-Dot text
patterns. This is defensive cleanup after speech recognition, independent of
the display language. It does not change the acoustic model, wake keywords,
detector thresholds, audio cut, speech provider, or per-utterance captured name.
English and Japanese retain their existing matching behavior. Custom names
retain literal ASCII matching; do not generate phonetic aliases from UI text.

A new script needs an actual ASR transcript, a bounded leading-cue pattern,
and negative fixtures for ordinary words and ambiguous output. Remove at most
one leading cue. Never replace occurrences inside the user's message. A locale
registration alone does not enable a new rule. Rules must not use stateful
`g` or `y` regular expressions.

## Korean evidence

On 2026-10-24, synthetic macOS 26.2 Yuna (`ko_KR`) speech was converted to
16 kHz mono PCM and transcribed with the bundled whisper.cpp CLI, the small
model, automatic language selection and CPU execution (`-ng -l auto -nt -np`).
This establishes a reproducible ASR text example, not physical microphone,
wake detection, native-speaker translation, or G2 acceptance evidence.

| Synthetic input | Actual ASR output | Rule decision |
| --- | --- | --- |
| `Hey dot. 오늘 날씨를 알려 줘.` | `헤이 닷 오늘 날씨를 알려줘` | Remove the leading `헤이 닷` only. |
| `Hey dot.` | `へいだっ` | Preserve ambiguous output. |
| `Hey dot, 지금 몇 시야?` | `헤이다 지금 몇 시야?` | Preserve ambiguous output. |
| `헤이 닷컴 사이트를 열어 줘.` | `Hey.com 사이트를 열어줘` | Preserve ordinary/ambiguous words. |

The Korean pattern requires a separator between `헤이` and `닷` and a
separator or end after `닷`. It preserves `닷컴`, `닷새`, joined `헤이닷`,
and a standalone `닷`. Punctuation and cue-only tests are explicit boundary
fixtures, not claims that these additional forms were observed by ASR.

Evidence fingerprints (SHA-256):

- Model: `1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b`
- CLI: `f924f040d2f782dcbc5346a425dc58cfab176003b6ade90540197675952e6a00`
- First input WAV: `22368ec2f9b052001ee68ddd72df15db33732bcb21f74f921c8a92edbd8046dd`

Run `node --test tests/wake-transcript.test.ts tests/wake-engine.test.ts
tests/wake-name.test.ts` for language-independent cleanup and preserved legacy
and custom-name behavior. Acoustic and physical checks remain separate.
