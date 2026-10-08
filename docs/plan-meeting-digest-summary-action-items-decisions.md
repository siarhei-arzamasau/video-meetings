# Meeting digest — summary, action items, and decisions — Implementation Plan

**PRD:** [`docs/prd-meeting-digest-summary-action-items-decisions.md`](prd-meeting-digest-summary-action-items-decisions.md)
**Date:** 2026-10-08

Where the code stands: `ClaudeAgentService.runPrompt` reaches Claude through the Claude Agent
SDK — text in, text out, one turn, no tools, no way to cancel — and nothing calls it. A
recording's transcript is a text file beside the recording. Nothing in the API describes a
meeting as a whole, no user can read another user's name, and the meeting page follows one
stream whose events are files. Phase 1 proves Claude can return a digest at all; phases 2–5
build it into the API; phases 6–7 put it on the page.

## Decisions the PRD leaves to the plan

1. **A module of its own, `meeting-digests`, that reaches the others only over the buses.** It
   owns its tables and imports `ClaudeAgentModule`. Transcripts come from queries
   `meeting-files` answers, members from `meetings`, names from `user`, and its trigger is
   `MeetingFileChangedEvent`. No module imports another's service or reads another's table.
2. **One request per generation, and too long fails unsent.** The transcripts go to Claude
   whole or not at all: past a character cap the digest is Failed with the too-long reason and
   nothing is sent; a provider that still answers "prompt too long" gets the same reason. No
   splitting and re-summarising — a digest of digests is the "part presented as the whole" the
   PRD forbids, one step removed. The cap is set in phase 1 from the model's documented limit:
   1,700,000 characters, derived beside `MAX_DIGEST_TRANSCRIPT_CHARACTERS`.
3. **The answer is bound to a JSON schema and validated again by the API.** The SDK's
   `outputFormat` returns `structured_output`; the API checks it with a guard of its own, with
   bounds on every length, because a schema the provider enforces is still the provider's word.
   **A schema-bound answer fits the module's single turn** — settled by phase 1's live spec,
   where this plan first left it open. The SDK delivers the answer through an end-turn tool of
   its own, `StructuredOutput`, which is present even with `tools: []` and is the only tool the
   process holds; the call that carries the answer ends the turn in one request, so the turn
   cap stays at 1. The cap's price is that an answer the SDK rejects against the schema is a
   failure rather than a second attempt.
   **The bounds include fifty action items and fifty decisions, and a list that had to be cut
   says so in the summary** — decided in phase 1, which found nothing marking the omission.
   The instructions ask for the most important fifty and a closing sentence that the list is
   not complete; the answer gains no field for it, so the contract below is unchanged. Sixty
   of each, measured live, came back as fifty and fifty with that sentence, in one turn.
4. **Instructions are the system prompt; transcripts are the prompt, labelled by ordinal.**
   "Recording 1", "Recording 2", in upload order — no file name, no id, no participant. A
   custom system prompt also replaces Claude Code's own, which is about writing code.
   A transcript is not escaped, so the instructions call the whole prompt transcript, not
   only what sits inside a recording's tags: a transcript that closes its own tag gains
   nothing by it. **A blank transcript is sent like any other** — Whisper transcribes silence
   as empty text — and the instructions say what the digest of recordings with no speech is:
   a summary that says so, and two empty lists. Both were added in phase 1's review.
5. **Claude returns a name; the API decides the link.** The answer's owner is a name as spoken
   or nothing. The API links it to a participant when every word of it is a word of exactly one
   display name among the host and participants, compared without case; anything else stays a
   name. So no display name is sent to Anthropic, no answer can point at a user, the rule is
   testable without a model, and a doubtful match stays unlinked — the PRD's preference.
   **Two things phase 4 settled about the rule.** A word is a run of letters and digits, so a
   display name that was derived from an email address and never changed (`ada.lovelace`)
   is the words "ada" and "lovelace", and takes part like any other; beyond case nothing is
   folded — a prefix, an initial, a dropped accent, another script are all no match. And
   **members that cannot be read when the answer arrives link nobody, rather than fail the
   digest**: the answer is paid for, and an owner left as the name that was spoken is this
   decision's own answer to doubt.
6. **One row per meeting holds the state: a status, a lease, a claim count, and a revision.**
   Every request for a generation bumps `requested_revision`. A claim remembers the revision it
   took; the write that ends it is `ready` (or `failed`) only if the revision is unchanged, and
   `queued` otherwise. That is all of "never two at once, and one more after a change".
   **Two things phase 2 settled about that write.** The claim count goes back to 0 with every
   request that queues a row and with every requeue: it bounds the crashes of one generation,
   and three recordings arriving one behind another would otherwise be failed unrun as a
   fourth claim. And an answer whose row is queued again is still stored — it is a whole
   digest of the recordings it names, and the read marks it out of date — while the reason of
   a failure that is being replaced is dropped.
