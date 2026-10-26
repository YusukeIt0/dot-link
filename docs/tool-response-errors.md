# Tool response reasons

## Response mutation contract

This contract covers `reply_to_g2`, `send_message_to_g2`,
`announce_notification_to_g2` and `set_notification_disposition`. Implementation
is tracked under #198, with integration and delivery tracked by #197. It follows
the existing `respond_to_location` reason envelope without changing its reasons.

Expected rejections use JSON-RPC `error.code: -32602` and a fixed
`error.data.reason`. Unexpected failures use `-32603` with `internal_error`.
Messages are fixed English protocol guidance, not localized application UI.
Success payloads and identical-retry behavior remain unchanged. An unknown
record is not necessarily expired; a reason identifies the observed condition,
not an inferred root cause.

| Operation | Reason | Meaning and next action |
| --- | --- | --- |
| Reply | `utterance_unknown` | The utterance is unavailable. Re-read pending utterances; do not substitute a proactive message for this reply. |
| Reply | `reply_conflict` | A different reply already exists. Do not overwrite it; identical retries remain allowed. |
| Proactive message | `message_id_conflict` | A retained ID already has different text. Do not change the ID merely to bypass this conflict. |
| Notification announcement or disposition | `notification_unknown` | The notification is unavailable. Re-read pending notifications; do not invent a replacement ID. |
| Notification announcement | `notification_silent` | The notification was marked silent. Do not bypass that decision by sending a proactive message. |
| Notification announcement | `announcement_conflict` | A different announcement already exists. Do not overwrite it; identical retries remain allowed. |
| Notification disposition | `notification_already_announced` | An announcement already exists. It cannot be changed to later or silent. |
| All four | `invalid_arguments` | Correct the arguments for this operation using its schema. |
| All four | `internal_error` | An unexpected failure occurred. The outcome is not confirmed; do not change identifiers or content to force a retry. |

## Ownership

- `bridge-response-error.ts` owns conversation/proactive rejection vocabulary;
  `notification-response-error.ts` owns notification rejection vocabulary.
  Each feature validates its own arguments and throws a typed rejection at the
  point the condition is known. Never classify errors by matching their text.
- `tool-response.ts` owns only the safe rejection base type and conversion of a
  selected invocation into the existing result/error envelope. It does not
  know tool names, validation schemas, feature state, retry rules or telemetry.
- `http.ts` selects an enabled tool before invoking that adapter. Missing or
  invalid arguments reach the selected feature's argument check. Routing reasons
  are defined below. Metadata in the call envelope remains supported.
- `respond_to_location` retains its existing boundary. If its bridge callback
  fails with a new conversation rejection, that remains a location
  `internal_error`, not a leaked conversation reason.
- No catch-all classification of Zod errors: only an operation's own failed
  argument parse is `invalid_arguments`. An execution-time validation failure
  is an internal failure.

## Persistence and retries

Bridge replies/proactive messages commit replacement state after persistence.
For the two scoped notification mutations, also persist replacement state before
publishing it in memory. A failed write/rename must not create an in-memory
decision that makes the next identical retry falsely report a saved result.
Other notification operations are not refactored by this work.

An internal failure response does not promise rollback of every possible side
effect. Preserve existing idempotency and retention limits, and do not introduce
a universal retry loop. Acknowledged bridge storage is not physical display or
proof that the owner heard an announcement.

## Boundaries and acceptance

No new application-screen codes, asynchronous result events, diagnostic logs,
developer upload or consent controls are added. Responses work with Debug mode
off. Future diagnostics may consume approved reasons, but must not export raw
tool results or make normal operations depend on an uploader. Asynchronous event
delivery, microphone, transcription, display and connection failures need
separately scoped contracts.

Verify every scoped rejection through RPC and the HTTP envelope, unchanged
successful responses, identical/conflicting retries, and recovery after a failed
write/rename. Test unknown/disabled tools, internal validation exceptions,
location callback conflicts and the existing callback challenge contract.
Responses must not contain supplied text, identifiers, paths, URLs, secrets or
raw exception details. Record exact-build runtime acceptance separately from
fixtures and actual Dot-provider observations. Complete affected-component
formal distribution and normal update verification before closing this stage.

## Read, subscription and routing contract (#203)

The four reads (`get_status`, `get_pending_utterances`,
`get_pending_notifications`, `get_location_context`) use `invalid_arguments`
for their own input validation and `internal_error` for unexpected execution
failures. Omitted arguments remain equivalent to `{}`. Empty queues, unavailable
location context and unsubscribed status remain successful results. Photo content
in pending utterances is preserved.

For `events/subscribe` and `events/unsubscribe`, all three event domains use:

| Reason | Meaning and next action |
| --- | --- |
| `invalid_arguments` | Correct the selected event's arguments/delivery envelope. |
| `callback_destination_rejected` | Supply a valid, allowed HTTPS callback URL. |
| `invalid_signing_secret` | Supply a valid webhook signing secret. |
| `subscription_conflict` | Another callback is active. Unsubscribe it only if replacement is intended. |
| `challenge_failed` | Callback verification failed; inspect the callback endpoint before retrying. This retains code `-32015` and message `CallbackEndpointError`. |
| `internal_error` | An unexpected failure occurred; the outcome is unconfirmed. |

The destination, secret, conflict and challenge reasons apply to subscription
creation/renewal. Unsubscription keeps its existing no-op success for an absent
or different URL. Successful renewal of the same URL and existing TTL semantics
remain unchanged. Persist subscription replacement/removal before publishing the
new in-memory state; a failed write/rename leaves the previous state available
for an identical retry. This does not promise rollback of external verification
or subsequent delivery side effects.

Routing validates the name before selecting a feature. Missing/malformed names
use `invalid_arguments`; unknown names use `unknown_tool` or `unknown_event`;
recognized but disabled features use `tool_unavailable` or `event_unavailable`.
The latter names are not reported as unknown. Callers should refresh `tools/list`
or `events/list` and use an available operation. Envelope metadata remains
accepted. These routing reasons supersede the Stage 1 generic routing behavior.
Expected rejections use `-32602`; unexpected failures use `-32603`.

Feature-owned read/subscription validation throws fixed typed rejections.
The shared RPC adapter only converts results and safe rejections; the
subscription adapter alone preserves callback verification errors. Location
response handling remains separate so downstream conversation errors cannot
escape as location response reasons. HTTP authentication, JSON parsing,
unsupported RPC methods, asynchronous delivery results and device-screen errors
are outside this extension. No new UI strings or diagnostic collection is added.
