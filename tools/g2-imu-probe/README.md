# G2 motion probe

This temporary Even Hub preview tests whether the official host delivers evidence of the glasses' horizontal facing direction while its own navigation is closed. It uses the project's pinned SDK and its normal typed system events. The installed Dot Link app only displays calibrated pitch and cannot export the source axes.

## Prepare the preview

From the repository root with the locked dependencies installed, run:

```sh
node --test tools/g2-imu-probe/probe.test.mjs
node_modules/.bin/vite build tools/g2-imu-probe --base ./ --outDir "$PWD/.runtime/g2-imu-preview"
```

Serve **only the built directory** on a private address reachable by the phone. For example, on the Mac with the phone on the same trusted network:

```sh
python3 -m http.server 5178 --bind "$PROBE_PRIVATE_IP" --directory .runtime/g2-imu-preview
```

Set `PROBE_PRIVATE_IP` to the Mac's private interface address first. In the official Even app, open developer prototype mode and enter the preview URL, or use the [official CLI QR route](https://hub.evenrealities.com/docs/cli/project). The prototype occupies the glasses display during the measurement. After copying the result, exit the prototype, return to the previously used Dot Link app and stop the static server. There is no install, pairing change or firmware update.

Use `?lang=ja` or `?lang=en` for an explicit language. For a hosted session with a known operator preference, set `VITE_PROBE_LANGUAGE=ja` when building to offer Japanese on the first screen even if the WebView reports English.

## One physical session

1. Record the probe commit, SDK version, Even phone app version and G2 firmware version. Record stock/custom firmware, whether the glasses are worn, phone fixed in place, navigation closed, reference method and approximate alignment uncertainty. Keep private identifiers, serials and coordinates out of published results.
2. Start facing any identifiable fixed point. Compass directions are optional for the rotation-versus-tilt question. If a bearing candidate appears, measure against independent north marks away from large metal objects, documenting magnetic versus true north. Keep the phone stationary throughout.
3. Start once. The preview follows the phone language and offers Japanese and English before starting. Turn the whole body a quarter turn to the right four times, then left four times, keeping the head level and returning to the starting point each time around. Still facing forward, look up, tilt the right ear down, then return to level. For each pose, tap once on the glasses or ring after aligning and hold until the next instruction. An operator can also mark a pose on the phone without moving it. No synchronized stopwatch is needed.
4. Copy the session JSON before exiting. It contains local receipt times, pose and phase, the three optional axes and a small allowlist of explicit numeric motion fields if the host supplied them. The prototype only keeps samples in page memory and has no network writes or storage calls. Start/stop use the SDK's P200 protocol value. The probe requests stop on exit, hidden page, case/disconnect, the 4-minute limit or 3,000 reports. The export records the stop acknowledgement or an unknown result.
5. Save the raw JSON privately with the setup notes. Report the count per settled pose, observed interval, axis means/ranges, vector magnitude, and any extra fields. Movement and the first 900 ms after marking are labelled separately from the 2.2-second hold. Missing axes stay null. A short run, failed display, missing samples or uncertain alignment is inconclusive.

## Interpret the result

Compare repeat holds and both turn directions with the forward-facing tilt/roll controls. Roughly constant level vectors near unit magnitude across different headings, alongside a clear response to tilt, support gravity-dominated acceleration. A change only during a turn could indicate motion or turn rate. Neither observation establishes an absolute bearing. A numeric field name also does not establish its physical source.

If there is a candidate bearing, compare its stable value against *every* independently marked direction using circular error and report repeatability, angular spread, update age and gaps. Repeat after a restart starting on another known heading, and rotate the phone with the glasses fixed as a separate control before treating it as glasses-referenced. Only compare map bearings in a known common north reference. Keep all hardware and freshness claims tied to the versions and conditions measured.

## Check what reaches Even Hub during native navigation

The separate phone-only preview in `navigation/` checks a narrower question. A G2 can supply magnetic heading to another host during native navigation. It is unknown whether the stock Even app forwards a named angle to a developer preview while the glasses still show the native map.

```sh
node --test tools/g2-imu-probe/*.test.mjs
VITE_PROBE_LANGUAGE=ja node_modules/.bin/vite build tools/g2-imu-probe/navigation --base ./ --outDir "$PWD/.runtime/g2-navigation-preview"
```

Serve only this second build as described above. Use the stock Even app with a route chosen by the wearer, from a safe place to stand still. If opening Developer Hub requires ending the route, record that outcome and stop there. If the preview opens, check the glasses. Report a disappeared map immediately or start the observation with the map still visible. Leave the phone still, turn the head slowly left and right once, then report whether the map stayed visible. No knowledge of north is required.

The preview reads the G2 connection state and subscribes to SDK events for up to 60 seconds. It issues no display, IMU or navigation commands. Only event counts, relative receipt times, lifecycle flags and a limited set of explicitly named numeric angle candidates can appear in the local result. Copy the result before leaving. If the page closes first, record the observed screen transition. A timeout without an operator report leaves map visibility unknown.

Zero matching events describe this particular WebView session and filter. They cannot establish whether another host receives compass data. A candidate must still track head turns with the phone fixed, agree with an independent reference, stay fresh and coexist with the actual Dot Link display and voice path. Working only during a native trip would leave ordinary use outside navigation unresolved.