7. **The trigger is the file event, not the transcription's transaction.** A recording that
   reaches Transcribed with the setting on asks for a generation. A process killed between the
   transcription's commit and that request leaves a transcribed recording with nothing queued —
   exactly the state of one transcribed with the setting off, for which the page offers
   Generate. Closing that window would mean `meeting-files` writing this module's table.
8. **Both of the PRD's recording rules are derived when the digest is read**, from the
   recordings a digest was built from against the recordings transcribed now: content is
   returned only if every source is still there, and is `outOfDate` if a transcribed recording
   is not among them. They therefore hold with the setting off and in whatever order events
   arrive. Reacting to a delete — removing the stored content, queueing a replacement — is
   tidying on top, and an answer that arrives after one of its sources was deleted is discarded.
   **Four things phase 3 settled about that tidying.** It asks whether every source is still
   transcribed rather than whether the deleted file was one, so a delete whose reaction never
   ran is caught up with by the next. A digest that lost a recording with the setting off has
   its status cleared, not left `ready` over nothing: nothing will be generated, and the way
   back is Generate. **The worker looks at an answer's recordings twice: when the answer
   arrives, and again once it is stored.** The first look alone — as this decision first had
   it, "removed by its own reaction" — left one order uncovered, found in phase 3's review: a
   delete that commits just after the look can be followed _before_ the answer lands, find
   none of its sources, and change nothing; the answer is then stored with a deleted
   recording in it and nothing queued. With the second look one of the two always sees the
   other — a delete committed before it is found missing, and one committed after it has its
   reaction lock the row after the answer was stored — and no transaction crosses two
   modules' tables. **And clearing a row that is `generating` is accepted with what it
   costs.** The call it interrupts is not hung up on at once: its worker finds the claim gone
   at the next lease renewal, a third of the lease away. One replica runs one loop, so
   nothing else starts meanwhile. With two, a recording transcribed in those seconds queues
   a row the other replica may claim while the first call is still open — two calls for one
   meeting for up to a third of the lease, the first paid for and discarded, and nothing
   wrong stored, since every write is conditional on the lease. Leaving the cleared claim's
   lease on the row would close that, by making every digest asked for after such a delete
   wait out a whole lease, on one replica too; a lapsed lease already allows the same
   overlap, and this is that case reached sooner.
9. **The contract carries a `version`, and the digest rides the files stream.** Every write to
   the row bumps it, and a client keeps the higher of two — which orders an event against a
   fetch, and a claim against the write that queued it, without the hand-over machinery the
   files contract needs for lacking one. The digest is a second event name on
   `GET …/files/events`: a second stream would double every meeting page's long-lived
   connections against a browser's six per origin.
   **An event is the digest read again after the write, not the write's own row** (phase 3):
   what `GET` answers includes which recordings are transcribed now, which no writer holds.
   So an event may describe a later write than the one that caused it, and two writes close
   together may be announced as one digest twice — both nothing to a client that keeps the
   higher version. **The version therefore rises with every change to what `GET` answers,
   not only with a write to a column**: a recording transcribed with the setting off, and a
   deleted recording the digest was not built from, each change only `outOfDate`, and each
   moves the version. **It may also rise for nothing, and that is the side to err on**: the
   delete of any recording that leaves a digest covering every transcribed one moves it,
   whether or not that recording had been transcribed, because the delete's event cannot be
   trusted to say — it carries the status the delete read, and a transcription can finish
   between that read and the delete.
   **One change to what `GET` answers does not move it: a linked owner's new display name**
   (phase 4). The name is read with the digest, not stored in it, and nothing tells this
   module that a user was renamed; a page that is open keeps the old name until its next
   fetch, and a page that keeps the higher of two versions must take a fetched digest over
   an equal one it holds. Moving the version would take an event from the user module.
   **A second one does not move it either: `availableAction` leaving with a meeting's last
   transcribed recording** (phase 5). A meeting whose recordings were transcribed with the
   setting off has no digest row, so no version, and a delete never makes a row; the same
   holds for a row with no status and nothing stored. Generate stops being offered there
   with nothing written. Making a row for it would be a write on every recording's delete in
   a meeting that has no digest, to carry a change the page can see for itself: it holds the
   files, and the deleted one leaves its list by the same stream. So the page offers the
   action only while its list holds a transcribed recording (phase 7), and a request that
   meets a 409 fetches the digest again.
