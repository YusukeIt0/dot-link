# Introduction page

The introduction site lives in `site/`. English stays at the root URL; Japanese, Traditional Chinese, Simplified Chinese, Korean, Arabic, French and German have their own directories. Keep product claims aligned with the current README and user guide, and equivalent across locales. Link to the English README for detailed setup instead of duplicating instructions. The pages have no application runtime, JavaScript, external fonts, analytics, or additional package dependencies.

`site/index.html` is the shared template. `site/locales/*.json` contains plain-text copy, escaped by the renderer; English is the baseline. The language list in `scripts/build-site.mjs` generates the URLs, reciprocal hreflang links, language navigation and sitemap. There are no automatic language redirects. Arabic uses RTL layout; images, video and English captions are shared.

## Preview

```sh
node scripts/build-site.mjs
python3 -m http.server 4175 --bind 127.0.0.1 --directory .site
```

Open `http://127.0.0.1:4175/dot-link/`, or a language directory such as `/dot-link/ja/`. The build renders complete static pages and a sitemap into `.site/dot-link/`, then copies the shared stylesheet and approved public media; it does not use the app's `dist/`.

Run `node --test tests/site.test.mjs` to validate the generated pages, discovery metadata, local assets and anchors. Keep the simulator image attribution visible. Check desktop and narrow mobile layouts, Arabic RTL, keyboard navigation, language links, and image loading before publishing.

## Publish

Publication is manual and separate from merging. For initial setup, open repository **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. Keep the `github-pages` environment restricted to `main`.

After the page change is reviewed and merged, open **Actions → Introduction page → Run workflow**, select **main**, and run it when publication is intended. Pull requests build the page artifact but cannot deploy it. Later updates also require a manual workflow run.

The expected address is `https://yusukeit0.github.io/dot-link/`. After the workflow succeeds, check the root and all seven locale URLs, assets, navigation links, and `sitemap.xml`. A local preview or passing PR check does not verify the deployed page or search-engine indexing.

The build uses an explicit file list. If a new public asset or ownership-verification file is needed, add it to `scripts/build-site.mjs` as well. Do not upload the repository root or app runtime to Pages.
