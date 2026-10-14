# Introduction page

The standalone English page lives in `site/`. Keep product claims aligned with the current README and user guide. Link to the README for detailed setup instead of duplicating instructions. The page has no application runtime, JavaScript, external fonts, analytics, or additional package dependencies.

## Preview

```sh
node scripts/build-site.mjs
python3 -m http.server 4175 --bind 127.0.0.1 --directory .site
```

Open `http://127.0.0.1:4175/dot-link/`. The build copies only the page files and three existing public assets into `.site/dot-link/`; it does not use the app's `dist/`. Keep the simulator image attribution visible. Check desktop and narrow mobile layouts, keyboard navigation, links, and image loading before publishing.

## Publish

Publication is manual and separate from merging. For initial setup, open repository **Settings → Pages → Build and deployment → Source** and select **GitHub Actions**. Keep the `github-pages` environment restricted to `main`.

After the page change is reviewed and merged, open **Actions → Introduction page → Run workflow**, select **main**, and run it when publication is intended. Pull requests build the page artifact but cannot deploy it. Later updates also require a manual workflow run.

The expected address is `https://yusukeit0.github.io/dot-link/`. After the workflow succeeds, check that URL, its assets, navigation links, and `sitemap.xml`. A local preview or passing PR check does not verify the deployed page.

The build uses an explicit file list. If a new public asset or ownership-verification file is needed, add it to `scripts/build-site.mjs` as well. Do not upload the repository root or app runtime to Pages.
