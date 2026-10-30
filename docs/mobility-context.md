# Walking and terrain evidence

Staged under #242. The adapters in `server/mobility/` are not yet called by the
application. They supply walking-route and model-terrain evidence for the existing
Dot to interpret, without another assistant, navigation interface or background
route polling. Caller consent, freshness/session ownership and actual-Dot acceptance
remain integration work. No destination may be guessed. No paid API, billing
fallback, end-user registration or API-key setup is introduced.

The agreed scope is **walking candidates plus terrain/elevation**. Public-transport
planning is excluded: there are no timetable, transit, delay, cancellation or
transfer providers or queries. Dot may use its own other tools if available, but
Dot Link neither assumes those tools exist nor invents transport evidence.

## Source selection

| Source | Use and limits | Decision |
| --- | --- | --- |
| [FOSSGIS OSRM](https://routing.openstreetmap.de/about.html) | Worldwide OSM walking graph; no key; one request/second, no heavy use | Walking candidates, subject to contact/credit publication below |
| [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | Public raster model; no key; mixed source resolution and age | Terrain estimates; withhold missing/suspect profiles |
| [openrouteservice](https://giscience.github.io/openrouteservice/frequently-asked-questions) | Free key, per-user registration or a maintained central proxy | Not selected for the no-registration client path |
| [Apple MapKit](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/) | Fast native routing, but Attachment 6 requires corresponding Apple map presentation when displaying map data | Poor fit for conversation-only presentation |
| Local BRouter / OTP / MOTIS with OSM and transit feeds | No hosted API charge, but graph downloads, feed licensing, storage and maintenance remain | Not selected as an implicit additional operational burden |

Earlier public-transport research is comparison history, not an active dependency.
[Transitous](https://transitous.org/api/) has usage/coordination constraints;
[Transitland](https://www.transit.land/documentation/concepts/routing-graph-and-costing)
requires registration and has regional constraints. Entur and VBB demonstrated
regional candidates but were removed when the scope changed to walking/terrain.
No dormant transit adapters, permitted transit hosts or provider credentials remain.
The removal does not claim that public transport is absent in any region.

### Publication and usage gates

FOSSGIS's [full policy](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/)
requires visible OSM/ODbL credits, a fix-map link, valid identification, low traffic,
and a reachable email contact on the application website/store listing. The short
routing guide does not include every condition. The maintainer designated a public
support address; contact and in-app/web credits must actually be published before
activation/distribution. Existing GitHub Issues contact alone is insufficient.
Commercial/high-volume use must be reassessed rather than assumed unrestricted.

Terrain credits are in [terrain attribution](terrain-attribution.md) and must be
accessible in the application. No source offers an availability, completeness or
navigation-safety guarantee.

## Privacy and data contracts

Walking sends exact origin/destination coordinates to FOSSGIS, whose policy states
that route requests are logged. Terrain tile requests reveal the requested area
and connecting IP to the tile host. These are new exposures compared with
approximate Overture regions; disclose them with the opt-in before activation.
No transit provider receives coordinates or departure times.

No adapter writes locations, destinations, query URLs or results to disk/logs.
A bounded memory cache stores public terrain rasters only. Source labels are
untrusted data, never instructions. Stop/revocation must cancel pending queries
and discard transient context in the integration stage.

Walking candidates retain graph geometry, segment names, modeled distance/time and
any ferry segments present in the graph. Ferries are flagged, not verified or
scheduled: no ferry/timetable provider is queried. Each endpoint snaps within
100 m; the exact gap and **unknown connector access** remain explicit. No
straight-line walkable connector is invented. Route endpoints, mode and totals
are checked. Stairs, access restrictions, ferry waits, live closures,
accessibility and exact road grades remain unknown.

No candidate means only that this bounded query produced no usable evidence.
It never proves that no walking route exists. Ordinary conversation must continue
without a registration, navigation or error-driven setup flow.

## Resource and quality bounds

- Fixed HTTPS hosts/paths; GET only; no redirects, credentials or automatic retries.
  Three requests globally, no queue; 15-second request deadline, streamed limits
  of 2 MiB per route response and 512 KiB per terrain tile.
- Walking uses one connection and at least 1.1 seconds between starts across
  instances. Busy sources fail immediately. HTTP 429/503 impose at least 60 seconds
  of cooldown and honor longer valid `Retry-After` values. Cooldowns stay in memory.
- At most three walking routes, 10,000 vertices/100 km and 2,000 steps per route;
  at most 48 hours of modeled travel. Candidate search is bounded, not exhaustive.
- Terrain uses zoom 12, at most 12 tiles/257 path samples per operation, a 20-second
  deadline, and a 16-tile/one-hour memory cache. `clear()` discards that cache.
  Missing samples withhold complete-route totals.
- PNG decoding validates CRC, order, dimensions, color/filter types and bounded
  inflate output; only 256px non-interlaced RGB/RGBA is accepted. Transparent,
  missing or extreme samples are not treated as flat ground.
- Raster ascent/descent and grade are unvalidated model estimates, not measured
  road/bridge/tunnel/building heights or personalized exertion. A sampled segment
  over 40% marks a suspect profile and withholds route totals/grade. This screen
  can reject genuine steep terrain and cannot detect all artifacts. Short steep
  sections can be missed; age, vertical accuracy and current access remain unknown.

Provider [`Retry-After`](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.3)
is a minimum wait in this client, even when longer than an hour. Shortening it
would disregard the source's requested delay. Prolonged source unavailability is
preferable to early retries; other evidence and ordinary conversation remain usable.

## Verification

The [worldwide sample report](mobility-regional-coverage.md) records 26 public pairs
and source-specific limits, not country-wide coverage or physical access proof.

`node --test tests/mobility*.test.ts` checks bounded decoding, streaming, concurrency,
cancellation, throttling, cache/tile limits, missing/suspect terrain, dateline
sampling, endpoint gaps, route totals/modes and rejection of transit source hosts.
These fixture tests are distinct from live-provider and installed-Dot observations.

`node scripts/measure-mobility.mjs <fixture-id>` queries only an explicit public
fixture. `node scripts/measure-mobility-regions.mjs --run` surveys all 26 sequentially
with 1.5-second gaps and shared cooldowns; neither runs in the app or CI.
The fixture list is `scripts/fixtures/mobility-regions.json`.

Before activation, update privacy/setup/credits and cumulative user-facing release
notes with consent/tool integration. This adapter-only stage changes no active
permissions, setup, dependencies or releases. Actual Dot interpretation,
normal-conversation responsiveness and affected-device acceptance remain #242 gates.