10. **Generate and Retry are one request** — "generate now" — refused unless there is something
    to generate and nothing under way. The digest says which label applies (`availableAction`);
    who may press it is the page's to work out from the files it already holds, and the API's to
    enforce. **One reading of the PRD to confirm:** Generate is also offered for a digest that
    is out of date with nothing queued — a recording transcribed while the setting was off —
    which the PRD's "no digest" would leave with no way forward.
    **Four things phase 5 settled about it.** One rule decides both halves — what the read
    offers and what the route accepts — so they cannot disagree: no transcribed recording
    refuses everything; a failed digest may be retried, whatever failed it and whatever is
    stored under it; anything else may be generated unless it is queued, generating, or
    built from exactly the recordings transcribed now. That makes Generate the way out of
    one more state than the reading above: a digest withheld by a delete nothing reacted to.
    **The request is decided under the row's lock, not by one conditional statement**: what
    makes a digest current is which recordings are transcribed, which this module may only
    ask for, so the caller reads them and the transaction locks the row, reads its sources,
    and decides. A meeting with no row is given an empty one first, so that two requests at
    once have something to lock and are one generation. **The setting is a 409, after the
    404s** — unlike a transcription's retry, which queues with its setting off: a digest
    queued while nothing is generated is a paid request made later, by nobody. **And
    `availableAction` is the same for every reader**, since it rides an event every stream
    is sent; a participant who may not ask is told so by the route.
11. **The worker is the transcription worker's shape**: a polling loop of its own, where
    `MEETING_FILES_WORKER_ENABLED` is on; a `FOR UPDATE SKIP LOCKED` claim; the lease heartbeat;
    a fourth claim failed unrun; a graceful shutdown that hands the claim back uncounted; no
    automatic retry; fixed failure copy from `@repo/shared`, with the cause in the log.
    It runs under the files worker's `MEETING_FILES_LEASE_SECONDS` and `MEETING_FILES_POLL_MS`
    rather than a pair of its own (phase 2). One thing is not the transcription worker's:
    which of the time limit and a shutdown hung up is read from the abort signal's reason,
    the first to fire, because the SDK's rejection trails an abort by up to two seconds and
    both may have fired by then.
12. **`MEETING_DIGEST_ENABLED`, off by default, and a restart to change.** On, a missing
    `ANTHROPIC_AUTH_TOKEN` stops the boot. Off, the worker is idle, a transcribed recording
    asks for nothing, the request route answers 409, and a row left `queued` waits.
13. **The tests' Claude is a fake `ClaudeAgentService`.** Bound over the real provider, so the
    prompt builder, the validator, and the owner match all run for real and the fake sees the
    exact text that would have left. The browser suite needs the same inside a running API, and
    the SDK has no HTTP seam to stand a server behind — so that suite boots the API from a test
    entry point.

## Contract additions (`@repo/shared`)

```ts
export const MEETING_DIGEST_STATUSES = ['queued', 'generating', 'ready', 'failed'] as const;

export type MeetingDigestOwner =
  | { kind: 'participant'; userId: User['id']; displayName: string } // phase 4
  | { kind: 'name'; name: string };

export interface MeetingDigestContent {
  summary: string;
  /** `owner` absent: unassigned. */
  actionItems: ReadonlyArray<{ id: string; description: string; owner?: MeetingDigestOwner }>;
  decisions: ReadonlyArray<{ id: string; description: string }>;
  generatedAt: string;
  /** A transcribed recording of the meeting is not among those this was built from. */
  outOfDate: boolean;
}

export interface MeetingDigest {
  meetingId: Meeting['id'];
  /** Rises with every change below; a client keeps the higher. 0: the meeting never had one. */
  version: number;
  /** Where the latest generation stands. Absent when none has been asked for. */
  status?: MeetingDigestStatus;
  /** Present only when `status` is `failed`. Safe to render. */
  failureReason?: string;
  /** Present only while every recording it was built from still exists. */
  content?: MeetingDigestContent;
  /**
   * Phase 5. What the host or a transcribed recording's uploader may ask for now: the same
   * for every reader, absent with the setting off. `MeetingDigestAction` in `@repo/shared`.
   */
  availableAction?: 'generate' | 'retry';
}
```

| Edge                                   | Taken by                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| _(none)_, `ready`, `failed` → `queued` | A recording reaching Transcribed, setting on; a deleted source, others left; phase 5    |
| `queued` → `generating`                | A claim; also re-claims `generating` past its lease                                     |
| `generating` → `ready`                 | The answer stored, lease held, revision unchanged                                       |
| `generating` → `failed`                | Provider error, bad shape, time limit, too long, a fourth claim; revision unchanged     |
| `generating` → `queued`                | Revision changed meanwhile; an answer discarded for a deleted source; shutdown release  |
| `generating` → _(none)_                | The claim found no transcribed recording to generate from; revision unchanged (phase 2) |
| any → _(none)_                         | The meeting's last transcribed recording deleted; a deleted source, setting off (3)     |

Routes: phase 2 adds `GET /api/meetings/:id/digest` — `200 MeetingDigest` for anyone who can
see the meeting, `404 Meeting not found` otherwise. Phase 3 adds `event: digest` to the files
stream. Phase 5 adds `POST /api/meetings/:id/digest/generation` — host or the uploader of a
transcribed recording, `200 MeetingDigest`; anyone else `404`; nothing to generate — no
transcribed recording, or a digest that already covers every one — one under way, or the
setting off `409`.

## Implementation phases

