# Mobility evidence

Staged under #242. The adapters in `server/mobility/` are not yet called by the
application. They supply evidence for Dot to interpret, without another assistant,
navigation interface or background route polling. The integration stage must bind
each request to current location consent, freshness, owner/session identity and a
known destination, with explicit consent for external queries and cancellation on
stop. No destination may be guessed. No paid API, billing fallback, end-user
registration or API-key setup is introduced.

## Source selection

| Source | Use and limits | Decision |
| --- | --- | --- |
| [FOSSGIS OSRM](https://routing.openstreetmap.de/about.html) | Worldwide OSM walking graph; no key; one request/second, no heavy use | Walking candidate, subject to the contact/credit publication gate below |
| [Mapzen Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) | Public raster model; no key; mixed source resolution and age | Terrain estimates, with missing/suspect profiles withheld |
| [Entur](https://developer.entur.no/docs/getting-started) | Official Norwegian transit planning; no account or partnership for open services; application identification required | Regional transit source, explicitly not worldwide coverage |
| [VBB via transport.rest](https://v6.vbb.transport.rest/) | Keyless community gateway for Berlin/Brandenburg; upstream dependency and 100 requests/minute limit | Additional regional transit source |
| [Transitous](https://transitous.org/api/) | Broad transit coverage, but noncommercial-only and coordination for automated/many-user use | Removed from the implementation; no contact or formal adoption |
| [Transitland](https://www.transit.land/documentation/concepts/routing-graph-and-costing) | Registered free tier; transit routing currently US-focused | Not selected: account and regional constraints |
| [openrouteservice](https://giscience.github.io/openrouteservice/frequently-asked-questions) | Free key, per-user registration or a maintained central proxy | Not selected for the no-registration client path |
| [Apple MapKit](https://developer.apple.com/support/terms/apple-developer-program-license-agreement/) | Fast native routing, but Attachment 6 requires corresponding Apple map presentation when displaying map data | Poor fit for conversation-only presentation |
| Local BRouter / OTP / MOTIS with OSM and transit feeds | No hosted API charge, but graph downloads, feed licensing, storage and maintenance remain | Not selected as an implicit additional user/server operational burden |

Regional sources can be combined; lack of a suitable regional source is unknown
coverage, not absence of transport. Configured scheduled transit sources cover **Norway and Berlin/Brandenburg**.
The coarse search envelopes are not coverage guarantees. It does not promise timetables elsewhere or replace
missing transit with a claim that walking is the only option. Dot can use its other
available knowledge/tools, but this code does not assume those tools exist or have
verified any additional transport service.

### Publication and usage gates

FOSSGIS's [full policy](https://www.fossgis.de/arbeitsgruppen/osm-server/nutzungsbedingungen/)
requires visible OSM/ODbL credits, a fix-map link, valid identification, low traffic,
and a reachable email contact on the application website/store listing. The short
routing guide does not include every condition. The maintainer has designated a public support email; do not activate or distribute
this provider until that contact and the in-app/web credits are actually published. Existing GitHub Issues contact
alone is not treated as meeting the email requirement. Commercial/high-volume use
must be reassessed against the policy rather than assumed unrestricted.

Entur's [terms](https://developer.entur.no/terms-of-service) permit reuse including
commercial use under NLOD, with attribution, a licence link and notice of changes.
The client identifies itself as `dotlink-mobility`; no user identity or credential
is submitted. [Rate limits](https://developer.entur.no/docs/open-services/journey-planner/rate-limiting)
apply. No throttling workaround or automatic retry is implemented.

[VBB transport.rest](https://v6.vbb.transport.rest/api.html) explicitly offers
unauthenticated queries (100 requests/minute). It returns upstream VBB information
and is a community gateway, not an operator availability guarantee. Requests send
coordinates and departure time in the URL. The API documentation does not establish
a log-retention period; do not promise provider-side deletion or anonymity. The
integration must limit repeated queries, display VBB/transport.rest attribution
and disclose this additional recipient.

Other regional candidates were checked rather than presumed usable:
[DB transport.rest](https://v6.db.transport.rest/) explicitly says it is no longer
operational; the public Swiss [Transport API](https://transport.opendata.ch/) returned
HTTP 503 on a bounded Zurich probe. Neither is an active dependency. The Swiss
service publishes source/usage/privacy terms and could be reconsidered after
verified recovery; a successful website fetch alone is not proof the API works.

Terrain credits are recorded in [terrain attribution](terrain-attribution.md).
They must be accessible from the eventual application's source/credit presentation.
No service offers an availability, completeness or navigation-safety guarantee.

## Privacy and data contracts

Walking sends exact origin/destination coordinates to FOSSGIS; the provider states
that route requests are logged. Entur receives origin/destination and departure
time in a POST body. Its terms describe standard metadata/IP/path/client-name
logging retained for 14 months; do not claim that query bodies are logged when the
policy only establishes metadata. Terrain tile requests reveal the requested area
and client IP to the tile host. These are new exposures compared with approximate
Overture regions and must be disclosed with the opt-in before application activation.

All outputs are transient. No adapter writes locations, destinations, query URLs or
responses to disk/logs. A bounded memory cache stores public terrain rasters only.
Provider names and labels are untrusted data, not instructions.

Walking candidates retain graph geometry, segment names, modeled distance/time and
ferry segments. The graph snaps each endpoint within 100 m; the exact gap and
**unknown connector access** are retained. No straight-line connector is invented.
Route endpoints, mode and totals are checked. Stairs, surface access, ferry waits,
service schedules, live accessibility and exact road grades remain unknown.

Transit preserves walking access, times, scheduled versus expected times, waiting,
vehicle transfers and realtime flags. The live Entur schema confirms the full mode
enum and identifies ride legs by serviceJourney, so access lifts do not become
invented scheduled rides or transfers. Booking/vehicle-access conditions remain unknown. Realtime observation age, cancellation and
current service operation are unknown in this adapter. Requests for walking and
transit are independent, but the transit source can itself omit slower alternatives.
No returned candidate means only that this bounded source query produced no usable
evidence. Ordinary conversation must continue without an error/setup workflow.

## Resource and quality bounds

- Fixed HTTPS provider hosts/paths, no redirects, credentials or automatic retries.
  Three requests globally; no hidden queue. Each request has a 15-second deadline,
  streamed response enforcement, 2 MiB route limit or 512 KiB tile limit.
- Walking uses one connection and at least 1.1 seconds between starts across network
  instances. A busy source fails immediately. HTTP 429/503 impose at least a
  60-second cooldown and honor a longer valid Retry-After. Cooldowns are in memory.
- Walking output has at most three routes, 10,000 vertices/100 km per route and
  2,000 steps per route. No more than 48 hours of modeled travel is admitted.
- Entur searches only when both points fall in a coarse Norway search envelope
  (57–72 N, 4–32 E). This is an admission envelope, not a country classifier or a
  coverage guarantee; boundary areas may return no usable result. Up to three
  candidates and 40 legs are admitted. Whole journeys must fit a two-day window. VBB uses a separate Berlin/Brandenburg
  search envelope (51.3–53.6 N, 11.2–14.8 E), at most three candidates/40 legs,
  and the same two-day horizon. Reported cancellation is retained; missing walk
  distances stay unknown. Both adapters check endpoint and leg continuity.
  Outside these envelopes no transit request is made.
- Terrain uses zoom 12, at most 12 tiles and 257 path samples per operation, with a
  20-second deadline. The memory cache retains at most 16 tiles for one hour;
  `clear()` discards it. A missing sample withholds complete-route totals.
- The PNG decoder checks CRC, chunk order, dimensions, color depth, filters and
  bounded inflate output; only 256px non-interlaced RGB/RGBA is accepted. Missing,
  transparent or extreme samples are not interpreted as flat ground.
- Raster ascent/descent and maximum sampled grade are unvalidated estimates,
  not road/bridge/tunnel/building heights or personalized exertion predictions.
  A sampled segment over 40% marks a **suspect surface profile** and withholds
  route totals/grade. This conservative screening heuristic is not a terrain
  truth test: it can reject genuinely steep terrain and cannot detect all artifacts.
  It does not establish an impassable route. Remaining estimates still carry the
  resolution/noise/unknown-age limitations. Short steep sections can be missed.

## Verification

`node --test tests/mobility*.test.ts` covers bounded decoding, streaming, concurrency,
cancellation, cache/tile limits, missing/suspect terrain, dateline sampling, snapped
endpoint gaps, route totals/modes, transit time consistency and out-of-region
no-request behavior. These synthetic checks are distinct from live providers and
installed-Dot observations.

`node scripts/measure-mobility.mjs <fixture-id>` makes explicit public
fixture requests only, never from the test suite or normal location updates.
The public fixtures are in `scripts/fixtures/mobility-regions.json`.
`node scripts/measure-mobility-regions.mjs --run` surveys all 26 sequentially,
with 1.5-second gaps and shared provider cooldowns. An optional first fixture ID
resumes a stopped survey without re-querying completed points.
October 30, 2026 observations on the development Mac, not guarantees:

- FOSSGIS public raw probes: Berlin 1.716 s, 44,008 bytes, first route 2,732 m;
  SF hill 0.934 s, 28,237 bytes, 1,236 m; Bangkok 1.169 s, 27,380 bytes, 2,342 m.
  Endpoint gaps ranged from 3 to 36 m. The sparse Amazon probe returned an HTTP
  error; it was not classified as evidence that no path exists.
- Entur public Oslo probe: 1.278 s, 4,552 bytes, three transit candidates.
- Combined Oslo adapters: routes in 1.090 s; terrain completion 4.758 s; four
  requests/272,600 bytes; peak process RSS 125,872 KiB. Walking and transit both
  returned candidates. The initial raster yielded a suspect 94.6% segment, which
  motivated the screening guard; that value is not accepted as a road gradient.
- Previous Transitous probes are historical comparison only: Berlin/SF/sparse
  queries completed with terrain in 3.3–4.3 s. Those observations do not authorize
  that service's use and no Transitous calls remain in the implementation.

Initial provider-reselection runtime observations (before adding VBB) (same public fixtures):

| Fixture | Routes available after | All requested evidence after | Walking | Transit | Terrain |
| --- | ---: | ---: | --- | --- | --- |
| Berlin | 924 ms | 2,467 ms | Two candidates | Outside this transit source | Model estimate |
| SF hill | 614 ms | 2,053 ms | Two candidates | Outside this transit source | Model estimate |
| Sparse Amazon | 823 ms | 2,139 ms | Unavailable in this query | Outside this transit source | Endpoint models only; no route profile |
| Oslo | 1,996 ms | 5,170 ms | Two candidates | Three candidates | Suspect profile; totals/grade withheld |

Network totals were 28,669–272,587 bytes and peak RSS 113,504–125,488 KiB.
These are individual observations, not performance or coverage guarantees.

Before activation, update privacy/setup/credits and cumulative release notes with
the consent/tool integration. This adapter-only stage does not change active
permissions, setup, dependencies or user-facing releases. Actual Dot interpretation,
normal-conversation responsiveness and affected-device acceptance remain #242 gates.
