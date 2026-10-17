# Introduction page

Run `node scripts/build-site.mjs`, then serve `.site/` to preview `/dot-link/`.
The build emits complete static HTML for English at the root and seven language
directories. `index.html` is the shared template; `locales/*.json` holds plain-text
copy, escaped by the renderer. English copy remains the baseline. Keep equivalent
claims and requirements across all locales when editing it.

Language URLs, reciprocal hreflang links, navigation and the sitemap come from
the same language list in the build script. Images, video and English captions
are shared. There is no client-side translation or automatic redirect.

Run `node --test tests/site.test.mjs` to validate the generated pages and links.
Review desktop/mobile wrapping and Arabic RTL visually after layout or copy edits.
The Pages workflow builds PRs; deployment is a separate manual workflow on main.
