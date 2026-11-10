# Context in autonomous activities

The same Dot can select optional context within its existing activity, using the
owner's current purpose, conversation and permissions. A separate question or task
for each source is not required. `get_location_context` returns product-owned
`activity_guidance` alongside the evidence, so an existing activity that already
reads context receives the guidance even if its cached tool description is older.
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
as reasoning evidence. Ordinary answers should not start with stock accuracy or
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
