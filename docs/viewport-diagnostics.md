# Viewport diagnostic build

Build with `VITE_VIEWPORT_DIAGNOSTICS=1 npm run build`, then package the resulting `dist` with `node scripts/package-beta.mjs`. A normal build does not install the probe. Do not overwrite the diagnostic build with a normal build before packaging.

The temporary top overlay is non-interactive and does not change app scroll/focus behavior. It observes geometry; it does not read input contents, credentials, conversations, coordinates, or clipboard data, and does not send or persist its observations. The current session retains only five focus snapshots and a live sample.

Columns: seconds since startup; event; field (`URL`, `CODE`, `MSG`, or `-`); `V` visual viewport height; `Y` visual viewport top offset; `H` main element height; `T` main top; `S` main scroll offset. `W` is window.innerHeight. Samples at 100 and 500 ms retain the triggering field label even if focus subsequently changes; `live` labels the currently focused field.

Reproduction: on a physical iPhone using direct touch, focus the download URL, focus the pairing field, dismiss the keyboard, then focus the URL again. A screen recording captures the values and rendering together. Do not enter a real pairing code for this geometry-only check. Mirroring and desktop success do not establish the direct-touch result.

Interpretation: if the visual viewport shrinks again at the URL focus and main follows it, investigate host viewport reporting and the app's response to readonly focus. If dimensions remain full height while rendering clips or turns white, investigate painting/compositing instead. Neither result alone proves whether the underlying fault belongs to the host WebView or the app. The probe itself can affect timing; failure to reproduce with it is inconclusive.