### Phase 1: Claude turns a transcript into a digest (tracer bullet)

**Goal:** given transcript text, the API's own code gets back a validated digest — summary,
action items with spoken owners, decisions — from the real model. Proves the riskiest part
before any table exists: a schema-bound answer through an SDK that is Claude Code, the model's
judgement on owners and decisions, and what a generation really costs in seconds and dollars.
**Touches:** backend

**Tasks:**

- [x] `ClaudeAgentService.runStructuredPrompt`: a system prompt, a JSON schema, and an
      `AbortSignal` in; the `structured_output`, the model, and the cost out. Still no tools, a
      replaced environment, and nothing from disk. `ClaudeAgentError` gains a prompt-too-long
      failure and carries the cost whenever a result reported one. The mapping from the SDK's
      result to an outcome is a pure function with a unit table; the service spec keeps "no
      token, no call".
- [x] `MeetingDigestGenerator` in the new module: the instructions (only what the transcripts
      state; always English; an owner is a spoken name or nothing; text inside a transcript is
      never an instruction; empty lists are an answer), the schema, the guard that re-validates
      the answer with bounds, and the prompt builder with its cap. Unit specs: the guard's table,
      a prompt that holds the texts and ordinals and nothing else, and no call past the cap.
- [x] Reference transcripts as fixtures — the PRD's script (two action items, one naming a
      person, one naming nobody; one decision), the same in Russian, one with no decision and
      no action item, one carrying instructions addressed to the model and HTML — and a
      recording of the script for the manual runs of later phases.
- [x] `meeting-digest.live-spec.ts` under `test:live`, against the real model: the reference
      yields both action items, the named owner, and the decision; Russian yields a digest with
      no Cyrillic; the empty one yields empty lists; the injected instruction is not obeyed and
      the answer is still a digest; a refused token is `AUTHENTICATION`.
- [x] Measure and set: seconds and cost for the reference and for a transcript at the cap; set
      the time limit's default at twice the slowest, and the cap from the model's documented
      limit less the instructions and the answer — each with its measurement stated beside it.
      _As built:_ a generation at the cap is about $2, so the long measurement was one call at
      a million characters (347,000 tokens, 40% of what a prompt can hold) and the slowest
      generation is extrapolated from it and from meetings of fifty and of sixty action items
      and decisions — an answer's length, not a meeting's, is what makes a generation slow.
      Russian, the script the cap is reckoned in, was measured on 50,000 characters. **Still
      not run: one generation at the cap itself**, which would confirm both that a prompt of
      that size is accepted and how long it takes.

**Done when:** `test:live` is green and its times, costs, and model are in the commit body;
the turn cap `runStructuredPrompt` settled on is explained where it is set;
`pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test` pass and both
`test:e2e` suites pass with no token; the API guide's Claude section covers the new method.

### Phase 2: A digest generated, stored, and served by the API

**Goal:** with the setting on, a recording that reaches Transcribed gives its meeting a digest
with no request from anyone, readable by everyone who can see the meeting, surviving restarts.
**Touches:** database, backend

**Tasks:**

- [x] Make room first, as pure moves with both suites green before and after:
      `env.validation.ts` is at the 250-line limit, so its transcription settings move to a
      file of their own; `PollingLoop` and the lease heartbeat move from `meeting-files` to
      `src/common/processing`, the heartbeat losing its file-specific option names.
- [x] Schema, contract, setting: the `MeetingDigestStatus` enum and `meeting_digests` (one per
      meeting; status, failure reason, lease, claim count, requested revision, version,
      summary), `meeting_digest_action_items` (owner name, owner id), `meeting_digest_decisions`,
      `meeting_digest_sources` — per `.claude/rules/prisma.md`, migration `add_meeting_digests`.
      The shared vocabulary, types, and failure copy (generic, time limit, too long, repeated
      attempts). `MEETING_DIGEST_ENABLED`, `MEETING_DIGEST_TIMEOUT_SECONDS`, the token required
      when on, `.env.example`. Mapper spec and `env.validation.spec.ts`.
- [x] Reading: two queries answered by `meeting-files` — a meeting's transcribed recordings
      (id and uploader), and their transcripts in upload order, which stops at the cap rather
      than load unbounded text. `GET /api/meetings/:id/digest` through `FindVisibleMeetingQuery`,
      applying decision 8's two rules. Handler specs.
- [x] Writing: `MeetingDigestRepository` — the request upsert, `claimNext`, `renewLease`, the
      completion that replaces content and sources in one transaction, fail, and release — with
      a spec for the edge table. The `MeetingFileChangedEvent` handler that requests a
      generation for a newly transcribed recording while the setting is on.
