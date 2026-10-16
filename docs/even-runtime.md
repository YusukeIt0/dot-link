# Even runtime ownership

The entry point coordinates the existing user experience. A module boundary should identify who owns a resource or state, not merely shorten a file. Keep application decisions together and avoid duplicating state between controllers.

| Owner | Responsibility | Does not decide |
| --- | --- | --- |
| `src/main.ts` | UI bindings, application startup/exit, connection-reset policy, message selection, and coordination of input, replies, and standby | Transport queue internals or playback completion bookkeeping |
| `src/relay-session.ts` | Active relay credentials, origin recovery, request cancellation, and connection generations | User-facing status, history selection, or whether to record |
| `src/speech-playback.ts` | Queued read-aloud speech, cancellation, completion recovery, and the quiet interval before voice input resumes | Which replies to announce or whether TTS is enabled |
| `src/g2-display.ts` | One serialized G2 text-write queue, stale frame suppression, sent-content caches, and display timing acknowledgements | Which message to show or when to enter standby |
| Existing `VoiceInput`, `DisplayStandby`, `LocationSharing`, `LiveUpdates`, and history modules | Their existing capture, standby, location, receive-loop, and reconciliation policies | Unrelated UI or transport state |

## Interaction and lifecycle

1. Input capture produces a clip; the application starts recognition and decides whether to send immediately or allow review.
2. Relay requests carry the active session credentials. A connection transition cancels ordinary requests and advances the session generation; callers also guard their UI updates with that generation.
3. Incoming snapshots are reconciled with history. The application selects the visible conversation and determines read-aloud eligibility.
4. Playback reports whether it blocks voice input. The application combines that with recording, connection, and pending-input state.
5. Display transport receives content from the application and serializes writes. Standby blanks and normal frames use the same queue.
6. Exit stops receiving, invalidates ordinary requests, stops playback/display work, and disposes capture. Location stop deliberately uses the captured destination and an independent deadline so it can finish after ordinary session cancellation.

`restartConnection()` is the shared connection-transition boundary. Restore, pair, and forget retain their explicit application reset differences; do not replace them with an undifferentiated global reset. A phone page becoming hidden remains distinct from an explicit glasses-app exit.

## Diagnosing a failure

| Symptom | First checks |
| --- | --- |
| Reply received but not visible | Snapshot reconciliation and selection in `main.ts`, then standby state, then the write queue/acknowledgements in `g2-display.ts` |
| Voice input remains blocked after read-aloud | `SpeechPlayback.blocksInput`, native synthesis speaking/pending flags, and its completion recovery/cooldown; then the application conditions in `syncVoiceContext()` |
| Old result appears after reconnection | `RelaySession.version`, request cancellation, and the caller's generation check before applying the result |
| Location sharing does not finish stopping | `LocationSharing` retry state and the independent stop request in `RelaySession.location()` |

Do not infer delivery, physical display, or microphone state from a connection indicator alone. Automated fixtures validate bounded behavior; the affected flows still need physical verification from the PR build.

## Verification

`tests/display-lifecycle.test.mjs` exercises the composed application with simulated SDK, network, storage, and time. `tests/runtime-ownership.test.mjs` exercises late callbacks, missing speech completion, queued/stale G2 writes, session replacement during recovery, and location stop during exit. Existing module and HTTP integration tests remain applicable.

Physical acceptance should cover hold/wake input, transcription/review/send, reply/history selection, read-aloud interruption and recovery, standby/tap/head-raise, reconnection, location stop, and explicit exit. Record the source commit and Beta package in the PR. Test completion is not merge or publication authorization.
