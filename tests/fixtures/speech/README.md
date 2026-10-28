# Synthetic speech-presence fixtures

These 16 kHz mono PCM WAVs were synthesized with macOS `say` and converted
with `afconvert -f WAVE -d LEI16@16000 -c 1`, then rewritten with a canonical
44-byte WAV header. `manifest.json` records the voice, language, text and
short/sentence category. Each of the seven languages has two voices and two phrases per voice (28 recordings). They contain no microphone recordings or private data.

The same detector settings apply to every language. Tests also attenuate every
sample to 10% and 1% amplitude without changing its words. These fixtures test
speech preservation, not transcription accuracy, translation quality, speaker
identity, accents, or real G2 acoustic performance. They are a bounded regression
corpus, not evidence of universal speech-detection accuracy.
