# Context in autonomous activities

The same Dot can select optional context within its existing activity, using the
owner's current purpose, conversation and permissions. A separate question or task
for each source is not required. All decision-factor reads return product-owned
`conversation_guidance` through the shared MCP dispatcher, including partial or
unavailable evidence and rejected reads (in error data). Direct weather queries
and existing activities therefore receive the current contract even when their
cached tool descriptions are older. Fresh location results additionally retain
`activity_guidance` for source selection and guarded response routing.
This is distinct from untrusted map labels and provider data. Host behavior still
requires validation; returning guidance does not prove that Dot followed it.

Use the included geography and weather first. For an outdoor plan, consult
additional forecasts only when useful. For a walk toward a known destination,
walking/terrain evidence can help assess distance or slopes. Do not invent a
destination or fetch all sources just because the tools exist. Recent history can
help reasoning when the conversation or memory is insufficient. Missing optional
evidence need not interrupt the conversation or prompt another settings request.
Silence is a valid result.

Keep numerical accuracy, timestamps, source, missing values and model limitations
as reasoning evidence. A generic possibility of error does not by itself justify
a spoken caveat or a routine verification chore. For example, do not append
"local rain may differ; check the sky" to an ordinary walk answer solely because
the source is a forecast. Mention a concrete relevant limitation when the evidence
actually calls for it. Ordinary answers should not start with stock accuracy or
model-versus-reality disclaimers. When uncertainty changes the actual choice,
briefly explain the consequence, such as being unable to distinguish which side
of the road a location refers to. Do not assert an unverified observation, route
access, venue visit or personal effort as fact. These are internal reasoning
constraints, not a script to recite. Do not routinely say that location cannot
prove a venue entry or visit. Answer using supported facts; ask whether a visit
occurred only when that distinction changes the answer and the conversation
does not already resolve it.

For a response using more than one factor, `respond_to_context` composes the
existing source guards and stores one message through the normal bridge queue.
Each available result includes `response_context` with its argument mapping and
`expires_no_later_than`; revocation or source changes may invalidate it sooner.
Use only receipts that materially influenced the reasoning or answer, including
unspoken evidence behind a recommendation. Do not fetch or attach unused sources.
A current location `context_id` covers its attached geography/weather. Explicit
weather and finished mobility reads also return `weather_read_id` and
`mobility_read_id`; include these in their respective plural arrays. Current-weather
and mobility receipts must accompany their returned `context_id`. Specified-place
weather can be used without current-location sharing. Health and recent-place
reads supply `health_read_ids` and `history_context_ids`. Each array is bounded to
eight receipts; duplicates/order do not change retry identity.

All selected guards run again inside the bridge's commit queue, immediately before
storage. Revocation/deletion, expiry, movement and attached phone-clock history
fences therefore reject the entire response. Source-specific errors guide a new
read and reconsideration; never send the old text through another route. A newly
considered answer can omit an unavailable source if the remaining evidence supports
it. The bridge retains current-location client expiry and associates a question
answer with its original `utterance_id`. Identical retries use one deterministic
message identity; conflicting decisions are rejected. With a current location,
both response routes share the location/question decision identity and serialize
their commits. Changing receipts or switching routes cannot create a second
decision for that location/question. Retry through the original route with the
original receipts; a new location or distinct question remains independent. Each
health read retains its existing one-decision rule across both routes, including
when several health reads contribute. A later question can use a fresh health read;
a silent decision does not consume the question itself. No extra user setting,
collection or AI reasoning engine is introduced.

`silent` writes no message and omits text/question ID. It can acknowledge an
independent location activity without consuming a question answer. A user's
question should still receive an answer from available evidence. Recent-place
history announcements continue to require an existing question; combined replies
do not enable proactive historical claims. Individual-source response tools remain
compatible. Conversation preferences and already-available AI memory need no new
Dot Link receipt. Notifications retain their separate disposition/announcement
contract and are not receipts for this operation.