- [x] `MeetingDigestWorker`: idle while the setting is off; claim, heartbeat, transcripts,
      generator under the time limit, then the conditional write; a fourth claim fails unrun;
      shutdown releases; every generation logs its duration, model, and cost; `drain()` under a
      string token. Unit spec. Then e2e, red first, with a fake `ClaudeAgentService`. Flow: an
      MP3 is `ready` and transcribed before its digest is; `GET` shows queued, generating,
      ready; a PDF asks for nothing; three recordings end in one digest holding all three with
      never two calls open; a failed transcription is left out and joins after its retry; a
      participant reads it and a stranger gets 404. Failure: an error, a refused token, a bad
      shape, the time limit, and the cap each end Failed with the file untouched, stored content
      unchanged, the limit named, and a marker in the error absent from the reason. Recovery: a
      release and an expired lease both end Ready; two concurrent claims take one row; a second
      app over the same database serves the digest with no call. Setting: off queues nothing
      and still serves; on with no token does not boot. The captured prompt holds no email, id,
      or storage path, and no response holds a cost.

_As built:_

- **The contract is two classes.** The transcription settings are a class `EnvironmentVariables`
  extends, in `env.validation.transcription.ts`; the heartbeat's options are `leases`,
  `claimId`, and `subject`, the last being how its log lines open.
- **The row has one column the list above does not name**, `generated_at`, for the
  contract's `generatedAt`; and its `status` is nullable, so that phase 3's "no digest" keeps
  the row and its rising `version`. Action items and decisions carry a `position`; `owner_id`
  is a foreign key to `users` that phase 4 fills.
- **The repository is two classes**, for the 250-line limit: `MeetingDigestRepository` (the
  request and the read) and `MeetingDigestClaimRepository` (every write under a lease). The
  edge table is specced twice: against a stubbed client beside the code, and against the
  database in `meeting-digest-claims` and `meeting-digest-claim-writes`.
- **The worker clears the status when a claim finds no transcribed recording** — the last one
  deleted after its request — rather than send nothing or fail. Phase 3 does the same eagerly,
  on the delete. **That write is conditional on the revision like the other two**, and leaves
  the row `queued` when a request moved it: a recording transcribed after the claim read the
  transcripts asked while the row was `generating`, which changes only the revision, and a
  clear that ignored it left that recording with nothing queued. Found in review.
- **The read is one snapshot.** The row and its three child tables are four statements, and a
  generation committing between two of them gave a read the earlier summary over the later
  lists. `findOf` runs them in a `REPEATABLE READ` transaction; `meeting-digest-read` holds a
  write half-way through a read to show it. Found in review.
- **Both e2e environments pin the setting off** — `test/setup-env.ts` and `start:e2e-web` —
  so neither takes it, or the token, from a developer's `apps/api/.env`. The digest specs
  switch it on per test. The browser suite therefore generates no digest until it boots the
  API from the test entry point decision 13 describes.
- **`PendingDigestRequests`**, which the tasks do not name: the event bus does not wait for a
  handler, so the requests in flight are tracked for shutdown and for `drain()`.
- **The Compose `api` service is not handed the setting.** Nobody has checked that its image
  can start the SDK's Claude Code binary; the digest is documented for an API run on the host.
- **The e2e specs were written after the worker, not before it.** They were then run against
  a module with the worker and the event handler taken out, and failed there for the reason
  expected, before being run against the whole.
- **The manual run was not done**: the real Whisper and a token outside `test:live` were
  both out of reach where this phase was built. It is still owed.

**Done when:** those specs are green with every earlier e2e spec; a manual run with the real
Whisper and the real model is in the commit body — the reference recording uploaded and its
digest read, the API restarted mid-generation, Anthropic unreachable (Failed; file, transcript,
and uploads unaffected); the CI commands pass; the API guide has a _Meeting digests_ section,
the root guide points at the PRD and this plan, and `README.md` names the setting and what it
sends to Anthropic.

### Phase 3: The digest follows the recordings, and says so live

**Goal:** deleting a recording withdraws what was built from it and replaces it; every change
to a digest reaches open streams.
**Touches:** backend

**Tasks:**

- [x] Deletes: the event handler, on a deleted recording, removes content built from it and
      either queues a replacement (setting on, recordings left) or clears the status; the
      worker discards an answer one of whose sources has gone, uncounted. Unit specs for both.
- [x] `MeetingDigestChangedEvent`, published once per committed write and never before it,
      carrying the digest as `GET` would answer it. A recording transcribed with the setting
      off bumps the version of a stored digest too, since `outOfDate` just changed.
- [x] `MeetingFileEventsService` forwards that event to the meeting's streams as
      `event: digest`. Spec beside the existing stream specs.
- [x] E2E, red first. Deleting one of two: `GET` stops returning content at once, and the
      replacement was generated from the remaining transcript only. Deleting the only one: no
      digest, no call. A delete during a generation: its answer is never stored. A second
      recording: the first digest is returned `outOfDate` until replaced. Setting off: a delete
      still withdraws, a new recording still marks. Stream: every edge arrives as `digest` with
      a version higher than the last.

_As built:_

