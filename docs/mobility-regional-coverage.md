# Regional mobility observations

October 30, 2026 · runtime `341d475f89aab1d167a357a6dcc4e2f12d1e9219`.

This is a broad **sample of public point pairs**, not a country-by-country support guarantee.
No private/user position was used. A returned route is a provider candidate, not a
physical check of access, safety, permits, current closures or navigation suitability.

## What the survey established

- Walking candidates were returned for 23 of 26 pairs across inhabited continents,
  an urban hill, a mountain and a polar settlement.
- Three pairs had no matching graph segment within the explicit 100 m snap radius:
  the Amazon sample, rural Mongolia and Nuuk. Follow-up returned HTTP 400 /
  `NoSegment`. This does not mean those regions lack roads or all walking coverage.
- Endpoint terrain-model values were returned for all 26 pairs. Route-model totals
  were available for 21; Oslo and Mount Fuji exceeded the conservative 40%
  profile screen and their totals/grade were withheld. The other three had only
  endpoint models because no route was available. These models are not measured
  road/bridge/building heights or proof that a slope is easy or difficult.
- Scheduled transit candidates were returned in both configured sample areas:
  Oslo (Entur) and Berlin (VBB via transport.rest). The other 24 pairs were
  **not queried for transit**, because no configured regional source covered them.
  That is a limitation of this integration, not evidence that buses/trains are absent.

## Point-pair observations

“Model” means an unvalidated terrain estimate with source-resolution/noise limitations.
“Screened” means totals/grade were withheld; endpoint model heights remain available.
“Not queried” means no configured transit source, not a negative transit search.

| Sample | Walking | Route terrain | Scheduled transit | All requested evidence |
| --- | --- | --- | --- | ---: |
| Tokyo, Japan (urban) | 2 candidate(s) | Model | Not queried | 2.77 s |
| Seoul, South Korea (urban) | 1 candidate(s) | Model | Not queried | 2.15 s |
| Bangkok, Thailand (urban) | 2 candidate(s) | Model | Not queried | 0.59 s |
| Singapore (urban) | 2 candidate(s) | Model | Not queried | 2.72 s |
| Delhi, India (urban) | 2 candidate(s) | Model | Not queried | 2.50 s |
| Dubai, UAE (urban) | 2 candidate(s) | Model | Not queried | 0.56 s |
| Istanbul, Turkey (urban) | 2 candidate(s) | Model | Not queried | 0.90 s |
| Cairo, Egypt (urban) | 1 candidate(s) | Model | Not queried | 0.59 s |
| Nairobi, Kenya (urban) | 1 candidate(s) | Model | Not queried | 0.52 s |
| Cape Town, South Africa (urban) | 2 candidate(s) | Model | Not queried | 0.58 s |
| London, UK (urban) | 2 candidate(s) | Model | Not queried | 3.26 s |
| Berlin, Germany (urban) | 2 candidate(s) | Model | 3 candidate(s) | 4.03 s |
| Oslo, Norway (urban) | 2 candidate(s) | Screened | 3 candidate(s) | 6.62 s |
| New York, USA (urban) | 2 candidate(s) | Model | Not queried | 3.50 s |
| San Francisco, USA (urban hill) | 2 candidate(s) | Model | Not queried | 2.38 s |
| Mexico City, Mexico (urban) | 2 candidate(s) | Model | Not queried | 2.13 s |
| Lima, Peru (urban) | 1 candidate(s) | Model | Not queried | 1.64 s |
| Sao Paulo, Brazil (urban) | 2 candidate(s) | Model | Not queried | 1.65 s |
| Buenos Aires, Argentina (urban) | 2 candidate(s) | Model | Not queried | 0.92 s |
| Sydney, Australia (urban) | 2 candidate(s) | Model | Not queried | 2.73 s |
| Auckland, New Zealand (urban) | 2 candidate(s) | Model | Not queried | 2.07 s |
| Mount Fuji, Japan (mountain) | 1 candidate(s) | Screened | Not queried | 1.16 s |
| Amazon region, Brazil (sparse) | No segment within 100 m | Endpoints only | Not queried | 0.87 s |
| Rural Mongolia (sparse) | No segment within 100 m | Endpoints only | Not queried | 2.11 s |
| Nuuk, Greenland (small coastal city) | No segment within 100 m | Endpoints only | Not queried | 2.95 s |
| McMurdo area (polar settlement) | 1 candidate(s) | Model | Not queried | 1.71 s |

## Performance and limits

Routes were returned or classified in 0.20–2.51 s; total requested evidence took 0.52–6.62 s (median 2.09 s). These are one-run observations from a development Mac,
not installed-Dot latency or worldwide availability guarantees.
The survey received 2,490,909 bytes across 61 requests. Peak process RSS reached 119,680 KiB. Per-row RSS is the process high-water mark, not isolated per-region allocation.

No global scheduled-transit provider meeting the chosen account/cost/coordination
constraints was established. Transitous requires usage coordination for automated/
many-user use and excludes commercial use. DB transport.rest announces that it
is no longer operational. The Swiss transport.opendata.ch candidate returned 503
on a Zurich probe and was not adopted. These are distinct from data coverage.

Keep walking/terrain evidence useful where possible; let Dot describe only the
limitations relevant to a conversation. Do not force a registration or error flow
onto the owner in unsupported areas. Further regional sources should be added only
after checking their actual availability, terms, privacy and maintenance burden.

## Reproduction and attribution

Run `node scripts/measure-mobility-regions.mjs --run` explicitly; it is never part
of normal location sharing or CI. The fixture list is
[`scripts/fixtures/mobility-regions.json`](../scripts/fixtures/mobility-regions.json).
Machine-readable observations are in [the evidence file](evidence/mobility-regional-probe.json).
See [source selection, terms, privacy and limits](mobility-context.md) and
[terrain attribution](terrain-attribution.md). OSM data: © OpenStreetMap contributors
([ODbL](https://www.openstreetmap.org/copyright)); transit data: Entur and VBB via
transport.rest. Dot Link normalizes the responses; no provider endorses it.