Verify ordinary nearby guidance, useful walking/weather selection, relevant
history reasoning and silence with the actual existing Dot. Keep evidence of
guidance delivery distinct from evidence of a particular tool choice or reply.
Provider acquisition and unchanged device transport need not be repeated solely
to validate wording. Never edit one person's activity as a substitute for this
product behavior.

## Shared decision-factor contract

Start from the human decision: external environment, personal state, intent and
existing memory/preferences are perspectives for choosing useful evidence, not
requirements to build four collectors. Dot Link acquires and structures permitted
evidence. The existing Dot chooses relevant factors and how much to say, or whether
to remain silent. This applies to current and future factors.

Use numbers such as temperature, humidity, time and distance when they help the
current request. Do not require a numeric report, hide numbers, force a suggestion,
or impose a fixed phrase. Provider names, acquisition details and attribution stay
available as evidence; explain them when requested or when they matter to the
answer. Their presence in a result is not an instruction to read them aloud.
Preserve source/license surfaces and material limitations.

### Adding a factor

- Define its tool with `decisionFactorTool` in `server/context-guidance.ts`; keep
  factor-specific consent, acquisition and response constraints in its description.
  The helper supplies the common conversation and evidence-presentation policy.
- Register its definition and reader together in the `factors` list in `rpc`
  (`server/http.ts`). Catalog availability and calls share this registration;
  `decisionFactorResponse` adds the short versioned contract once at the result
  boundary. Do not duplicate the full location activity instructions, inject policy
  into provider data, or create a separate dispatch branch that bypasses this path.
- Extend `tests/context-guidance.test.ts` with the new factor. Check catalog and
  result delivery, missing data, rejection semantics and unchanged evidence, not
  copied phrases or a fixed AI answer. Keep acquisition/response-guard tests.
- Verify the deployed relay, registered connector and existing consumer. A policy
  version or fixture pass proves delivery structure, not model behavior. Use browser
  Dot for conversational checks; reserve device checks for affected device behavior.

For weather, check ordinary conditions, walk timing, explicit temperature/humidity,
and an explicit source question. Then check relevant location/geography, mobility,
history and combined-factor conversation. Record source/build and actual selection,
reply or silence separately from policy delivery. Reuse unchanged acquisition and
transport evidence; brief relevant caveats remain acceptable. Do not paste the new
policy into the test prompt or alter a personal activity to make the test pass.

## Selective history (unreleased Mac feature)

The development branch includes protected local storage for future opt-in
archives. Existing grants keep their original scope. A separate encrypted
authority holds the owner, duration and a random key for each source. The Mac
opens its authority key with the Secure Enclave after first unlock. A stop
invalidates outstanding reads. Deletion retires the source key before removing
the evidence files. On restart the relay finishes interrupted cleanup and
expires records even when recording is off. A code downgrade leaves these
files outside the app bundle.

The non-health archive encrypts source fields, timestamps and identities.
Its on-disk indexes expose opaque grouping, row counts and ciphertext lengths.
Polar keeps its own protected storage. Restoring an old evidence file alone
cannot recover a deleted generation. Restoring both the old authority and
evidence from a full backup on the same Mac can recover it. Local deletion
cannot retract information already sent to Dot.

`get_factor_history` selects fields from saved phone, Polar, weather or
walking/terrain evidence. Each request covers up to seven days within the
retained history. Give `start_at` and `end_at` as instants with explicit UTC
offsets. The start is inclusive and the end is exclusive. Observation windows
stop at the time of the read. For weather alone, a forecast known in the past
can have a validity time in the future.
Under `fields.location`,
select from `position`, `motion`, `clock` and `geography`. Under `fields.polar`,
select the relevant metrics by name. A comparison
of two periods can start with a narrow selection for each, followed by a request
for more detail only where it matters.

For weather, select fields such as `temperature` or `precipitation`. To ask
what the forecast said at a particular time, pass that instant as `known_at`.
The requested interval selects forecast validity and the cutoff limits which
editions were available. A forecast for a requested place gives no evidence
that the person went there. For mobility, ask for `plan` to compare planned
walks or `terrain` to compare derived terrain estimates. Further detail can
include endpoints, steps, geometry and terrain samples. Acquisition happens
only through the existing live source. Historical reads contact no provider.