- **A delete is one decision and one transaction**: `digestAfterDelete`, a pure function
  over the row, its sources, and the recordings transcribed now, and `followDelete`, which
  locks the row, asks it, and writes. The lock orders it against a generation's `complete`,
  which would otherwise land between the read of the old sources and their removal.
- **With no transcribed recording left the status is cleared whatever it was, `generating`
  included.** The generation under way finds its claim gone at its next lease renewal, or
  when it tries to write. The clear gives way to a request made since the handler read the
  revision, which it reads before the recordings.
- **Every `deleted` event is followed, not only a recording's**: the event carries the file
  as its delete read it, and which recordings a digest was built from is this module's to
  know. The purge repeats `deleted` and nothing tells the two apart; the only thing it
  repeats here is the version of a digest that was not built from the recording.
- **A deleted recording the digest was not built from moves the version too**, when it was
  the only one the digest did not cover: `outOfDate` changed, as it does for a recording
  transcribed with the setting off. The tasks name only the second. **Any recording counts,
  transcribed or not** (review): the event says "transcribing" for a recording whose
  transcription finished between the delete's read and its write, and gating on
  "transcribed" left that flip of `outOfDate` under an unchanged version, with no event.
  What the event cannot have wrong is whether the file had a transcription status at all.
- **The worker takes a second look after it stores** (review; decision 8 says why), and
  `MeetingDigestDeleteFollower` is where following a delete now lives: the revision, the
  recordings, the write, and the announcement, in that order, for the event handler and for
  the worker's second look alike. `DigestOutcomeRecorder.complete` answers whether the
  answer was stored, which is what the worker owes the look for.
- **`MeetingDigestAnnouncer` is the one publisher, and it reads the digest again** through
  `MeetingDigestsService.currentOf` — the route's own read, without the visibility check —
  rather than building the event from a write. Decision 9 says what that makes of ordering.
  The worker waits for the announcement of its claim before it calls Claude, so that
  "generating" is what the read finds.
- **A check that cannot be made fails the digest** (`SOURCES_UNCHECKED`, the generic
  sentence) rather than store an answer whose recordings are unknown.
- **A claim that finds no transcribed recording still leaves the content rows**, as phase 2
  built it: withheld by the read, and removed by the next delete in the meeting. Only the
  delete's own reaction removes eagerly.
- **The e2e specs were red first**: `meeting-digest-deletes` and `meeting-digest-events`
  were written and run against phase 2's code — 12 of 15 failing, for a status that was not
  cleared, content that was stored, and events that never came — before any of it was built.
  The cases of a delete under a generation were then split into
  `meeting-digest-delete-races`, which also holds the stream's edges back to the queue. Two
  phase 2 cases moved with them: the read withholding at once, and the claim that clears,
  now reached by seeding the state of a reaction that never ran. **Two cases were added in
  review, each seen failing against the code without its fix or rule**: a recording deleted
  over raw SQL, so that no reaction exists and the read alone is what withholds — the
  delete route's reaction usually wins the race to the next `GET`, which made the moved case
  pass with the read's rule removed — and a delete placed, with its reaction, between the
  worker's look and its write, by wrapping `MeetingDigestClaimRepository.complete`.

**Done when:** the specs are green with every earlier e2e spec; the CI commands pass; the API
guide's stream section says the digest is a second event and why it carries a version.

### Phase 4: Owners linked to participants

**Goal:** an action item whose spoken name identifies one person in the meeting is reported
as that participant, under their current display name.
**Touches:** backend

**Tasks:**

- [x] `FindMeetingMemberIdsQuery` in `meetings` (host and participants) and
      `FindUsersByIdsQuery` in `user` (id and display name, one statement). Handler specs.
- [x] `matchOwner`, a pure function over a spoken name and the members' display names, with a
      unit table: a full name, a first name, a first name two members share, a name nobody
      has, differing case, a name derived from an email address, an empty name.
- [x] The completion stores `owner_id` beside the spoken name; the read resolves current
      display names in one query and emits `participant`, `name`, or no owner.
- [x] E2E, red first: the four owner outcomes; a renamed participant shows the new name with
      no call; an answer naming a user who is not in the meeting is stored as a name and
      returned with no link; the captured prompt contains no member's name.

_As built:_

- **The match is made inside `runDigestGeneration`**, once an answer's recordings have been
  checked and under the same heartbeat, and its result — spoken name to member id — travels
  with the answer to the one transaction that stores it. An answer that is discarded, or
  that names nobody, asks about no member.
- **No migration**: phase 2 created `owner_id` with its foreign key and index.
- **The member ids are deduplicated by the query and again by the match**, which counts
  members rather than rows: a member listed twice must not read as "two people share this
  name".
- **A linked member with no name to show is served as the spoken name** — an account deleted
  between the read of the digest and the read of its owners' names; the foreign key's
  `SET NULL` says the same thing a moment later.
- **A rename moves no version** (decision 9), and the read trusts a stored link without
  asking again who is in the meeting, which holds while participants are fixed at creation.
