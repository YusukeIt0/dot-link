# Application localization

Application language is separate from conversation contents, speech recognition
and acoustic wake detection. English is the fallback. The Even application
supports English, Japanese and Korean; the Mac migration is the next dependent
step of the localization work.

## Resource contract

- `localization/locales.json` registers each language's native name, selector
  order, speech locale and Mac date locale. Existing Japanese/English selector
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
  commit the generated result. Never hand-edit it.
- `npm test` and build commands check registered catalogs, exact key coverage,
  nonempty text, placeholder parity, HTML references and generated imports.
  TypeScript checks app message IDs. Runtime rendering retains English fallback.

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

## Adding a language

1. Copy the English catalog to the new language file and translate every entry.
   Preserve placeholders, the meaning of permissions/stopping, product names
   and literal wake names. Review short state labels as well as long help/error
   text. Register native name and locale metadata and regenerate imports.
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
   Record exact source/build and device results in the implementation PR.

Acoustic wake model/keywords and STT provider configuration are outside UI
translation. Post-transcription cue cleanup has its own rule/evidence boundary;
adding a UI language alone must not add guessed phonetic wake aliases.
