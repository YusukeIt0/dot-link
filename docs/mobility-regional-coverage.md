# Regional walking and terrain observations

October 30, 2026 · runtime `0c22185cf4c553d36290e650ab8e45b46e9d9c95`.

This is a broad **sample of public point pairs**, not a country-by-country support
guarantee. No private/user position was used. A returned route is a provider
candidate, not a physical check of access, safety, permits or current closures.
Public-transport acquisition is excluded from the current product scope.

## What the survey established

- Walking candidates were returned for 23 of 26 pairs across inhabited continents,
  an urban hill, a mountain and a polar settlement.
- The Amazon, rural Mongolia and Nuuk samples returned no walking candidate.
  Earlier bounded follow-ups with the unchanged walking provider returned HTTP
  400 / `NoSegment` within the explicit 100 m snap radius. This does not mean
  those regions lack roads or all walking coverage.
- Endpoint terrain-model values were returned for all 26 pairs. Route-model totals
  were available for 21; Oslo and Mount Fuji exceeded the conservative 40% profile
  screen, so totals/grade were withheld. The other three had endpoint models only.
  These are not measured road/bridge/building heights or proof of walking difficulty.

## Point-pair observations

“Model” means an unvalidated terrain estimate with resolution/noise limitations.
“Screened” means route totals/grade are withheld; endpoint model heights remain.

| Sample | Walking | Route terrain | All requested evidence |
| --- | --- | --- | ---: |
| Tokyo, Japan (urban) | 2 candidate(s) | Model | 3.48 s |
| Seoul, South Korea (urban) | 1 candidate(s) | Model | 3.73 s |
| Bangkok, Thailand (urban) | 2 candidate(s) | Model | 3.22 s |
| Singapore (urban) | 2 candidate(s) | Model | 1.47 s |
| Delhi, India (urban) | 2 candidate(s) | Model | 4.10 s |
| Dubai, UAE (urban) | 2 candidate(s) | Model | 2.60 s |
| Istanbul, Turkey (urban) | 2 candidate(s) | Model | 1.91 s |
| Cairo, Egypt (urban) | 1 candidate(s) | Model | 1.29 s |
| Nairobi, Kenya (urban) | 1 candidate(s) | Model | 1.47 s |
| Cape Town, South Africa (urban) | 2 candidate(s) | Model | 1.28 s |
| London, UK (urban) | 2 candidate(s) | Model | 5.00 s |
| Berlin, Germany (urban) | 2 candidate(s) | Model | 4.95 s |
| Oslo, Norway (urban) | 2 candidate(s) | Screened | 8.29 s |
| New York, USA (urban) | 2 candidate(s) | Model | 3.38 s |
| San Francisco, USA (urban hill) | 2 candidate(s) | Model | 6.79 s |
| Mexico City, Mexico (urban) | 2 candidate(s) | Model | 4.53 s |
| Lima, Peru (urban) | 1 candidate(s) | Model | 2.52 s |
| Sao Paulo, Brazil (urban) | 2 candidate(s) | Model | 0.77 s |
| Buenos Aires, Argentina (urban) | 2 candidate(s) | Model | 0.72 s |
| Sydney, Australia (urban) | 2 candidate(s) | Model | 2.94 s |
| Auckland, New Zealand (urban) | 2 candidate(s) | Model | 3.21 s |
| Mount Fuji, Japan (mountain) | 1 candidate(s) | Screened | 3.06 s |
| Amazon region, Brazil (sparse) | Unavailable in sample | Endpoints only | 2.15 s |
| Rural Mongolia (sparse) | Unavailable in sample | Endpoints only | 3.17 s |
| Nuuk, Greenland (small coastal city) | Unavailable in sample | Endpoints only | 3.38 s |
| McMurdo area (polar settlement) | 1 candidate(s) | Model | 0.75 s |

## Performance and limits

Walking results were returned or classified in 0.26–2.57 s.
All requested evidence took 0.72–8.29 s (median 3.12 s).
The survey received 2,469,098 bytes across
59 requests. Peak process RSS reached
107,840 KiB; per-row RSS is the process high-water mark,
not isolated per-region allocation. These are development-Mac observations, not
installed-Dot latency or worldwide availability guarantees.

Use walking/terrain evidence where available and let Dot explain only limitations
relevant to the conversation. Do not force a registration or error flow in sparse
areas. Public-transport probes in earlier revisions are research history only;
there are no active transit sources or transit coverage promises.

## Reproduction and attribution

Run `node scripts/measure-mobility-regions.mjs --run` explicitly. It never runs in
normal location sharing or CI. See [public fixtures](../scripts/fixtures/mobility-regions.json),
[machine-readable observations](evidence/mobility-regional-probe.json),
[source selection and limits](mobility-context.md), and
[terrain attribution](terrain-attribution.md). OSM data: © OpenStreetMap contributors
([ODbL](https://www.openstreetmap.org/copyright)). No provider endorses Dot Link.
