# Mobility evidence

This work is staged under #242. The adapters in `server/mobility/` are not yet
called by the application. They provide evidence for the existing Dot to interpret;
they do not introduce another assistant, a navigation interface or route polling.
The next integration stage must bind every request to current location consent,
freshness, owner/session identity and a known destination, with explicit consent
for external queries and cancellation on stop. No destination may be guessed.

## Sources and adoption boundary

[Transitous](https://transitous.org/api/) is a **conditional** candidate, not an
approved production dependency. Its policy requires noncommercial open-source
usage and coordination for automated, high-volume or many-user applications.
Formal adoption must resolve that fit before enabling distributed builds. No paid
API, billing account or billable fallback is introduced. Do not infer permission
from successful public probes. [Provider privacy](https://transitous.org/privacy/)
covers URL/IP logs: routing URLs disclose origin, destination and departure time.

[Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) supply public
Terrarium rasters. Tile requests disclose an area and client IP. The provider has
no account or billing key in this implementation. These rasters are models with
mixed sources, resolution and age, not exact road, bridge, tunnel or building
heights. Buildings' height is not established by terrain elevation. See
[terrain attribution](terrain-attribution.md), included for redistribution and
required in the eventual application's source/credit presentation.

## Evidence contracts and bounds

- Walking and transit use separate requests, so a quick walk does not hide transit.
  Direct walking is bounded to four hours; the transit departure search window is
  one hour. At most three candidates per mode are returned. These are source and
  query limits, not an exhaustive account of transport in a region.
- Candidates preserve access/egress walking, leg times, waiting, transfers, route
  labels, cancellation flags and reported stairs. Vehicle-leg distance may be
  absent. Missing step information is unknown; zero reported stairs is not proof
  of accessibility. Provider realtime flags are retained, but their measurement
  age is unknown; retrieval time is not a realtime observation timestamp.
- Empty, malformed or failed results stay unknown/unavailable. They do not prove
  that no path or transport exists. Dot decides whether a limitation matters to
  the conversation; ordinary responses must not become an error/setup workflow.
- Source names/labels are untrusted data, never instructions. No route is certified
  safe, open, accessible or physically traversable by these responses.
- Fixed HTTPS origins, no redirects/retries/credentials; three global requests,
  15-second request deadlines, 2 MiB maximum route responses and 512 KiB tiles.
  Body streaming enforces limits regardless of Content-Length. No source URL or
  response is logged by adapters.
- Terrain uses zoom 12, at most 12 tiles and 257 path samples per operation, with
  a 20-second terrain deadline. A public-raster memory cache retains at most 16
  tiles for up to one hour; `clear()` discards it. No disk writes or movement trail.
  Walking geometry is capped at 10,000 vertices and 100 km for terrain sampling.
- The PNG decoder checks chunk CRC/order, dimensions, color depth, compression,
  filters and bounded inflate output; only 256px non-interlaced RGB/RGBA is accepted.
  Transparent/extreme values stay missing. Bilinear sampling uses pixel centers,
  clamps tile-edge pixels and records approximate raster/sample spacing.
- Ascent/descent and maximum sampled grade are unvalidated raster estimates.
  They can include surface/noise artifacts and miss small steep sections. Missing
  samples make complete-route totals unknown. Never turn a maximum into a claim
  of a verified steep road. No clinical exertion or personalized effort model.

## Verification

`node --test tests/mobility.test.ts` covers decoding/filter/CRC/dimension failures,
network limits and concurrency, cancellation, tile bounds, missing coverage,
dateline sampling, time validation, waiting, optional vehicle distance, separate
mode queries and sparse results. These synthetic checks are distinct from real
provider and installed-Dot observations.

`node scripts/measure-mobility.mjs berlin|sf-hill|amazon` makes explicit network
requests using public fixtures only. It is never run by the application or test
suite. October 30, 2026 single-run observations on the development Mac:

| Public fixture | Route query | Total with terrain | Walking | Transit |
| --- | ---: | ---: | --- | --- |
| Berlin | 2.237 s | 3.666 s | 2,722 m / 2,275 s | Three candidates; first journey 780 s |
| SF hill | 1.158 s | 3.272 s | 1,233 m / 1,035 s; seven reported stair sections | Three candidates, including a slower alternative |
| Sparse Amazon | 1.529 s | 4.217 s | 7,067 m / 7,504 s | No candidate in this query window |

Peak process RSS was 118–121 MB. After correcting pixel-center interpolation,
replay of SF's captured route/tile estimated approximately 81 m ascent and 56 m
descent, with endpoint heights 66 m and 90 m. Berlin's raster still yields about
38 m ascent and a 15% sampled maximum: these are **not verified street gradients**,
and illustrate why raw terrain cannot certify a steep street or precise effort.

The sparse fixture's original short-default query returned no routes; explicit
four-hour walking bounds found a long detour. This demonstrates why query absence
must never become a claim that a path does not exist. These are changing provider
results, not coverage/performance guarantees. Physical behavior, consent UI,
ordinary-conversation responsiveness and Dot interpretation remain parent gates.

This adapter-only stage changes no active permission, setup, dependency, privacy
flow or user-facing release note. Before activation, update privacy/setup/credits
and cumulative release notes together with the consent and tool integration.
