# Geographic location context

Design and feasibility record for [#207](https://github.com/YusukeIt0/dot-link/issues/207).
This document describes work in progress, not a shipped capability.

## Intended experience

Coordinates, measurement time and accuracy remain the primary evidence. Add
geographic reference data so Dot can understand the location without repeatedly
identifying a bare coordinate. Dot can then investigate relevant spots using its
available tools. It decides whether any information merits an announcement.

Support streets, unnamed roads, large parks, mountains and trails, forest,
water and sparse coverage in the initial outcome. Missing data is not evidence
that a place or path does not exist. Never infer a visit, exact road membership,
safe passage or a connected intersection merely from proximity or crossing lines.

No region-selection or download-management step is added to ordinary use.
Coordinate sharing and conversation continue during acquisition or failure.
There is no paid geocoding/place API dependency. Download infrastructure still
has availability, licensing and sustainability constraints.

## Ownership and dependency order

Use one integration branch with two dependent implementation children:

1. **Local geography:** source selection, bounded range acquisition, regional
   cache, validated geographic features and deterministic spatial evidence.
   Inputs are a requested area and cancellation signal; this component cannot
   enable sharing, decide whether to announce or retain raw location fixes.
2. **Location integration:** consent/session lifecycle, asynchronous refresh,
   context revisions, actual Dot delivery, optional map representation, packaging
   and affected documentation. This consumes the first child's interface and
   preserves the existing location response guards.

Complete integrated automated checks, exact-head review and Beta acceptance
before proposing main merge. The current goal ends with Beta/actual-Dot/physical
acceptance; main merge and formal delivery need later maintainer instructions.

## Data and cache contract

Resolve containing areas, nearby lines and geographic landmarks independently.
Report geometry-derived distance/direction and uncertainty, with original names
and available translated names. Do not attach a point label to an unrelated
polygon simply because both describe a park or are close together.

Use fixed geographic cells with bounded margins and a wider, coarser context
where useful. Measurements determine cell size and detail. Cache reusable map
data separately from the live fix. Track source/version, coverage, completeness,
size and last-use day; do not persist exact fixes, fine-grained visit timestamps
or a sequence of movements. Remove regions unused for 30 days and enforce a
capacity ceiling, protecting active reads. Refresh age is independent of use age.

OFF/exit/revocation cancel acquisition and discard live derived context. Reusable
map files may remain for the stated retention period; stopping sharing must not
be described as deleting them. Region contents and use days can reveal approximate
past areas. Document this change from the current memory-only location baseline,
along with distribution-host visibility of requested regions, before Beta.
Use private directory/file permissions and the existing data-deletion route.

Validate source identity, range responses, compressed/uncompressed limits,
geometry bounds and completeness before activating a cache entry. Bound network
concurrency, bytes, time, retries, decoded features and in-memory caches. Pin one
source version per extraction; do not mix index offsets from different archives.

## Location lifecycle contract

The existing location owner remains the authority for consent, lease, freshness
and current generation. Acquisition does not own a second sharing state machine.
Only acquire for a usable sharing session and an active Dot location subscription.

Return coordinates immediately. Distinguish pending, unavailable, stale cached,
ready-with-matches and ready-without-matches evidence. A completed acquisition
must be evaluated against the latest usable fix, never blindly attached to the
fix that started it. Stop, supersession and owner changes fence late completion.

Define an immutable context revision for materially newly available geographic
evidence so a prior silent decision does not prevent Dot from using the update.
Preserve idempotency of decisions on each revision, response-time freshness and
the 100-metre movement guard. Coalesce completion events and retain rate limits;
do not generate an event for every tile, retry, unchanged cache hit or phone fix.
Recent announcements remain available to avoid repeated remarks.

Map images are a representation to validate, not a prerequisite for coordinates.
The current photo path already returns MCP image content; the location tool is
currently text/structured JSON. Validate location image receipt with the actual
provider before claiming it works. Rendering must not add hosted font requests or
misrepresent uncertainty, names or attribution.

## Feasibility evidence

Initial bounded read on October 27, 2026 used public example coordinates only.
These are one-run observations, not performance guarantees or device acceptance.

- VersaTiles dated archive `osm.20260608.versatiles`, Shortbread, zoom 14:
  seven single-tile samples (Tokyo, Bangkok, Fuji, Yosemite, Berlin, Nairobi,
  Amazon region) transferred 2,189,029 bytes across 16 range requests in 22.5 s
  total. Individual samples took approximately 1.5–4.3 s after initial metadata.
  Subsequent samples reused the archive index; this is not seven independent
  cold-start measurements or a complete surrounding-area download.
- Actual data includes roads, paths, land cover and geographic labels. Land
  polygons have a kind but no name; named park points are separate. Merged
  polygons and separate labels prevent an unconditional named-containment claim.
  The selected mountain sample does not establish complete peak-name coverage.
- Overture raw base themes retain names with geometry and are being measured.
  Initial direct GeoParquet reads timed out on large selected column ranges.
  The data child below uses Overture after verifying named geometry in public
  samples; integrated experience and broader quality remain under validation.

References: [VersaTiles extraction](https://docs.versatiles.org/guides/download_tiles.html),
[Shortbread](https://shortbread-tiles.org/schema/1.0/),
[Overture land use](https://docs.overturemaps.org/schema/reference/base/land_use/),
[Overture land](https://docs.overturemaps.org/schema/reference/base/land/),
[Overture data access](https://docs.overturemaps.org/getting-data/).

## Acceptance

Use public geographic fixtures across regions/scripts for the breadth of cases,
then one bounded configured-device/Dot session for actual delivery and ordinary
use. Distinguish simulated positions, real phone measurements, provider evidence
and physical observations. Do not require the tester to travel to every terrain.

Verify cold/warm cache, first-visit delay, movement while loading, no features,
boundary uncertainty, tile seams, parallel roads, overpasses, stop/restart,
stale fixes, connectivity failure, eviction and source refresh. Confirm Dot can
use the delivered evidence to identify the surroundings without first doing a
coordinate lookup; a mandatory unsolicited announcement is not a success metric.

Record source commit, Beta artifact identity, affected devices, results and
remaining limitations in the related issues/PRs. No real coordinates, private
conversations, identifying endpoints or raw runtime logs belong in public records.

## Data implementation under review

The data child uses official Overture GeoParquet releases, with no geocoding,
places, search or paid API. A daily cached catalog selects one immutable release;
base `land_use`, `land`, `water` and transportation `segment` supply geometry and
names. Individual trees, generic land extents, rail networks and the places theme are excluded. Source availability
and completeness remain external dependencies. The Fused mirror was not selected:
its public release listing ended in May 2026 at measurement time.

The Mac downloads selected column ranges from the official Azure distribution,
using a 0.02-degree cell and approximately one-kilometre margins. Dateline margins
are split. Polar fixes beyond 85 degrees retain coordinate-only behavior. Large
features, dense detail and unsupported geometry can be omitted; returned evidence
states this limitation. Nearby named streets are retained alongside nearer unnamed
paths. Map labels are untrusted reference data, never instructions.

Acquisition is isolated in a Node worker. Each acquisition allows at most three
concurrent requests, 80 MiB, 500 requests and six minutes; an individual response
has a 30-second timeout. Response status, exact range and decoded-size/geometry
limits are checked. Roads, land use, land and water arrive progressively. There is
no assumption that initial acquisition is fast or that all themes succeed.

Reusable source ranges and normalized regions share a 256 MiB / 2,048-file cache.
Source chunks align to fixed file offsets so overlapping queries reuse bytes. Files have checksums and owner-only permissions. Use timestamps are rounded to a
day, unused files expire after 30 days, and capacity eviction prefers older use
days. Normalized regions refresh after seven days independently of use time;
source bytes are tied to immutable release URLs. Maintenance runs at startup and
every six hours while the relay runs, including when sharing is off. It resumes
on the next launch if the relay is not running. A stopped worker is aborted and
terminated; no exact phone fix is persisted by this component.

A Bangkok public example established named park containment and nearby internal
paths. A preliminary 0.02-degree-cell run reused 21.5 MB of earlier source ranges
and fetched another 19.0 MB in 163 seconds; this is **not** a cold-start result.
An immediate repeat read 40.5 MB from cache, transferred zero network bytes and
finished in 2.1 seconds. Normalized region reuse avoids that repeated parsing.
The earlier narrow-bounds lazy-column measurement transferred 33.1 MB in 270
seconds. Dense-road limits are reported as partial coverage. Mountain and other
regional samples, integrated lifecycle behavior and actual Dot acceptance remain
under validation.

Run an explicit public example with `node scripts/measure-geography.mjs fuji
/path/to/temporary-cache` (one line). This network measurement is separate from
automated tests and does not accept an arbitrary live phone coordinate. Other
examples are `bangkok`, `tokyo`, `yosemite`, `berlin`, `nairobi` and `amazon`.
Attribution and data licensing follow [Overture's theme-specific source
requirements](https://docs.overturemaps.org/attribution/); cached data is separate
from Dot Link's MIT-licensed code.

## Model-case validation

The data resolver has deterministic cases for immediate coordinate-compatible
pending state, partial/completed evidence, movement within a cell, movement to a
new cell, late progress after stop, returning to a cached area during another
acquisition, offline interruption/retry, independent refresh age, empty coverage
and unsupported coordinates. Returning to a known area must not wait for an
unrelated download. An old area's progress cannot replace the current area's
reference data.

Geometry cases cover named and unnamed areas, polygon holes and disjoint parts,
both sides of uncertain boundaries, the antimeridian, parallel/crossing lines,
dense unnamed paths hiding named streets, and invalid/oversized geometry. These
are evidence and lifecycle checks, not a claim of complete worldwide map coverage.

The Mount Fuji public sample returned Fuji-Hakone-Izu National Park containment,
Mount Fuji and Kengamine references, nearby trails, and an uncertain crater-rim
boundary. A cold attempt reached the six-minute bound; a cached continuation
fetched 20.9 MB, reused 47.3 MB and completed in 166 seconds. This confirms useful
content and recovery, while first-visit latency remains a limitation. The public
measurement script reports partial progress even if a later theme times out.

Provider-visible event timing, decision idempotency, freshness/consent revocation,
ordinary conversation during acquisition, and actual Dot/device behavior belong
to the dependent integration validation. No automatic test substitutes for that
bounded physical acceptance session.

Review follow-up: stale complete maps remain available throughout an incomplete or
failed refresh. Genuine movement cancels the old region acquisition, while an
approximately 200-metre cell-edge margin avoids cancellation from boundary jitter.
Already downloaded source bytes remain reusable. Each worker result identifies
the fix it resolved; the loader rejects results for an older requested coordinate.
The model suite also covers refresh failure and cell-edge jitter explicitly.

Retries preserve any existing same-area evidence, including a partial first load.
Repeated failures back off from one minute to one hour; they do not continuously
replace useful data with roads-only progress. Continuously used, stationary areas
still become stale and refresh after seven days. Cache maintenance has one active
owner: the worker while running, otherwise the loader. Chunk writes use an
in-memory size/use index instead of rescanning every file, and temporary files
retain their real modification time until activation.

Rapid A→B→A movement now restarts a cancelled acquisition without treating it as a
network failure or imposing failure backoff. Both rejection and late resolution
of the cancelled operation are covered, including suppression of late progress.

Geometry reads narrow the selected row span so unrelated compressed pages can be
skipped. A file has a 96 MiB cumulative Zstandard decoded-byte budget and each
page retains a 16 MiB output cap. Metadata columns are limited to 32 MiB declared
decoded data per row group; geometry to 128 MiB. Selected compressed column ranges
are limited to 64 MiB. The downloader fills one result allocation from bounded
batches rather than retaining and copying the whole range repeatedly. These
limits can still produce partial coverage for very large geographic features.

A public Amazon-region fixture returned a nearby unnamed river (74 m), the named
Igarapé Tarumã Mirim (709 m), and an unnamed path (928 m). It did not establish
river-area containment. The earlier compressed-range/decoded-size rejection was
removed with bounded narrow-row reads and single-allocation range assembly.
A 13-minute worker session still did not finish acquisition; a subsequent cached
continuation fetched 1.05 MB, reused 105.1 MB and completed in 10.8 seconds. The
actual resource-limited worker then returned the same references from source
cache in 1.0 second, and from a normalized region in 133 ms. These are successive
warm observations, not independent cold-start measurements. Initial latency and
very large-feature coverage remain explicit limitations.

Worker crashes also use increasing one-minute-to-one-hour delays, retained by
the loader across replacement workers. A ready result or explicit stop resets
that crash history. New fixes during backoff report unavailable rather than pending.
Real worker-exit model tests cover escalation, status and reset.

## Location integration under review

The location owner now starts geographic acquisition only with enabled, fresh
sharing and an active Dot subscription. Coordinates are returned immediately.
`context.geography` carries status and any available source-attributed references;
map data is explicitly untrusted reference material in the tool description.
There is no map-image attachment, and no image-receipt claim.

A material geographic update creates a new context ID while preserving the phone
measurement and arrival times. Decisions on earlier reads remain idempotent.
Geographic notifications coalesce under the existing 30-second interval and
pending-event window. A silent decision before acquisition completes does not
consume later references, and a response to an older read cannot consume a newer
geographic event. A newer coordinate-only read can consume an older geographic
event using context creation order, without waiting for the retry window.
Unchanged cached features and small distance changes do not
create repeated geographic notifications. No additional download-management UI
is required.

Consent, owner authorization, lease, measurement freshness and subscription expiry
remain owned by `LocationContext`. Expiry timers stop acquisition even without a
further phone update. Stop, unsubscribe, revocation and shutdown clear live
geographic context. One `LocalGeography` owns the cache directory; uninstall stops
services before moving its files to Trash. The location-sharing disclosure covers
the approximate-area and retention implications in all seven interface languages.

Integration model tests cover delayed stationary enrichment after silence,
coalesced phases, older decisions overlapping newer events, unchanged references,
movement fencing, partial fallback, empty coverage, and every stop/expiry path.
A cached real-worker fixture reaches both MCP text and structured content while
ordinary messages still work. These checks are not actual-Dot or physical-device
acceptance; those remain required on the exact Beta artifacts.
