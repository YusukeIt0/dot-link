# Even Hub listing screenshots

Captured 2026-10-09 from the actual Even 0.2.14 `dist` app, using the official `@evenrealities/evenhub-simulator` 0.9.5 and `scripts/listing-preview.mjs`.

- `conversation-ja.png`: Japanese, SHA-256 `c12a0395a2e757e1453d316a408a3b58aeeeb28760612bdb3b91198ecbde23a8`.
- `conversation-en.png`: English, SHA-256 `70a8cb81996a529e968e68f627069133f4baa3f051192cf640ea56aa166fe988`.
- Both are the simulator's original 576 × 288 RGBA PNG exports, without retouching. Transparent pixels carry green RGB values; preview over a dark background with alpha respected.
- Conversation content, the `My Mac` name and the fixture token are synthetic. No actual Dot, relay, account or microphone is used. These are layout examples, not physical-device or network-compatibility evidence.
- The fixture serves only on `127.0.0.1:5197`, replaces API responses with static example data and uses isolated preview-origin web storage. It does not enter the production bundle. Use languages sequentially, because the fixture has one active language.
- The app's existing display settings disable idle blanking and head-raise in the fixture; production defaults are unchanged.
- Both images were visually checked over black. The Even Hub draft uses its built-in Interior / Cafe background and was visually checked before saving.

Reproduction: build the candidate, run `node scripts/listing-preview.mjs`, then launch the official simulator with `http://127.0.0.1:5197/?lang=ja` (or `en`) and `--automation-port 9898 --no-glow`. Its documented `GET /api/screenshot/glasses` exports the PNG. Stop the simulator and fixture after capture. Do not use production pairing data in this preview.

References: [official simulator package](https://www.npmjs.com/package/@evenrealities/evenhub-simulator), [test modes](https://hub.evenrealities.com/docs/test).
