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

Response guards remain unchanged. Location announcements use a fresh
`respond_to_location` context; question answers also carry their question ID.
History-derived G2 answers use `respond_to_history` with an existing question so
deletion, access and expiry are checked again. The current implementation does
not provide guarded proactive historical announcements. Reading history within
an activity must not bypass that boundary through location or generic sends.

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
it. These fields do not establish the device's UTC offset. Source-local hour
questions can use the preserved device clock. Dated, already-permitted timezone
evidence or clear same-local-clock conversation may support a qualified association
with an event, but does not prove exact clock alignment. The AI must distinguish
that inference from an established correspondence, especially across travel or
clock changes. No additional timezone collection or history-sharing requirement
is introduced; unavailable optional evidence does not require a setup prompt.

The encrypted v1 scalar-value shape remains compatible with earlier builds.
Existing records without full-response summaries are labeled `legacy_stored_samples`;
their old first-2,500 cap is not retroactively treated as complete input. A later
normal acquisition replaces that record with an all-valid-returned-sample summary.
The AI uses coverage and time uncertainty internally, mentioning them only when
they materially change the answer. A heart-rate change alone does not establish
stress, fatigue, emotion or illness. Neither a new reading nor an available summary
requires a notification. Use comparable observed periods when comparing days.

Source semantics: [Polar continuous-heart-rate schema](https://www.polar.com/accesslink-api/#continuous-heartrate).

Explicit Keychain authorization allows up to five minutes for the owner to answer
the macOS prompt; background reads remain noninteractive and bounded to 15 seconds.
The Mac settings request waits for that authorization result before reporting it.
