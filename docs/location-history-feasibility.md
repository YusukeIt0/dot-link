# Recent location and route context: feasibility

Research date: November 1, 2026. Source baseline: main
`4bdbb5a70d4f8efaf537a448474269987614990d`, matched to GitHub main.
This is a research proposal, not an implemented capability or device acceptance.
The agreed implementation plan is tracked in [issue #264](https://github.com/YusukeIt0/dot-link/issues/264).

## Outcome and assessment

Let the existing Dot retrieve evidence about recent places, stays and travelled
paths in ordinary conversation. Include route evidence in the same data design;
no separate timeline or navigation product is required. Approximately seven days
of local Mac retention is acceptable. Paid APIs are excluded.

Local retention and authenticated on-demand retrieval are technically feasible.
Useful historical road/place candidates are feasible where measurements and map
coverage support them. Continuous all-day capture, exact venue entry, complete
travelled routes and reliable spontaneous tool selection are not established.
The main feasibility questions are how useful available observations are under
actual host lifecycle conditions and how naturally the existing Dot uses them.
Complete capture is not an acceptance requirement.

### Product clarification, November 1, 2026

History is optional supporting context. Gaps and intentional recording stops are
normal; they must not cause routine disclaimers, repeated questions, prompts to
resume recording, or refusal to use the existing conversation. Dot can answer
naturally from sufficient conversation context even when location history is
incomplete. Ask only when ambiguity materially affects the requested answer.
Preserve uncertainty in the data without forcing every technical caveat into speech.
Never invent an observed path or visit to make an answer sound complete.

Venue identification should use the existing Dot's conversation/memory and its
available search tools when useful. Do not add a local business directory or
Overture Places ingestion to the initial scope. Earlier research listed Places as
an option; this clarification replaces that recommendation. Search availability
and actual memory retrieval remain provider capabilities to validate, not promises.

## Confirmed current implementation

- `src/location-sharing.ts`: requests high accuracy, 15,000 ms interval and 25 m
  distance filter. These are requested options, not measured delivery guarantees.
  The listener replaces one latest fix; a 15-second pump uploads it. Multiple
  callbacks can therefore collapse into one upload. A one-shot request is made
  when the last measurement is older than 30 seconds. No persistent fix queue.
- `src/location-fix.ts`: requires measurement time and accuracy; accepts fresh
  fixes up to 90 seconds old and accuracy up to 200 m. Optional speed/heading are
  retained. A 200 m acceptance limit does not imply road/venue identification.
- `server/location.ts`: retains current context and bounded transient reads, not
  a persistent trail. Subscription/revocation metadata persists. Old fixes cannot
  be uploaded through the current live endpoint as fresh updates.
- `server/http.ts`: existing MCP discovery/calls and bearer authentication can be
  extended. Device ingestion and MCP access have distinct credentials.
- `server/geography/overture.ts` and `types.ts`: download Overture road geometry,
  land use, land and water. Normalized features omit routing connectors and most
  routing attributes. Places/business records and railway segments are excluded.
- `server/mobility/osrm.ts`: plans walking candidates between endpoints; it does
  not recover past travelled paths. A planned path must never become historical
  evidence merely because its endpoints resemble recorded locations.
- No timezone field is present in the current location contract.

The installed SDK package is `@evenrealities/even_hub_sdk` 0.0.16, with minimum
host version metadata 2.2.10. Its shipped README/types expose one-shot acquisition,
continuous callbacks, accuracy/distance/interval options, optional altitude,
speed/heading and timestamp. The documented interface has no historic-fix query,
visit-monitoring API, persistent native backlog, or control over host background
entitlements. This is an interface observation, not proof of native internals.

## Acquisition and lifecycle limits

| Condition | Evidence and implication |
| --- | --- |
| Active host/plugin | Current acquisition/upload code exists; actual interval and accuracy still depend on the host and OS. |
| Hidden phone page | Code deliberately keeps acquisition active; hiding alone does not request stop. |
| Locked/background phone | Issue #13 records brief locked-phone updates. It explicitly does not establish sustained movement, battery consumption or long background coverage. |
| G2 plugin exit | Explicit stop is intended. The stale-source fallback expires sharing after 90 seconds without renewal; a fresh surviving source is a different case. |
| Host termination/OS suspension | Do not promise continued delivery or later native replay; the SDK contract does not establish either. |
| Mac offline/restarting | Current frontend keeps only its latest fix. Missed intermediate points are unavailable after reconnection. |
| Mac asleep/off | A future local store can retain existing records, but cannot serve Dot or perform physical cleanup while not running. |

[Apple's background-location documentation](https://developer.apple.com/documentation/corelocation/handling-location-updates-in-the-background)
explains that background execution requires host configuration and that suspended
apps do not execute normally. Dot Link's plugin cannot infer that configuration
from the presence of an SDK method. Do not apply native-app capabilities directly
to the hosted WebView.

Existing evidence: [#13](https://github.com/YusukeIt0/dot-link/issues/13),
[#59](https://github.com/YusukeIt0/dot-link/issues/59),
[geography validation](geographic-context.md),
[mobility validation](mobility-context.md). The current review did not start
location collection, read personal traces, change consent or install builds.

## Recommended evidence structure

Preserve separate, linked evidence types in a local bounded store:

1. Observations: stable IDs, measurement and arrival timestamps, coordinates,
   accuracy, optional speed/heading, source/session, consent generation and expiry.
2. Coverage: observed intervals and gaps. A missing measurement is not a stationary
   user; an unknown cause must stay unknown.
3. Derived episodes: candidate stays and movement sections, contributing sample
   IDs, bounds, quality flags and algorithm version. Retain tunable deterministic
   rules; this does not require a second AI or a semantic memory engine.
4. Geographic references: roads, areas and geographic landmarks with source
   release/retrieval date, relation and ambiguity. Keep observations distinct from
   matched geometry. Venue information can come from Dot conversation/search; a
   dedicated venue store is not required.

Retain movement samples as well as stays. Otherwise questions about a road cannot
be answered after summarization. Do not connect long gaps into an asserted route,
infer transportation mode solely from speed, or snap every point to one road.
Rail, indoor, multi-level and off-road travel may have only observed trace evidence.

Use UTC instants and capture the phone's reported IANA timezone/offset when
available, with provenance. A phone timezone is not guaranteed to be the physical
location's timezone. Dot should resolve conversational dates using available
context and clarify boundary ambiguities; a Mac timezone must not silently define
the user's Sunday. Cross-zone travel and daylight-saving boundaries need fixtures.

## Dot access and response contract

Prefer a bounded history tool on the existing MCP server. A provisional contract
accepts an explicit time interval, requested detail and a result cursor, returning
coverage, candidate episodes, uncertainty, evidence IDs and available detail.
Start with summaries, then let Dot request relevant samples/roads/areas. Avoid
injecting seven days of coordinates into every conversation.

Existing current-location response guards require a fresh location and reject
movement beyond 100 m. Historical answers need their own authorization check and
the normal pending-utterance reply path; a user must be able to ask about yesterday
without enabling current-location acquisition. Do not relax the current-location
guards to accomplish this. Recheck history permission/deletion before returning
or replying from a historical result. Previously transmitted Dot context remains
outside this local deletion guarantee.

Test actual Dot tool discovery and selection, not merely direct RPC success.
Prior mobility acceptance required tool refresh plus explicit rediscovery; restart
alone did not resolve stale definitions in that observed case.

## Source and architecture comparison

| Choice | Benefits | Costs and limits | Recommendation |
| --- | --- | --- | --- |
| Mac observations + existing local geography + bounded MCP retrieval | Reuses authentication/map acquisition; avoids sending full trails to another map service | New history store, derived evidence and access policy; map coverage/latency remain | Preferred base |
| Dot conversation/memory and available search | Reuses existing venue context; can investigate when needed | Depends on actual available Dot capabilities; search results do not prove a visit | Preferred venue approach |
| Add Overture Places by requested area | Local venue candidates | Additional acquisition, retention and maintenance | Not selected after product clarification |
| External map matching | Established trace-to-road algorithms | Sends a sequence of exact positions; public-server limits and profile/endpoint support need validation | Optional later comparison, not default |
| Local full routing/matching graph | No external trace submission | Additional graph acquisition, indexing, memory, updates and travel-mode support | Defer unless simpler evidence fails |
| Phone durable backlog | Can recover observations during Mac/network outages while the plugin executes | New phone retention/consent, bounded queue, deduplication, revocation and expiry handling; cannot fix OS suspension | Evaluate only if observed gaps impair the target UX |
| Push all history into Dot | Simple delivery idea | Unnecessary exposure/context load; difficult selective retention, no reliable recall guarantee | Not recommended |

[Overture Places](https://docs.overturemaps.org/guides/places/) supplies venue
reference data and existence confidence. That confidence is not visit confidence.
[Area extraction](https://docs.overturemaps.org/getting-data/) and
[theme-specific attribution](https://docs.overturemaps.org/attribution/) support
a potential future comparison only. It is not selected for this scope; no Places
benchmark or ingestion implementation was performed.

[Overture connectors](https://docs.overturemaps.org/guides/transportation/segments-and-connectors/)
encode graph connectivity. The current normalized cache cannot become a routing
graph by simply joining crossing lines; additional source properties are needed.

[OSRM Match](https://project-osrm.org/docs/v5.24.0/api/#match-service) explicitly
handles trace splits/outliers and provides matching confidence. This supports a
possible comparison, not proof that the currently used public foot server offers
an appropriate matching endpoint. Its [public service policy](https://routing.openstreetmap.de/about.html)
limits use and states that route requests are logged. No personal trace was sent.
Public Nominatim is not selected: its [policy](https://operations.osmfoundation.org/policies/nominatim/)
restricts systematic queries and submission of confidential/personal material.

## Storage, processing and expiry

A disposable Python SQLite experiment used synthetic coordinates only, a time
index and ten columns (IDs, two timestamps, coordinates, accuracy, speed, heading,
timezone and session). Results for continuous seven-day input:

| Interval | Rows | SQLite file |
| --- | ---: | ---: |
| 15 seconds | 40,320 | 4,567,040 bytes / 4.36 MiB |
| 5 seconds | 120,960 | 13,848,576 bytes / 13.21 MiB |

This is a sizing experiment, not the final schema, a battery test or a production
benchmark. It excludes WAL/journals, map data, derived evidence and backups. All
temporary databases were removed. SQLite is a reasonable candidate; no new runtime
dependency has been selected or installed.

Map acquisition can dominate costs: the existing recorded cold Bangkok example
took 76.639 seconds to first useful evidence and 259.079 seconds overall, with
35,130,052 transferred bytes. These historical public-fixture results were not
rerun here. Avoid a map download per stored point. Reuse cells and resolve relevant
sections on demand; never block observation ingestion on geographic enrichment.

Propose a rolling 168-hour retention boundary based on measurement time. Filter
expired records on every read, clean at startup/before access and periodically,
and expire linked episodes, cached results and cursors too. Late upload cannot
extend expiry. Decide exact rolling-period wording before implementation.
Physical removal cannot execute with the Mac off. Check updater backups, database
journals and restore paths so old history is not silently revived; local logical
deletion must not be advertised as secure erasure from all backups or Dot memory.

Separate recording permission, historical-read permission and deletion. Keep
existing per-Mac consent, owner/revocation and token protections. A short stop
control may stop recording while preserving authorized historical queries; total
sharing revocation must still close access. This policy needs explicit UX wording.

## Delivery, compatibility and simulated movement requirements

Issue #264 contains the current implementation and acceptance requirements,
including the November 1 follow-up:

- Audit the existing privacy baseline before adding personal history. Existing
  live-location/map-cache consent does not authorize history. Align multilingual
  consent, public documentation and actual Even Hub selected-build permissions,
  privacy questionnaire, retention/sharing declarations and generated PDF. Verify
  saved and published outputs independently; maintainer submission remains separate.
- Negotiate capabilities for old/new Mac and Even combinations, unknown fields,
  SDK/host availability and stale Dot tools. Preserve legacy conversation/location
  behavior; never infer history consent from an upgrade. Verify rollback, schema
  compatibility, reconnect, target-Mac changes and stale requests/capabilities.
- Replay synthetic/public movement through ingestion and retrieval with a controlled
  clock, including turns, stays, jitter, repeat visits, gaps/stops, ordering,
  reconnect, timezone changes, restart and expiry. Where feasible, let actual Dot
  query replay-backed history. Isolate/clean synthetic records and events. Replay
  is not evidence of native background acquisition, real GPS accuracy or battery use.

## Minimal validation sequence and stopping criteria

1. Synthetic-history PoC on existing Dot: immediate previous stay, Sunday cafe,
   travelled road, repeated visits, multiple venue candidates, inaccurate fixes,
   gaps and timezone boundaries. Record actual tool calls and grounded responses.
2. One bounded real acquisition session, after test scope is authorized: active,
   hidden, locked/background, stop and reconnection. Measure arrival interval,
   accuracy and gaps without publishing coordinates. Sustained battery claims
   require a longer comparable baseline; do not infer them from a short test.
3. Persistence/lifecycle checks with controlled time: restart, duplicate/reordered
   upload, 168-hour expiry, deletion, stop/revocation and backup restoration.
   Test race conditions automatically rather than asking for timed user actions.
4. Validate venue questions using Dot's existing conversation and available search,
   including a known cafe despite a missing trace, intentional stop, sufficient
   partial evidence and genuinely ambiguous candidates. Confirm that gaps do not
   automatically trigger disclaimers/questions. Compare road matching only if needed.

Proceed to product implementation when actual Dot can use the evidence naturally
and available observations improve the conversation without requiring complete
capture. Consider a phone backlog or another source only if a specific agreed
experience fails because of missing evidence;
do not promise complete all-day context. No implementation, publication, release,
new Issue/PR or device operation was performed in this research stage.
