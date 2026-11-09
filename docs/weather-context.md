# Worldwide weather context

Work for [#300](https://github.com/YusukeIt0/dot-link/issues/300). This document
describes the implementation decision and acceptance contract, not a released
capability. Actual service, existing-Dot and device evidence must be recorded
separately from offline tests. Main merge and publication await owner instruction.

## Outcome and boundaries

Dot can use weather for a valid shared location or an explicitly requested place
in ordinary conversation. It decides whether a change merits speaking. Dot Link
acquires and describes evidence; it does not implement personal recommendations,
an AI, or a weather prediction engine. Geography downloads must not delay weather.
Weather, maps, movement, terrain and history are optional decision evidence, not
prerequisites for conversation. Missing consent/data or a failed source disables
only that evidence; Dot should continue with what is known and express uncertainty.
The existing feature paths must be checked for this boundary during integration.

## Provider comparison — November 10, 2026

The comparison includes keyless services, free registered tiers, regional public
services and membership-based offerings. Free data licensing is not the same as
free hosted API access. A free allowance inside a paid/metered subscription does
not satisfy the no-paid-API requirement. No accounts or subscriptions were created.

| Candidate | Relevant coverage/data | Cost, distribution and operational fit | Decision |
| --- | --- | --- | --- |
| [MET Norway](https://api.met.no/doc/FAQ) | Worldwide model forecasts, including the present time | No key or fee; commercial use permitted; CC BY attribution; identifiable client and cache discipline required | Preferred first adapter, subject to the nondelegable human agreement below |
| [Open-Meteo](https://open-meteo.com/en/terms) | Worldwide regional/global models; current and hourly fields | Keyless hosted free tier is noncommercial only: below 10,000/day, 5,000/hour, 600/minute. Code and data licenses do not remove that restriction. Self-hosting adds infrastructure and operations | Strong alternative for a deliberately noncommercial distribution; not a universal default for downstream OSS reuse |
| [Visual Crossing](https://www.visualcrossing.com/resources/documentation/weather-api/free-weather-api-no-key/) | Worldwide current conditions and forecasts; keyless access now documented | Free commercial use, variable IP-based fair use; attribution must accompany weather, not only a credits page. [Raw programmatic redistribution restrictions](https://www.visualcrossing.com/resources/documentation/can-i-cache-and-store-visual-crossing-weather-data/) need resolution for a contextual MCP endpoint | Do not assume permission for this data-delivery design; additional G2 attribution and license burden |
| [WeatherAPI.com](https://www.weatherapi.com/pricing) | Current conditions and three-day forecast in free tier | Free commercial tier, 100,000 calls/month, registration/key required. A shared secret cannot ship in public source or desktop binaries | Credible registered alternative; adds per-user setup or centrally operated infrastructure |
| [OpenWeather](https://openweathermap.org/price) | Free current weather and five-day/three-hour forecast, global | Registered key; 60 calls/minute and 1,000,000/month. One Call is a separate metered subscription and is excluded | Registered free endpoints remain an alternative; do not confuse their features with One Call |
| [Pirate Weather](https://pirateweather.net/) | Worldwide model-based current/hourly/daily weather with documented sources | 10,000 free calls/month, key required; [hosted terms](https://pirate-weather.apiable.io/terms) did not expose readable text in this review | Useful transparent alternative; unresolved hosted terms and key setup prevent choosing it now |
| [Tomorrow.io](https://support.tomorrow.io/hc/en-us/articles/20273728362644-Free-API-Plan-Rate-Limits) | Core temperature, humidity, wind, precipitation | Registered free limits: 500/day, 25/hour, 3/second. [Keyless access](https://support.tomorrow.io/hc/en-us/articles/31227543026708-How-to-Use-the-Tomorrow-io-API) is evaluation-only | Weak fit for distributed ongoing use without setup; no paid upgrade |
| [7Timer](https://www.7timer.info/doc.php?lang=en) | Global GFS-derived forecasts, categorical fields in several products | No key; documentation permits redistribution for noncommercial purposes; older documentation and coarse categories | No advantage over the shortlisted alternatives for this outcome |
| [NWS](https://www.weather.gov/documentation/services-web-api), [Bright Sky](https://brightsky.dev/) | Regional public-service/station-oriented data | Useful regional sources but not a single worldwide arbitrary-coordinate solution | Do not build a country-specific provider mosaic for this feature |
| [Apple WeatherKit](https://developer.apple.com/weatherkit/) | Current and forecast weather; native/REST interfaces | 500,000 calls/month included with paid developer membership; entitlement/account coupling | Excluded from the strictly free default; membership allowance is not unrestricted free API access |

No provider's current-condition label establishes a sensor reading at the person's
precise position. Actual latency and regional usefulness remain measurement questions.
The first adapter is chosen for an open redistribution license, no embedded secret,
documented versioned service and bounded operations, not a claim of superior accuracy.

## MET Norway constraints

The [November 5 terms](https://api.met.no/doc/TermsOfService) require a human with
authority to read, understand and accept them before service use. Implementation
and injected-response tests may proceed; live API measurements await that action.
The app's separate weather opt-in must identify `api.met.no`, coordinate/IP exposure
and this agreement. Existing location/mobility consent never enables weather.

Use an identifying app/version/repository User-Agent. Respect `Expires` and
`Last-Modified`/`If-Modified-Since`, bounded backoff, and product-specific repeat
intervals. Requests use at most four coordinate decimals. Service availability is
not guaranteed. Total application traffic above 20 requests/second requires a
provider agreement; a per-installation limit does not prove aggregate compliance.
Scaling beyond modest distributed use requires reassessment before broader rollout.

[Locationforecast](https://api.met.no/weatherapi/locationforecast/2.0/documentation)
is global, with hourly Nordic updates and six-hour updates elsewhere. Identical
queries must wait at least 30 minutes in the Nordic region or three hours elsewhere.
The initial adapter conservatively uses three hours everywhere and response expiry,
with jitter rather than synchronized clock-boundary polling.

The [data model](https://api.met.no/doc/locationforecast/datamodel) describes roughly
9 km global model resolution and 2.5 km Nordic/Arctic short-range models. Forecasts
are automated. Terrain and coastal effects can remain unresolved. Without supplied
altitude, the provider uses its own topography for temperature correction. Weather
does not wait for local terrain acquisition. The actual response's elevation and
time spacing remain evidence; inferred regional resolution is not measured accuracy.

Instantaneous temperature, humidity and wind and interval precipitation are distinct.
Preserve each precipitation interval rather than implying an instantaneous rainfall
measurement. The provider does not return a universal feels-like field; leave it
unavailable instead of introducing a local health/recommendation calculation.
See the [product FAQ](https://api.met.no/doc/locationforecast/FAQ).

Credit [MET Norway](https://api.met.no/doc/License), link CC BY 4.0, and identify
normalization/subsetting. The tool evidence retains source links. An accessible
sources/privacy page follows the existing application attribution pattern.

## Ownership and dependency order

1. **Acquisition child:** a narrow provider adapter and normalized evidence contract,
   bounded cache/transport, offline fixtures, permitted public-coordinate probe.
   No phone access, consent mutation, messages or autonomous decisions.
2. **Integration child:** independent weather opt-in/session lifecycle, current versus
   specified-place MCP requests, coalesced updates through the existing context
   path, localization and privacy/source documentation. It consumes acquisition
   without embedding provider-specific response paths in the location owner.

The integration branch remains separate from main. Child integration requires its
checks and independent review. Runtime fixtures are not device acceptance.

## Evidence contract and failure behavior

Return source, attribution/license, requested versus provider query coordinates,
data kind, model update time, retrieval/check time, valid time and precipitation
intervals in UTC. Keep missing values null. Report stale/unavailable/partial
explicitly. A currently valid forecast is still a forecast, including when cached.
Do not fabricate exact observation quality, precipitation probability or feels-like
temperature from fields the provider did not supply.

Current-location access reuses the location owner's fresh context and revocation
checks. Explicit-place access requires weather consent but cannot impersonate a
current location or change the shared fix. Coordinate provenance is required;
existing Dot search/geographic capabilities resolve place names, not a new geocoder.

Weather adds value over Dot's existing search by joining authorized fresh position,
bounded reusable evidence and meaningful context changes in the same session.
It does not promise access to or replace Dot's provider-native weather tools.

Cancellation, timeout, malformed/oversized data, missing fields, model refresh,
rate limits, shutdown and consent revocation must fail without blocking conversation.
Cache storage is bounded and documented, with coarse query positions rather than
raw phone fixes. Retention and request-suppression metadata survive restarts so
relaunching does not repeatedly fetch the same forecast. No persistent movement
history is created by this component. Public records use fictional/public fixtures.

## Acceptance

Automated cases cover clock/interval semantics, global coordinates and dateline,
missing data, no current-time coverage, stale/future update times, cache expiry and
conditional responses, provider errors, bounded resources, late completion and
revocation. Integration tests cover both location modes, off/disconnected/stale
location, independent consent, restart and coalesced changes after a silent decision.

Live public-fixture measurements span Asia, Europe, Africa, North/South America,
Oceania and mountain/polar locations. They establish reachability and response
semantics, not global accuracy. Then refresh the registered app and verify the
existing Dot actually sees and uses the new definitions. Prepare one ordinary-use
device session for current weather, another place, stopped sharing and optional G2
readability. Preserve source/build identity and separate observed and unknown results.

### Acquisition recovery policy

The conservative three-hour identical-query minimum also applies after failure
or cancellation: the current product FAQ does not grant an exception for failed
requests. This can delay first-use recovery after a transient network failure;
Dot should continue without weather and may use its other authorized sources.
Do not silently shorten that interval on an assumption about provider terms.

Transient local-cache read failures can retry on the next query. Invalid regular
cache files are atomically replaced with an empty cache and a persisted 24-hour
global recovery interval, rather than permanently disabling weather or immediately
repeating unknown requests. No corrupt coordinate copy is retained. Permission,
symlink and other I/O errors remain unavailable until the underlying condition is
fixed; they do not trigger network traffic.