Weather and route archives start off. The paired owner's separate archive grant
allows the connected Dot to read saved evidence. An inactive phone or a stale
position does not prevent those historical reads. Turning off the history
source blocks reading and recording. Deleting the source also erases its
retained records. Live weather and directions can still work with their
archives off.

Location history describes recorded phone fixes and any saved geographic
references. Polar observations retain their own timestamps or source-local
dates. A date-only record can overlap the requested hours without identifying
the hour of a measurement. Each source reports its own coverage and missing
values. An empty period, a stopped source or a gap can be handled in the
conversation using whatever evidence is available. The latest registered Polar
profile remains accessible through its separate current-profile read.

Version 1 returns a separate page for each requested source. To continue one
selection, send only its `source` and its `next_cursor` as `cursor`.
For a combined G2 answer, supply the contributing sources' response references
to `respond_to_context`. The Mac rechecks their authorization and expiry.
An answer based on recent-place, forecast or route history requires the existing G2 question and its
`utterance_id`. A history read neither acquires new source data nor sends a
message. The contract can be exercised with synthetic records through MCP.
For connected-Dot acceptance, compare the requested periods and fields in the
synthetic server's trace with the answer in the conversation. Include a follow-up
and a period in which only one source provides evidence.

## Polar health context

`get_health_context` selects categories and a time window of 1–168 hours; the latest
registered profile is separately opt-in per read. Use it within the current activity
when sleep, activity, recovery or physiology helps the person's question or situation.
Combine useful evidence with conversation, current place, weather or mobility; do not
fetch every factor or force a report. Missing data, source dates and provider-derived
scores are reasoning inputs, not a routine disclaimer. Silence remains valid.

Enabling health sharing in Even requests `health.updated` reception from the existing
Dot through the same owner-control mechanism as other sharing choices. The event
contains an opaque update identifier, not health values. Acquisition only notifies
normalized changes. No second user-managed subscription switch is introduced.

Health-derived G2 output uses `respond_to_health` and the returned short-lived read
receipt. The response rechecks consent, owner authorization, revision and expiry.
Question answers include `utterance_id`. OFF/deletion/account change invalidates
receipts. Identical retries are idempotent; silence cannot be changed to speech using
the same receipt. The existing history-answer restriction still applies when recent
places contribute. When Polar information actually contributes to an answer or
suggestion, Dot is instructed to identify Polar naturally once in the conversational
text, using the conversation language. A context read alone does not trigger a credit
on an unrelated reply. There is no fixed introductory formula or automatic footer;
Dot Link forwards the text unchanged. This health-specific instruction does not change
weather/location attribution guidance. If read-aloud is enabled, the conversational
source mention is spoken as part of the answer.

This is the selected conversational UX, not a verified determination of compliance
with Polar's detailed Brand Guidelines. Exact attribution requirements and actual
existing-Dot behavior remain to be verified before final acceptance.

Activity context exposes Polar daily activity as `activity_goal_completion_percent`,
with an explicit percent unit and daily-goal meaning (100 means the goal is met).
Values above 100 are preserved. The read projection also covers existing encrypted
records; it does not reinterpret the value as a health or recovery score.

Heart-rate context provides `heart_rate_summary` for each source date, including
hourly observations. Summaries cover all valid samples in the returned API day,
before selecting at most 96 detail points across the time-ordered span. The first
and last points are retained. Ranges and unweighted sample means describe those
samples, not live readings, resting heart rate or guaranteed whole-day extrema.
Polar documents these as period-average samples in device time; missing offsets
remain unknown. `hours` selects potentially overlapping device dates rather than
clipping samples to an invented UTC interval. Conservative measurement retention
is unchanged. Gaps and absent hours are not interpolated.

Health reads expose `reference_time` and `requested_window` in UTC so the AI can
distinguish the conversation's reference interval from acquisition and measurement
times. Heart-rate days can overlap that interval without being exactly clipped to
it. Original Polar timestamps remain unchanged. For offset-free heart-rate and
activity times, use the record-date phone timezone as the normal interpretation
basis, including comparisons with conversational events. Do not repeat timezone
caveats or ask users to maintain clock correspondence during ordinary use.

