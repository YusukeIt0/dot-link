# Runtime handoff

Status: implemented and physically accepted on the #124 integration branch; final integrated review and formal release are pending.

## Outcome

Opening the Even app again must not let retained runtimes repeatedly invalidate
one another's connection. Background glasses use remains active without a phone
page being visible. Successful brief recovery should not flash a disconnection;
sustained outages and explicit revocation must remain visible. No new user
setting or pairing step is part of normal handoff.

## Responsibilities

The Mac pairing authority owns which runtime may use a recovery registration.
The Even relay session owns startup acquisition, transport recovery, cancellation
and a terminal superseded state. Application lifecycle code retires the old
runtime's local work without erasing shared pairing, changing consent, or sending
late native stop/display operations into the replacement runtime. Connection
presentation belongs to the update loop, not to authentication policy.

A runtime is not a separately registered device. Independent registrations remain
independent. Recovery identity and location-consent identity remain stable across
runtime handoff. Provider-specific AI transport is outside this change.

## Recovery protocol

Extend the existing authenticated `POST /api/pair/resume` JSON envelope with a
strict, optional `runtime` object. The existing 256-bit recovery capability still
authorizes acquisition; runtime IDs and counters are not credentials.

- `inspect`: validate recovery and return protocol support plus the current
  runtime generation. It neither grants data access nor changes the owner.
- `claim`: send a random per-runtime ID and the generation observed at startup.
  Atomically acquire the next generation. A repeated claim by the same owner on
  the same origin returns the same credentials; a stale competing claim fails.
- `renew`: send the runtime ID and its acquired generation. Only the current
  owner on its exact origin can recover. A superseded runtime cannot claim again
  merely because a request failed.

Acquisition is a startup transition, not a generic response to HTTP 401. Retrying
an uncertain claim retains its original ID and expected generation; it does not
inspect a newer generation and steal ownership back. A new app runtime can
inspect and acquire even if the previous runtime failed to persist its session
credentials. This avoids requiring a new pairing code after a lost response or a
failed native-storage write.

Use an atomic recovery-record replacement as the authority boundary. Keep the
original expiry and global revocation generation. Derive the managed session
credential from the recovery secret and a per-acquisition nonce so retries can
return it without storing plaintext credentials. Exact-origin checks remain in
force before and after proxied work.

Return a specific HTTP 409 superseded result separately from invalid/expired
recovery (401). Updated clients stop reclaiming on 409, cancel stale work and
preserve shared pairing. Revocation still prevents future acquisition.

## Compatibility and rollout

- Existing pairing records and recovery secrets migrate without re-pairing.
- A new Mac preserves legacy recovery until a registration adopts managed
  runtime ownership. Once adopted, legacy recovery requests for that registration
  receive 409 and cannot steal it back. This also fences still-running old code.
- A new Even client recognizes the old Mac's exact unsupported-envelope response
  and uses its existing recovery behavior. It must not treat a timeout, revoked
  credential or arbitrary error as protocol negotiation. Full competition
  protection requires both updated components.
- Install the compatible Mac before enabling the new Even build during rollout.
  Returning a managed registration to an older Even build is not silently treated
  as a supported ownership operation; retain this limitation in release planning.
  Do not expand CORS or auto-clear pairing to make an obsolete client take over.

## Recovery presentation

A successful authentication refresh retries the failed update inside the same
operation. For other transient failures after a successful connection, allow a
two-second recovery interval after the first failed poll before showing offline. A timer must reveal a
sustained failure even if the retry hangs. Initial connection, explicit browser
network loss, revocation and supersession are distinct states and must not be
hidden by the grace interval. The interval is additional to the existing transport
timeout; it is not a guarantee of detecting silent network loss within two seconds.
Keep normal input/delivery semantics and retry
idempotency; do not turn uncertain delivery into a duplicate send.

## Acceptance

Automated checks must cover:

- Two and three runtimes sharing a registration: only the acquired owner can
  recover; stale claims and renewals cannot cause alternating session replacement.
- Lost claim/renew replies, native-storage failure, relay restart and repeated
  requests; no plaintext credentials on disk or in diagnostics.
- Separate registrations, exact-origin denial, original expiry, explicit revoke
  and global revoke; no stale owner can restore revoked access.
- Existing legacy records, legacy-before-adoption, old callers after adoption,
  new-client/old-server negotiation, and malformed protocol envelopes.
- After supersession is received, queued asynchronous work cannot erase pairing,
  change consent, dispatch more display writes or close native resources belonging
  to the replacement runtime.
- Successful recovery without offline flicker; sustained failure becomes visible
  within the bounded interval; cancellation removes timers and stale callbacks.

Physical acceptance completed on 2026-10-21 using runtime commit
`118529b31fc35e8cbfb7c4ffad7d04f46e6e2e8f`, Mac 0.4.9 Beta build 78 and
Even 0.3.20 Beta. The maintainer reported passing repeated reopen, background
voice/reply, normal voice/text/reply, recording and read-aloud across reopen,
location-setting retention, and relay pause/resume recovery without foregrounding.
Agent observations kept one session and registration across eight ownership
generations, and confirmed healthy services and pairing after recovery.
[Build and acceptance evidence](https://github.com/YusukeIt0/dot-link/pull/133#issuecomment-6314078248)
records the exact artifacts and attribution.

The maintainer declined an additional disconnect/re-pair cycle; revocation has
automated coverage and is not claimed as physically tested. Wake word, head raise
and active location transmission were not exercised. These are recorded limits,
not additional release acceptance requirements. The parent only changes release
version metadata and this record relative to the accepted runtime.

The SDK cannot cancel a native operation already dispatched before supersession.
The old runtime learns of ownership loss through its next failed request/poll;
server authorization fences access immediately, but native retirement is not an
instantaneous cross-WebView transaction. Unsent text remains selectable in a
retired view. An in-progress recording is not transferred between runtimes, and
no seamless recording handoff is claimed.

## Delivery order

1. Child: server runtime-authority contract and integration tests.
2. Child: Even lifecycle/recovery integration, connection presentation and tests.
3. Parent: integrated review, exact-build physical acceptance, then maintainer
   merge decision. Distribution and publication remain separate stages.

The spontaneous phone-page closure and the separate opt-in debug-mode proposal
are outside this outcome. No standalone backlog or release-tracking issue is
needed.
