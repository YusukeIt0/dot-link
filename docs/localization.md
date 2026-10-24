# Application localization

Application language is separate from conversation contents, speech recognition
and acoustic wake detection. English is the fallback. See the README for
[supported interface languages](../README.md#make-it-yours).

## Resource contract

- `localization/locales.json` registers each language's native name, selector
  order, speech locale, Mac date locale and saved-key date format. Existing Japanese/English selector
  order is retained; new languages follow them.
- `localization/en.json` defines stable message IDs and English source text.
  `ja.json`, `ko.json`, and future locale files use exactly the same IDs.
  Keep IDs stable when correcting wording. Prefix messages with `even.`, `mac.`,
  `setup.` or `common.` according to ownership.
- Use named placeholders such as `{host}`, `{name}` and `{count}`. Pass values
  through the formatter, not string concatenation or recursive replacement.
  Parameter values are literal data. Wording must account for plural forms or
  use a count label that works for all counts; do not append English suffixes
  in runtime code.
- `src/localization-catalogs.ts` is generated import/type glue. Run
  `node scripts/localization.mjs --write` after registering a language, then
  commit the generated result. `scripts/lib/setup-errors.json` is also generated
  from the `setup.codes.*` and `setup.stages.*` resources, preserving its stable
  machine-readable allowlist structure. Never hand-edit generated files.
- `npm test` and build commands check registered catalogs, exact key coverage,
  nonempty text, placeholder parity, HTML references and generated imports.
  TypeScript checks app message IDs; the validator checks native Swift message
  references. Runtime rendering retains English fallback.

Even owns display-language resolution in `src/i18n.ts`, persistence in
`src/language-preferences.ts`, and application state in the existing runtime
controllers. Auto uses the WebView's `navigator.language` and follows its
`languagechange` event; it does not read a separate G2 language setting. Explicit
choices override Auto. Preserve the existing language-prefix matching and
unsupported-language fallback. Preserve the local/native storage keys and
restore/write ordering when extending the supported set.

Static text uses `data-i18n`, and static accessibility labels use
`data-i18n-aria-label`. Dynamic text uses `t(id, parameters)`. App-owned status
labels may be re-rendered with `translateLabel`; never apply that helper to
conversation, notification contents, user input, host names or provider output.
Technical status codes, version numbers, URLs, model/provider names and the
compact STT/TTS ON/OFF indicators remain identifiers, not translation keys.

Read-aloud keeps the existing browser speech path. The registered speech locale
is supplied to both the toggle announcement and reply playback (Korean:
`ko-KR`). The browser/OS chooses an available voice; UI translation does not
install voices or guarantee pronunciation of mixed-language replies. A speech
error keeps the existing visible fallback. User messages and Dot replies are
never translated or rewritten by the UI language setting.

Mac uses `native/DotLinkSetup/Localization.swift` with the same bundled JSON
resources. Its existing `setupLanguage` preference overrides the first macOS
preferred language; unsupported preferences resolve from the device language,
then fall back to English. The language selector keeps its existing explicit
choices (there is no new Auto control). Menus, settings, setup failures and
retained update/status messages refresh when the selection changes. Retained
messages store IDs and parameters instead of inferring IDs from visible text.
Notification diagnostic wire values remain stable; only their UI presentation
and synthetic test-notification wording are localized. OS-provided error text
and external provider/release content keep their source language.

The Mac builder validates and copies the catalogs into `Resources/payload`.
Run `sh scripts/test-setup-native.sh` for native resolution, placeholders,
fallback and safe failure-copying checks, plus
`node scripts/test-mac-update-driver.mjs` for the unchanged update/recovery flow
and language switching. These require macOS; the update driver needs AppKit.

## Adding a language

1. Copy the English catalog to the new language file and translate every entry.
   Preserve placeholders, the meaning of permissions/stopping, product names
   and literal wake names. Review short state labels as well as long help/error
   text. Register native name and locale metadata and regenerate imports. Add the
   language to `app.json` using a language code supported by the Even package
   schema; platform support is separate from catalog registration.
2. Run `npm test`, `npm run test:http`, and `npm run build`. Test locale/region
   detection, explicit selection, unsupported/invalid preferences, restart and
   native restore. Check that message contents, drafts, pairing and other
   settings survive switches and that recording guards still apply.
3. Check static and dynamic text, accessibility, placeholders and units across
   the phone and G2. Test actual glyph rendering, long text/native scrolling,
   text expansion and read-aloud behavior on the intended devices. Width-unit
   tests and a browser preview do not establish physical display correctness.
4. Review relevant setup/privacy/release documents and actual artifact
   permissions. Public Git documentation and Even Hub listings remain English.
   Add the native language name to the README's **Interface languages** list;
   keep this as the single user-facing list rather than repeating languages or
   per-language versions in setup instructions. Acoustic evidence and release
   history remain specific to the behavior and versions actually tested.
   Record exact source/build and device results in the implementation PR.

Acoustic wake model/keywords and STT provider configuration are outside UI
translation. Post-transcription cue cleanup has its own rule/evidence boundary;
adding a UI language alone must not add guessed phonetic wake aliases. See
[post-transcription rules and Korean evidence](wake-transcript-localization.md)
when adding a text-cleanup rule.
