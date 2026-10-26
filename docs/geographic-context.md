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
  Source selection remains open pending bounded, repeatable acquisition and
  quality measurements. No source is selected based on schema alone.

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