- **The e2e spec was red first**: `meeting-digest-owners` was written and run against phase
  3's code, where three of its four cases failed for an owner served as a name; the fourth,
  the user outside the meeting, was already green there and is a guard on the match rather
  than evidence of it.

**Done when:** the spec is green with every earlier e2e spec; the CI commands pass; the API
guide records that a meeting's member names are readable by its members, through this route
only, and never an email address.

### Phase 5: Generate and Retry, in the API

**Goal:** one request starts a digest for transcripts that were never digested, and restarts
a failed one.
**Touches:** backend

**Tasks:**

- [x] `availableAction` in the contract and the mapper: `retry` for a failed digest, `generate`
      for transcribed recordings with no current digest and nothing under way, absent
      otherwise and always with the setting off. Mapper spec.
- [x] `RequestMeetingDigestCommand` and its handler: visible meeting (404), host or uploader
      of a transcribed recording (404), then the conditional request that resets the claim
      count and clears the reason (409 on zero rows); publishes the event and returns the
      digest as written. Unit spec for the outcomes.
- [x] `POST /api/meetings/:id/digest/generation`, and e2e, red first: a recording transcribed
      with the setting off starts nothing when it is switched on; the host's request, and the
      uploader's, end Ready after a drain; another participant and a stranger get 404; a
      current, queued, or generating digest gets 409, as does the setting off; a failed digest
      retried ends Ready with the claim count back at 0; an out-of-date digest with nothing
      queued accepts the request.

_As built:_

- **One rule, `requestabilityOf`, behind the mapper's `availableAction` and the handler's
  409** (decision 10). The mapper takes the setting as an argument, and the read asks for the
  recordings when the setting is on even for a meeting with no digest row — the one query
  the feature costs a meeting that has none.
- **The request is a transaction, not the one conditional statement the task names**: an
  empty row if there is none, the row's lock, its sources, the decision, and then
  `requestGeneration` — the write every other request is. A refusal is "zero rows" all the
  same: it writes nothing and announces nothing. Three requests sent at once for a meeting
  with no row are one `200` and two `409`s, and one generation.
- **The recordings the request is decided against are read before the lock, and stay
  there.** Review found the window: a recording deleted between the read and the lock lets
  a request through for a digest that delete has just made current. It is left, because the
  row ends where the same request committing just before the same delete ends it — `QUEUED`
  over current content, since a delete takes no request back (phase 3) — and because
  reading under the lock means asking `meeting-files` from inside the transaction, a second
  pooled connection held behind the first.
- **"Returns the digest as written" is the row read inside that transaction**, before its
  lock is released, described by the code `GET` runs. The announcement is the announcer's
  usual second read, so the event may already say `generating`; it carries the higher
  version.
- **The 404 is `Meeting not found` for another participant as for a stranger**, and comes
  before every 409, the setting's included.
- **A version does not move when Generate leaves with a meeting's last recording** (decision
  9), which puts one requirement on phase 7: the control needs a transcribed recording in
  the page's files list, for the host as well.
- **Three earlier assertions gained the field**, each an exact equality on a failed or
  withheld digest read with the setting on: `meeting-digest-failure`,
  `meeting-digest-events`, and `meeting-digest-deletes`. Every other earlier spec is
  untouched.
- **The e2e specs were red first**: `meeting-digest-request` and
  `meeting-digest-request-refusals` were run with the route declared and its handler not yet
  in the module's `providers`, where eleven of their thirteen cases failed on a 500 — the
  trap the API guide's "Adding a command" names. The two that passed there assert what was
  already built: the read's `availableAction`, and the guard and the id pipe.

**Done when:** the spec is green with every earlier e2e spec; the CI commands pass; the API
guide names the route as the one caller of the edges into `queued` that no recording caused.

### Phase 6: The digest on the meeting page

**Goal:** everyone who can see a meeting watches its digest appear, change, and disappear
without a reload.
**Touches:** frontend

**Tasks:**

- [ ] One stream, two consumers, as a pure move first: `useMeetingFiles` is lifted out of
      `FilesSection` so the page owns the connection; then `watchMeetingFiles` passes a
      `digest` event to an `onDigest`. Vitest green before and after, and for the new event.
- [ ] `fetchMeetingDigest` in the API client; `useMeetingDigest` — fetched at mount and every
      time the stream opens, the higher version kept, polled while queued or generating when
      the stream has given up; `digestPresentation`, a pure function from a digest to what the
      section shows. Vitest for the version rule and a table for the presentation.
- [ ] `DigestSection`, checked against `ui-ux-pro-max`: nothing at all without a status or
      content; "Digest queued", "Generating digest…", "Digest failed" with its reason; Summary,
      Action items, and Decisions with "No action items were identified" and "No decisions
      were recorded"; an owner as a participant's name, a spoken name, or "Unassigned"; the
      out-of-date mark beside the replacement's status; the AI-generated note. Every string
      from the API is rendered as text, and a status change is announced as a file's is.
