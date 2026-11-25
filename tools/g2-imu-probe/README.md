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

## One physical session

1. Record the probe commit, SDK version, Even phone app version and G2 firmware version. Record stock/custom firmware, whether the glasses are worn, phone fixed in place, navigation closed, reference method and approximate alignment uncertainty. Keep private identifiers, serials and coordinates out of published results.
2. Establish the magnetic cardinal directions independently of the G2, away from large metal objects. A separate compass or floor marks made with a compass work. If the reference is true north instead, record the distinction and correct for it before comparing bearings. Keep the phone stationary, without using its orientation as a measurement.
3. Start once. Follow the twelve poses on the display at your own pace. Level: north, east, south, west, north, west, south, east, north. Still facing north: look up, tilt the right ear down, then return to level. For each pose, tap once on the glasses or ring after aligning and hold until the next instruction. An operator can also mark a pose on the phone without moving it. No synchronized stopwatch is needed.
4. Copy the session JSON before exiting. It contains local receipt times, pose and phase, the three optional axes and a small allowlist of explicit numeric motion fields if the host supplied them. The prototype only keeps samples in page memory and has no network writes or storage calls. Start/stop use the SDK's P200 protocol value. The probe requests stop on exit, hidden page, case/disconnect, the 4-minute limit or 3,000 reports. The export records the stop acknowledgement or an unknown result.
5. Save the raw JSON privately with the setup notes. Report the count per settled pose, observed interval, axis means/ranges, vector magnitude, and any extra fields. Movement and the first 900 ms after marking are labelled separately from the 2.2-second hold. Missing axes stay null. A short run, failed display, missing samples or uncertain alignment is inconclusive.

## Interpret the result

Compare repeat holds and both turn directions with the north tilt/roll controls. Roughly constant level vectors near unit magnitude across different headings, alongside a clear response to tilt, support gravity-dominated acceleration. A change only during a turn could indicate motion or turn rate. Neither observation establishes an absolute bearing. A numeric field name also does not establish its physical source.

If there is a candidate bearing, compare its stable value against *every* independently marked direction using circular error and report repeatability, angular spread, update age and gaps. Repeat after a restart starting on another known heading, and rotate the phone with the glasses fixed as a separate control before treating it as glasses-referenced. Only compare map bearings in a known common north reference. Keep all hardware and freshness claims tied to the versions and conditions measured.
