# Tool response reasons

## Stage 1 contract

This contract covers `reply_to_g2`, `send_message_to_g2`,
`announce_notification_to_g2` and `set_notification_disposition`. Implementation
is planned under #198, with integration and delivery tracked by #197. It follows
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
  selected tool invocation into the existing result/error envelope. It does not
  know tool names, validation schemas, feature state, retry rules or telemetry.
- `http.ts` selects an enabled tool before invoking that adapter. Missing or
  invalid arguments reach the selected feature's argument check. Unknown tools,
  disabled notification tools and unrelated malformed calls keep their existing
  generic rejection. Metadata in the call envelope remains supported.
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
tool results or make normal operations depend on an uploader. Future event,
microphone, transcription, display and connection work needs a separately scoped
contract; it is not required for this stage.

Verify every scoped rejection through RPC and the HTTP envelope, unchanged
successful responses, identical/conflicting retries, and recovery after a failed
write/rename. Test unknown/disabled tools, internal validation exceptions,
location callback conflicts and the existing callback challenge contract.
Responses must not contain supplied text, identifiers, paths, URLs, secrets or
raw exception details. Record exact-build runtime acceptance separately from
fixtures and actual Dot-provider observations. Complete affected-component
formal distribution and normal update verification before closing this stage.