- [ ] A Claude for the browser suite: `start:e2e-web` boots the API from a test entry point
      that binds a scripted `ClaudeAgentService` — it answers, holds, or fails according to
      directives in the transcript, which a spec already controls through the fake
      transcriber — with the setting on. No spec needs a token or the network.
- [ ] Playwright spec `meeting-digest.spec.ts`: an uploaded recording's page shows queued,
      generating, then the three parts, with no reload; the empty-list copy; the note; a
      second participant sees the same; a second recording marks the digest out of date and
      then replaces it; deleting a recording removes the digest at once and a new one follows;
      a failure shows its reason while the transcript still opens; markup in a digest appears
      as literal characters.

**Done when:** the spec is green with the existing browser suite; Vitest is green; browser
inspection in both themes, and one run against the real Whisper and the real model with the
reference recording, are recorded in the commit body; the CI commands pass; the web guide
covers the section, the shared stream, and the version rule.

### Phase 7: Generate and Retry on the meeting page

**Goal:** the host or a recording's uploader starts or restarts a digest from the page.
**Touches:** frontend

**Tasks:**

- [ ] `requestMeetingDigest` in the API client, with Vitest.
- [ ] The action in `DigestSection`: "Generate digest" or "Retry" as `availableAction` says,
      shown only to the host and to the uploader of a transcribed recording in the files list,
      and to neither while that list holds no transcribed recording (decision 9);
      a 409 refetches the digest, any other error shows inline with Dismiss, as a file retry's
      does. Vitest for who sees it.
- [ ] Playwright spec, with the test entry point able to switch the setting: a recording
      transcribed with it off shows "Generate digest" to the host and its uploader and not to
      another participant, and clicking ends in a digest; a failed digest shows Retry to the
      same two, and with the scripted Claude answering again Retry ends in a digest; neither
      control is present while a digest is current, queued, or generating.

**Done when:** the spec is green with the whole browser suite; a run against the real model is
recorded in the commit body — token removed from Anthropic's reach, upload, Failed, restored,
Retry, Ready; browser inspection in both themes; the CI commands pass; the web guide says who
sees the action and where that is decided.

## Acceptance criteria, by phase

| PRD criterion                                                            | Phase      |
| ------------------------------------------------------------------------ | ---------- |
| Reference recording: status, then the digest, no action and no reload    | 2, 3, 6    |
| Named participant as owner; "Unassigned"                                 | 4, 6       |
| Name outside the meeting, and a shared first name, stay as spoken        | 4, 6       |
| A forced answer naming an outside user is stored as a name, no link      | 4          |
| A renamed participant shows the new name with no generation              | 4          |
| Russian recording, English digest                                        | 1          |
| "No decisions were recorded" / "No action items were identified"         | 1, 6       |
| The AI-generated note                                                    | 6          |
| Same digest after a restart, no request to Anthropic                     | 2          |
| Second participant sees it; a stranger gets 404                          | 2, 6       |
| PDF or PNG starts nothing and changes nothing                            | 2          |
| Second recording: out of date, then replaced                             | 2, 3, 6    |
| Three recordings together: one digest of all, never two generations      | 2          |
| Deleting one of two: gone at once, replacement free of it                | 2, 3, 6    |
| Deleting the only one: no digest, no generation                          | 3          |
| A failed transcription is left out, and joins after its retry            | 2          |
| Anthropic unreachable: file, transcript untouched; digest Failed         | 2, 6       |
| Refused token ends Failed                                                | 1, 2       |
| Reason never contains raw SDK or Anthropic text                          | 2, 6       |
| Retry by host and uploader; no control and a 404 for others              | 5, 7       |
| Time limit exceeded ends Failed, limit named                             | 1, 2       |
| Transcripts too long: Failed and saying so, never a partial digest       | 1, 2       |
| Bad shape: Failed, nothing stored, shown digest unchanged                | 1, 2       |
| Instructions and markup in a transcript: literal text                    | 1, 6       |
| API restart while Generating                                             | 2          |
| Two replicas, one generation                                             | 2          |
| Transcribed while off: no digest, nothing starts when switched on        | 2, 5       |
| Generate for host and uploader; no control and a 404 for others          | 5, 7       |
| Generate not offered, and 409, while current, queued, or generating      | 5, 7       |
| Setting off: nothing generated or offered, stored digest shown, boots    | 2, 3, 5, 7 |
| Setting on, no token: refuses to boot, naming the variable               | 2          |
| Setting on, Anthropic unreachable: boots; uploads and transcription work | 2          |
| Prompt holds no email address, user id, or storage path                  | 1, 2, 4    |
| Cost in the server log, in no response                                   | 2          |
| `test:live` on the reference transcript                                  | 1          |
| README, guides, and `.env.example`                                       | 1–7        |
| CI commands; both e2e suites with no token and Anthropic unreachable     | 1–7        |
