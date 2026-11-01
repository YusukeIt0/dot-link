# Synthetic history conversation preview

First testable stage of [#264](https://github.com/YusukeIt0/dot-link/issues/264),
implemented under [#265](https://github.com/YusukeIt0/dot-link/issues/265).
This is a development fixture, not enabled personal-location history.

## What is ready to test

The isolated preview feeds synthetic observations into an in-memory history owner,
groups candidate stays and movement observations, and exposes a bounded
`get_location_history` read through the existing relay RPC/tool-response code.
It reuses `distanceMeters` and `geographicEvidence`; map names and geometry in this
fixture are invented, never downloaded or represented as real venues.

The normal `server/main.ts` does not construct a history provider. Normal discovery
does not advertise the tool; stale calls return `tool_unavailable`. Neither phone
upload schemas nor consent, SDK sampling, current-location guards, persistent
personal data or normal reply/event flows change. The runner reads no installed
keys, pairing or geography cache and contacts no external service.

The preview exposes only authenticated history reads and discovery. It has no
phone ingestion, callback subscription, proactive event or G2-send endpoint.
This lets an existing Dot test the evidence in its conversation without sending
synthetic context to the daily glasses connection. It does not establish the
event-triggered G2 response flow; that remains an explicit later test.

## Local run

Use the repository's supported Node runtime and installed dependencies.

```sh
node scripts/history-replay.mjs --check --reference 2026-11-02T12:00:00Z
node --test tests/location-history.test.ts tests/history-preview.integration.ts
```

`--check` starts the isolated loopback listener, verifies authenticated discovery
and one history read, then removes its temporary state and credential. The output
contains counts/status only and explicitly says actual Dot has not been verified.

For an interactive consumer test, leave the following process running:

```sh
node scripts/history-replay.mjs --scenario walk --port 3475
```

The output supplies the loopback `/mcp` endpoint, fixture reference time and an
owner-only credential-file path. The token itself is never printed. Read it only
through the test connection's credential mechanism; do not put it in chat, Git,
URLs or command-line arguments. A new invocation creates a new credential and
fixture. Ctrl-C removes temporary state and credentials. A hard kill may leave a
`dot-link-history-preview-*` temporary directory; after verifying its process has
exited, remove that specific directory. No launch agent or installed app is added.
An occupied requested port fails rather than replacing a process.

The default reference is the launch time, fixed for that run. To reproduce a
weekday case, use `--reference 2026-11-02T12:00:00Z` (Monday). The fixture has a
stay 26 hours before the reference and recent stays/turns/return, using UTC as its
explicit synthetic local timezone. The clock is intentionally frozen: expiry
tests advance it programmatically, not by waiting seven days.

Scenarios:

| Scenario | Evidence |
| --- | --- |
| `walk` | Prior-day stay, garden stay, east-then-north movement, another stay, return after an unknown interval |
| `partial` | Missing moving points and poorer accuracy on one section |
| `stopped` | Recording disabled during part of the movement, with those points rejected |
| `empty` | Authorized read with no history |
| `revoked` | Historical access disabled; no observations returned |
| `no-map` | Observations and episodes without geographic references |

## Existing-Dot test connection

The local endpoint alone is not reachable by a remote Dot. Configure a **separate,
explicit test transport/connection** using the existing tunnel infrastructure only
when that test setup is authorized. Point it at the preview port with its own
credential. Do not reuse operational keys, replace the daily relay, change its
subscriptions, or attach a public unauthenticated tunnel. No transport is provisioned
by this script. Remove the temporary registered test connection/transport after
the session so expired fixture tools are not left available.

Refresh tool discovery in the actual existing Dot and confirm that
`get_location_history` comes from `dot-link-synthetic-history-preview`. A registration
page or local successful RPC does not prove that the consumer adopted the tool.

Establish the frame once: this is fictional test history, use its reference time
for relative dates, do not treat it as the owner's real activities or a fact to
remember. Ordinary conversation/memory and available search remain with Dot;
synthetic names must not be searched as though they were real establishments.
The test is about how optional evidence is used, not acting out a prescribed answer.

Suggested prompts, adapted to the user's normal language:

- “What was that place earlier?”
- “Which road was I passing before that?”
- “Was that the same place as yesterday?”
- With the Monday reference: “Where was I on Sunday?”
- For a cafe-memory case, first mention an explicitly fictional cafe in the test
  conversation, then use the empty/partial scenario and ask about it. No venue
  directory should be required. This tests conversational use, not a guarantee
  about provider long-term memory.
- Ask an unrelated ordinary question. History should not become a prerequisite.

Record actual tool selection and relevant bounded reads, grounded answers or
minimal necessary clarification, and whether gaps/stops cause needless disclaimers
or setup prompts. Do not prescribe calling the tool in every prompt: that would
not establish natural selection. Keep personal conversations out of public reports.
Data already returned to the provider is not deleted by clearing this local fixture.

## Contract and limits

`start_at` is inclusive and `end_at` exclusive, both instants with explicit offsets.
Omitting them uses the retained seven-day window through the reference time.
Intervals are limited to seven days; `detail` is `summary` (default) or
`observations`, and `limit` is 1–50 (default 20). To continue, send only the opaque
`cursor`. Ingestion, expiry, deletion, recording changes or access changes invalidate
cursors; retry with a new optional bounded query, not an assertion that data remains.

Results have synthetic provenance, a reference time, observed coverage and bounded
entries. `empty` and `unavailable` are ordinary results, not instructions to ask
the user to fix anything. A retained observation must be newer than the 168-hour
cutoff. Reading does not turn recording on. Revocation hides all observations;
recording stop leaves separately enabled reads available. These are fixture
controls, not a shipped consent UI or a shortcut around production authorization.

The preview caps storage at 10,000 observations (evicting oldest with an explicit
omission flag), pages at 48 KiB and cursor state at 50 entries. It has no persistence;
restart creates a new synthetic scenario. Summary bounds describe first/last
observations, never exact arrival/departure or proof of venue entry. Default grouping
uses a two-minute gap, three-minute candidate stay and 35 m radius/accuracy bound;
these are tunable experiment parameters, not validated physical detection thresholds.
Summary geography samples are bounded near-reference evidence; observation detail
retains the turn-by-turn measured points without inventing a connecting route.

## Verification and privacy boundary

Automated checks cover observation ingestion, turns/revisits, stationary jitter,
poor accuracy, gaps/stops, duplicate/reordered points, interval/timezone queries,
expiry, deletion, access revocation, output/capacity bounds, authenticated HTTP,
absence of callbacks/device writes and the normal relay's unchanged discovery.
They do not establish natural Dot behavior, iOS background acquisition, battery
performance or actual G2 display. Persistent restart/rollback, real consent UI,
live ingestion and full mixed-version rollout belong to later implementation.

Documentation audit for this stage: the current privacy promise that no exact
phone-coordinate trail is stored remains true. This runner accepts only explicitly
synthetic observations in memory. No user-facing release note, permission, consent
translation, dependency version or Even Hub form changes are needed to run this
isolated developer fixture. Before stage 2 enables personal history, update the
privacy/geography wording, all consent languages and independent Even declarations
as required by #264, and verify mixed-version payload negotiation. No paid API,
alternative map platform or local business directory has been added.
