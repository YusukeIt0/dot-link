# Even runtime ownership

The entry point coordinates the existing user experience. A module boundary should identify who owns a resource or state, not merely shorten a file. Keep application decisions together and avoid duplicating state between controllers.

| Owner | Responsibility | Does not decide |
| --- | --- | --- |
| `src/main.ts` | UI bindings, application startup/exit, execution of conversation decisions alongside input and standby | Transport queue internals or playback completion bookkeeping |
| `src/conversation-state.ts` | History, selection, unread replies, announcement bookkeeping, and pending display decisions | DOM, speech synthesis, timers, recording eligibility, or connection policy |
| `src/runtime-effects.ts` | Deferred speech, voice eligibility, standby protection and its waiting deadline | DOM/G2 presentation, transport or conversation selection |
| `src/connection-transitions.ts` | Reset/retention policy for pairing, restoration and forgetting | Transport implementation, rendering or user preference changes |
| `src/relay-session.ts` | Active relay credentials, origin recovery, request cancellation, and connection generations | User-facing status, history selection, or whether to record |
| `src/speech-playback.ts` | Queued read-aloud speech, cancellation, completion recovery, and the quiet interval before voice input resumes | Which replies to announce or whether TTS is enabled |
| `src/g2-display.ts` | One serialized G2 text-write queue, stale frame suppression, sent-content caches, and display timing acknowledgements | Which message to show or when to enter standby |
| Existing `VoiceInput`, `DisplayStandby`, `LocationSharing`, `LiveUpdates`, and history modules | Their existing capture, standby, location, receive-loop, and reconciliation policies | Unrelated UI or transport state |

## Interaction and lifecycle

1. Input capture produces a clip; the application starts recognition and decides whether to send immediately or allow review.
2. Relay requests carry the active session credentials. A connection transition cancels ordinary requests and advances the session generation; callers also guard their UI updates with that generation.
3. Incoming snapshots are reconciled with history. `ConversationState` returns announcement and display decisions; the application executes speech, progress, rendering and standby effects.
4. Playback reports whether it blocks voice input. The application combines that with recording, connection, and pending-input state.
5. Display transport receives content from the application and serializes writes. Standby blanks and normal frames use the same queue.
6. Exit stops receiving, invalidates ordinary requests, stops playback/display work, and disposes capture. Location stop deliberately uses the captured destination and an independent deadline so it can finish after ordinary session cancellation.

`ConnectionTransitions` is the shared application reset boundary. `RelaySession.restart()` still owns cancellation and generation changes; callers and parsed API responses check that generation before changing application state. A phone page becoming hidden remains distinct from an explicit glasses-app exit.

## Coordinated state boundaries (#62)

The planned boundaries span three dependent children:

1. Conversation state (#63) owns durable history, selection, unread and announcement bookkeeping. `receive` returns announcement candidates and an initial waiting message; `flush` takes display eligibility, standby visibility and current location-announcement eligibility, then returns display/wake decisions. The entry point executes these decisions. Browser speech objects and UI callbacks do not enter this owner.
2. Connection transitions (#64) now implement the matrix below, while `RelaySession` retains transport lifetime ownership. Conversation reset clears all selection, unread, deferred restore/wake and announcement state, including an empty-history new connection.
3. Runtime effects (#65) synchronize deferred speech, input eligibility and standby protection through `updateRuntime` / `syncRuntimeEffects` at state transitions. `refreshStatus`, `display`, language repainting and the presentation timer only render. The effects owner independently schedules the remaining reply-wait protection deadline, including while offline; repainting cannot extend it. Synchronous playback/recorder callbacks are coalesced and state is reread before applying dependent policy.

Each child PR targets `refactor/even-state-coordination`; later children incorporate the integrated parent before implementation. Automated checks and review precede child integration. Integrated physical acceptance remains required before the parent can be proposed for main merge. For each device check, specify the exact build, starting state, numbered actions, expected outcome and requested observation; report device observations separately from simulated tests. Main merge and distribution remain separately authorized.

## Connection reset/retention matrix

| State | Pair attempt | Same-origin restore | Changed/missing restore or successful new pairing | Forget/rejection |
| --- | --- | --- | --- | --- |
| Ordinary requests / update loop / deferred speech | Cancel / restart generation | Cancel / restart generation | Already cancelled for pairing; cancel for restore | Cancel / restart generation |
| Credentials | Keep until success | Replace from saved credentials | Replace or clear | Clear; also clear legacy pairing |
| Busy / clip / transcription / audio trace | Pairing stays busy; idle recorder is a precondition | Clear transient interaction | Clear; successful pairing remains busy until initial snapshot | Clear |
| Conversation / unread / announcement / display selection | Keep until success | Keep until initial reconciliation | Clear all | Clear all |
| In-memory pending send ID/text | Keep until success | Keep | Clear | Clear |
| Persisted duplicate-protection digest | Keep | Reopen store for the same origin | Open store for the new origin; do not delete other stores | Keep persisted store; detach in-memory retry |
| Interaction/timing measurements | Keep | Keep; reset active phase | Clear | Clear |
| Subscription / host / provider status | Connection is marked connecting by caller | Clear until fresh snapshot | Clear until fresh snapshot | Clear |
| Unsent text / language / TTS / operation preferences | Keep | Keep | Keep | Keep |
| Location sharing | Existing owner continues enforcing origin-bound consent | Existing owner continues | Existing owner enforces saved origin; no consent expansion | Disable before credentials are removed |

Exit remains a terminal lifetime operation: it stops the session, receive loop, playback, display, capture and location owner without erasing saved pairing/preferences. It is not a reconnect reset. An ordinary offline poll does not discard an active recording.

API response parsing is guarded by the session generation after the body resolves. Pending-ID preparation assigns its result only after that check; send and pairing finalizers cannot release a newer operation's busy state. Transcription already checks both generation and its abort signal. Resetting interaction aborts that signal as well. These are bounded stale-result protections, not a claim that every external lifecycle race has been reproduced on hardware.

## Diagnosing a failure

| Symptom | First checks |
| --- | --- |
| Reply received but not visible | Snapshot reconciliation and selection in `conversation-state.ts`, then standby state, then the write queue/acknowledgements in `g2-display.ts` |
| Voice input remains blocked after read-aloud | `SpeechPlayback.blocksInput`, native synthesis speaking/pending flags, and its completion recovery/cooldown; then the application conditions in `syncVoiceContext()` |
| Old result appears after reconnection | `RelaySession.version`, request cancellation, and the caller's generation check before applying the result |
| Location sharing does not finish stopping | `LocationSharing` retry state and the independent stop request in `RelaySession.location()` |

Do not infer delivery, physical display, or microphone state from a connection indicator alone. Automated fixtures validate bounded behavior; the affected flows still need physical verification from the PR build.

## Verification

`tests/runtime-effects.test.ts` verifies state-policy decisions, synchronous callback reentry, deadline expiry and stop. Composed tests verify that repeated presentation/language refreshes do not flush speech or alter input/standby policy, and that offline wait protection expires even when rendering is disabled. `tests/connection-transitions.test.ts` verifies reset ordering and retention. Composed tests also hold a send response body across forget and check that stale results cannot restore history or release a newer busy operation. `tests/conversation-state.test.ts` covers restore, deferred display, late reply ordering, browsing/unread behavior, location eligibility and send/reply races. `tests/display-lifecycle.test.mjs` exercises the composed application with simulated SDK, network, storage, and time. `tests/runtime-ownership.test.mjs` exercises late callbacks, missing speech completion, queued/stale G2 writes, session replacement during recovery, and location stop during exit. Existing module and HTTP integration tests remain applicable.

Physical acceptance should cover hold/wake input, transcription/review/send, reply/history selection, read-aloud interruption and recovery, standby/tap/head-raise, reconnection, location stop, and explicit exit. Record the source commit and Beta package in the PR. Test completion is not merge or publication authorization.


## Investigating confirmed exit (#59)

The confirmed-exit issue was observed on both public 0.3.4 and refactor Beta 0.3.5. Injected system/abnormal exit events stop location sharing in the composed tests; this does not prove native event delivery. The cause remains under investigation.

For a bounded local trace, build with `npm run build -- --mode exit-check`, then run `node scripts/package-beta.mjs` from a clean commit. The receipt records `exitDiagnostics: true`. Ordinary and release builds disable the trace. Use the uploaded private build through the phone app's Developer Hub; local Prototype Mode may differ from the installed lifecycle.

In that build, **Connection details** shows the last 48 lifecycle and location-request labels, UTC times, and random per-launch tags. The same labels are written to the console. Only those allowlisted fields are retained in localStorage and mirrored to Even app storage, because the local WebView origin changes on relaunch; no coordinates, payloads, pairing/session identifiers, audio, conversation, or automatic diagnostic uploads are included. The panel shows native save status. A failed/pending native save or immediate host teardown can lose the tail of a trace and must not be treated as proof that an event never arrived. Native app storage is shared; concurrent writers are not a guaranteed complete history. The trace can be overwritten after several minutes of updates, so inspect promptly.

Check dialog cancellation first, then sharing OFF/ON followed by confirmed exit. Observe relay status while the app remains closed; reopening may legitimately resume the saved sharing preference. After that observation, reopen and inspect the trace: whether a confirmed-exit event reached the app, whether stop and revoke were attempted, and whether the same launch continued renewals. A successful request is transport evidence, not physical-device proof. Native-event absence or a second running instance must not be inferred solely from stale location timestamps.

Location sharing renews its relay lease only when it uploads a fresh measurement with a newer native timestamp. Empty heartbeats and repeated cached fixes cannot keep an exited native source sharing indefinitely even if its WebView timer survives. The existing relay lease expires 90 seconds after the last renewal. Saved consent and native acquisition remain active while the app runs, so a new measurement can resume sharing after temporary location loss. Explicit OFF/exit still attempts immediate revocation. This fallback does not identify a confirmed native exit while fresh native measurements continue; physical exit and cancellation checks remain required.