Heart-rate and activity results include `phone_time_evidence`, projected from
existing recent-place history only when its owner matches and consent is active.
It includes no coordinates or places. Each source date includes a `reference`:
`resolved` adopts the single offset reported in uploads whose phone-local receipt
date matches the source date; `ambiguous` preserves multiple offsets; `unavailable`
means no matching offset or incomplete clock metadata. Resolution uses all selected
uploads before detail reduction. It never applies today's timezone to an older day.
Bounded spans retain timezone IDs, location-fix and receipt times, recording
boundaries, gaps and omissions. Receipt time approximates upload time, not the exact
phone clock observation. The reference is an explicit product convention, not
certified Polar synchronization, continuous coverage or a maximum error guarantee.
Across travel/clock changes, use distinguishable dated spans only for the relevant
period. Missing historical evidence or samples remain unknown; explain or clarify
only when that changes the answer. Do not require additional sharing to fill gaps.
Combined health response receipts recheck history access, deletion and expiry before
delivery. A new read after history stops can still support a health-only response.
This clock projection does not authorize historical place claims or change the
existing question-linked history response requirement.

The encrypted v1 scalar-value shape remains compatible with earlier builds.
Existing records without full-response summaries are labeled `legacy_stored_samples`;
their old first-2,500 cap is not retroactively treated as complete input. A later
normal acquisition replaces that record with an all-valid-returned-sample summary.
The AI uses coverage and time uncertainty internally, mentioning them only when
they materially change the answer. A heart-rate change alone does not establish
stress, fatigue, emotion or illness. Neither a new reading nor an available summary
requires a notification. Use comparable observed periods when comparing days.

Health tool discovery and update events explain the purpose of interpreting possible
fatigue, tension and energy without requiring an explicit self-report. Every available
health read includes `interpretation_guidance`: sleep/recovery and accumulated activity
can inform fatigue hypotheses; contextual heart-rate changes can inform tension
hypotheses; positive sleep/recovery and conversational evidence can inform energy.
These are examples, not fixed labels, thresholds or validated detection. States can
coexist; physical capacity, mood and motivation are distinct. Missing evidence is not
normality, low activity is not spare capacity, and nightly recovery is not live tension.
The guidance connects these tentative meanings to tone, pacing, suggestion effort
and timing, while preserving requested detail, choices and immediate correction.
It does not require state announcements, mood checks, shorter replies or rest advice.
The instructions travel with the product, rather than relying on a setup conversation
or persistent AI memory. Collection, retention, attribution and response guards are
unchanged. Actual conversational effectiveness requires runtime acceptance.

Source semantics: [Polar continuous-heart-rate schema](https://www.polar.com/accesslink-api/#continuous-heartrate).

Explicit Keychain authorization allows up to five minutes for the owner to answer
the macOS prompt; background reads remain noninteractive and bounded to 15 seconds.
The Mac settings request waits for that authorization result before reporting it.

### Daily health windows and activity intensity

Offset-free daily activity and recovery records, like heart-rate days, are selected
when their possible source-day interval overlaps the requested window. Their
conservative storage-expiry anchor is not a measurement time. A returned daily
value is not a rolling-window total; source dates and offset uncertainty remain.

Activity reads preserve Polar's five classifications (SLEEP, SEDENTARY, LIGHT,
MODERATE and VIGOROUS), with resting/sitting/low/medium/high explanations. All
valid distinct dated samples are counted before bounded detail is selected across
the full returned sequence. Encrypted storage keeps up to 2,500 samples per day;
tool detail shares up to 96 samples across returned days, retaining endpoints
when at least two samples fit. Reduction is explicit. These are
sample counts, not durations; missing intervals are not inferred as inactivity.
Source timestamps without offsets cannot establish UTC alignment with an event
or a different device clock. Older count-only records have no recoverable timing
and may reflect only an initial subset. A subsequent normal collection can replace
them with richer evidence; no extra collection permission is introduced.

Source: [Polar activity samples](https://www.polar.com/accesslink-api/#activity-zone-sample2).
