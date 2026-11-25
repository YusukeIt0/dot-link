# Phone-facing direction in the Even app

This isolated phone-only preview compares the WebKit compass, an explicitly Earth-referenced orientation event on a flat phone, and the native Even SDK's one-shot `getAppLocation().heading`. Relative alpha, a GPS course and a glasses IMU are not equivalent observations. The product currently requests location updates with a 25 m distance filter and also makes one-shot fixes. This preview never changes the installed companion's subscription.

Build from the repository root using the existing dependency lock.

```sh
node --test tools/phone-heading-probe/*.test.mjs
node_modules/.bin/vite build tools/phone-heading-probe --base ./ --outDir "$PWD/.runtime/phone-heading-preview"
```

Serve only the built directory over a trusted private HTTPS origin and open it from the Even iPhone app's Prototype Mode. Japanese is the default. Append `?lang=en` for English. The screen requests motion permission in the first button tap. The native fix may ask for location permission. The preview never opens the glasses HUD, starts navigation, or controls a persistent location stream. Any completion or page exit removes its orientation listeners. It stops after three minutes.

1. Leave navigation closed and stay in the same place. Set the phone flat and face up. Remember which way the top points. Press Start and leave it still until the next instruction.
2. Turn the top of the phone one quarter turn clockwise on the same spot. Press Measure and leave it still.
3. Return it to the first orientation and press Measure. Copy the report when all three positions are recorded.

The report contains source availability and permission state, native fix age/reuse when the host provides a usable timestamp, counts, angle change relative to the start, within-position spread and reported angular uncertainty. No coordinates, device identifiers, absolute headings or location timestamps are exported. The page uses no storage or network write. A source tracking roughly +90° and returning to the start supplies evidence of stationary device rotation on this host. The thresholds are test tolerances, not compass accuracy. A cached location, invalid compass accuracy, variable held readings or missing values cannot establish a current bearing. A prototype result does not establish published-companion permissions or background delivery.
