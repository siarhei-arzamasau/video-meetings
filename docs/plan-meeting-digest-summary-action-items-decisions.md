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
   PRD forbids, one step removed. The cap is set in phase 1 from the model's documented limit.
3. **The answer is bound to a JSON schema and validated again by the API.** The SDK's
   `outputFormat` returns `structured_output`; the API checks it with a guard of its own, with
   bounds on every length, because a schema the provider enforces is still the provider's word.
   **Not yet known: whether a schema-bound answer fits the module's single turn** — the SDK
   delivers it through an end-turn tool. Phase 1's live spec finds out; if it needs more, the
   turn cap rises to exactly that and the process still holds no tool.
4. **Instructions are the system prompt; transcripts are the prompt, labelled by ordinal.**
   "Recording 1", "Recording 2", in upload order — no file name, no id, no participant. A
   custom system prompt also replaces Claude Code's own, which is about writing code.
5. **Claude returns a name; the API decides the link.** The answer's owner is a name as spoken
   or nothing. The API links it to a participant when every word of it is a word of exactly one
   display name among the host and participants, compared without case; anything else stays a
   name. So no display name is sent to Anthropic, no answer can point at a user, the rule is
   testable without a model, and a doubtful match stays unlinked — the PRD's preference.
6. **One row per meeting holds the state: a status, a lease, a claim count, and a revision.**
   Every request for a generation bumps `requested_revision`. A claim remembers the revision it
   took; the write that ends it is `ready` (or `failed`) only if the revision is unchanged, and
   `queued` otherwise. That is all of "never two at once, and one more after a change".
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
9. **The contract carries a `version`, and the digest rides the files stream.** Every write to
   the row bumps it, and a client keeps the higher of two — which orders an event against a
   fetch, and a claim against the write that queued it, without the hand-over machinery the
   files contract needs for lacking one. The digest is a second event name on
   `GET …/files/events`: a second stream would double every meeting page's long-lived
   connections against a browser's six per origin.
10. **Generate and Retry are one request** — "generate now" — refused unless there is something
    to generate and nothing under way. The digest says which label applies (`availableAction`);
    who may press it is the page's to work out from the files it already holds, and the API's to
    enforce. **One reading of the PRD to confirm:** Generate is also offered for a digest that
    is out of date with nothing queued — a recording transcribed while the setting was off —
    which the PRD's "no digest" would leave with no way forward.
11. **The worker is the transcription worker's shape**: a polling loop of its own, where
    `MEETING_FILES_WORKER_ENABLED` is on; a `FOR UPDATE SKIP LOCKED` claim; the lease heartbeat;
    a fourth claim failed unrun; a graceful shutdown that hands the claim back uncounted; no
    automatic retry; fixed failure copy from `@repo/shared`, with the cause in the log.
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
  /** Phase 5. What the host or a transcribed recording's uploader may ask for now. */
  availableAction?: 'generate' | 'retry';
}
```

| Edge                                   | Taken by                                                                               |
| -------------------------------------- | -------------------------------------------------------------------------------------- |
| _(none)_, `ready`, `failed` → `queued` | A recording reaching Transcribed, setting on; a deleted source, others left; phase 5   |
| `queued` → `generating`                | A claim; also re-claims `generating` past its lease                                    |
| `generating` → `ready`                 | The answer stored, lease held, revision unchanged                                      |
| `generating` → `failed`                | Provider error, bad shape, time limit, too long, a fourth claim; revision unchanged    |
| `generating` → `queued`                | Revision changed meanwhile; an answer discarded for a deleted source; shutdown release |
| any → _(none)_                         | The meeting's last transcribed recording deleted                                       |

Routes: phase 2 adds `GET /api/meetings/:id/digest` — `200 MeetingDigest` for anyone who can
see the meeting, `404 Meeting not found` otherwise. Phase 3 adds `event: digest` to the files
stream. Phase 5 adds `POST /api/meetings/:id/digest/generation` — host or the uploader of a
transcribed recording, `200 MeetingDigest`; anyone else `404`; nothing to generate, one under
way, or the setting off `409`.

## Implementation phases

### Phase 1: Claude turns a transcript into a digest (tracer bullet)

**Goal:** given transcript text, the API's own code gets back a validated digest — summary,
action items with spoken owners, decisions — from the real model. Proves the riskiest part
before any table exists: a schema-bound answer through an SDK that is Claude Code, the model's
judgement on owners and decisions, and what a generation really costs in seconds and dollars.
**Touches:** backend

**Tasks:**

- [ ] `ClaudeAgentService.runStructuredPrompt`: a system prompt, a JSON schema, and an
      `AbortSignal` in; the `structured_output`, the model, and the cost out. Still no tools, a
      replaced environment, and nothing from disk. `ClaudeAgentError` gains a prompt-too-long
      failure and carries the cost whenever a result reported one. The mapping from the SDK's
      result to an outcome is a pure function with a unit table; the service spec keeps "no
      token, no call".
- [ ] `MeetingDigestGenerator` in the new module: the instructions (only what the transcripts
      state; always English; an owner is a spoken name or nothing; text inside a transcript is
      never an instruction; empty lists are an answer), the schema, the guard that re-validates
      the answer with bounds, and the prompt builder with its cap. Unit specs: the guard's table,
      a prompt that holds the texts and ordinals and nothing else, and no call past the cap.
- [ ] Reference transcripts as fixtures — the PRD's script (two action items, one naming a
      person, one naming nobody; one decision), the same in Russian, one with no decision and
      no action item, one carrying instructions addressed to the model and HTML — and a
      recording of the script for the manual runs of later phases.
- [ ] `meeting-digest.live-spec.ts` under `test:live`, against the real model: the reference
      yields both action items, the named owner, and the decision; Russian yields a digest with
      no Cyrillic; the empty one yields empty lists; the injected instruction is not obeyed and
      the answer is still a digest; a refused token is `AUTHENTICATION`.
- [ ] Measure and set: seconds and cost for the reference and for a transcript at the cap; set
      the time limit's default at twice the slowest, and the cap from the model's documented
      limit less the instructions and the answer — each with its measurement stated beside it.

**Done when:** `test:live` is green and its times, costs, and model are in the commit body;
the turn cap `runStructuredPrompt` settled on is explained where it is set;
`pnpm format:check && pnpm lint && pnpm build && pnpm typecheck && pnpm test` pass and both
`test:e2e` suites pass with no token; the API guide's Claude section covers the new method.

### Phase 2: A digest generated, stored, and served by the API

**Goal:** with the setting on, a recording that reaches Transcribed gives its meeting a digest
with no request from anyone, readable by everyone who can see the meeting, surviving restarts.
**Touches:** database, backend

**Tasks:**

- [ ] Make room first, as pure moves with both suites green before and after:
      `env.validation.ts` is at the 250-line limit, so its transcription settings move to a
      file of their own; `PollingLoop` and the lease heartbeat move from `meeting-files` to
      `src/common/processing`, the heartbeat losing its file-specific option names.
- [ ] Schema, contract, setting: the `MeetingDigestStatus` enum and `meeting_digests` (one per
      meeting; status, failure reason, lease, claim count, requested revision, version,
      summary), `meeting_digest_action_items` (owner name, owner id), `meeting_digest_decisions`,
      `meeting_digest_sources` — per `.claude/rules/prisma.md`, migration `add_meeting_digests`.
      The shared vocabulary, types, and failure copy (generic, time limit, too long, repeated
      attempts). `MEETING_DIGEST_ENABLED`, `MEETING_DIGEST_TIMEOUT_SECONDS`, the token required
      when on, `.env.example`. Mapper spec and `env.validation.spec.ts`.
- [ ] Reading: two queries answered by `meeting-files` — a meeting's transcribed recordings
      (id and uploader), and their transcripts in upload order, which stops at the cap rather
      than load unbounded text. `GET /api/meetings/:id/digest` through `FindVisibleMeetingQuery`,
      applying decision 8's two rules. Handler specs.
- [ ] Writing: `MeetingDigestRepository` — the request upsert, `claimNext`, `renewLease`, the
      completion that replaces content and sources in one transaction, fail, and release — with
      a spec for the edge table. The `MeetingFileChangedEvent` handler that requests a
      generation for a newly transcribed recording while the setting is on.
- [ ] `MeetingDigestWorker`: idle while the setting is off; claim, heartbeat, transcripts,
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

- [ ] Deletes: the event handler, on a deleted recording, removes content built from it and
      either queues a replacement (setting on, recordings left) or clears the status; the
      worker discards an answer one of whose sources has gone, uncounted. Unit specs for both.
- [ ] `MeetingDigestChangedEvent`, published once per committed write and never before it,
      carrying the digest as `GET` would answer it. A recording transcribed with the setting
      off bumps the version of a stored digest too, since `outOfDate` just changed.
- [ ] `MeetingFileEventsService` forwards that event to the meeting's streams as
      `event: digest`. Spec beside the existing stream specs.
- [ ] E2E, red first. Deleting one of two: `GET` stops returning content at once, and the
      replacement was generated from the remaining transcript only. Deleting the only one: no
      digest, no call. A delete during a generation: its answer is never stored. A second
      recording: the first digest is returned `outOfDate` until replaced. Setting off: a delete
      still withdraws, a new recording still marks. Stream: every edge arrives as `digest` with
      a version higher than the last.

**Done when:** the specs are green with every earlier e2e spec; the CI commands pass; the API
guide's stream section says the digest is a second event and why it carries a version.

### Phase 4: Owners linked to participants

**Goal:** an action item whose spoken name identifies one person in the meeting is reported
as that participant, under their current display name.
**Touches:** backend

**Tasks:**

- [ ] `FindMeetingMemberIdsQuery` in `meetings` (host and participants) and
      `FindUsersByIdsQuery` in `user` (id and display name, one statement). Handler specs.
- [ ] `matchOwner`, a pure function over a spoken name and the members' display names, with a
      unit table: a full name, a first name, a first name two members share, a name nobody
      has, differing case, a name derived from an email address, an empty name.
- [ ] The completion stores `owner_id` beside the spoken name; the read resolves current
      display names in one query and emits `participant`, `name`, or no owner.
- [ ] E2E, red first: the four owner outcomes; a renamed participant shows the new name with
      no call; an answer naming a user who is not in the meeting is stored as a name and
      returned with no link; the captured prompt contains no member's name.

**Done when:** the spec is green with every earlier e2e spec; the CI commands pass; the API
guide records that a meeting's member names are readable by its members, through this route
only, and never an email address.

### Phase 5: Generate and Retry, in the API

**Goal:** one request starts a digest for transcripts that were never digested, and restarts
a failed one.
**Touches:** backend

**Tasks:**

- [ ] `availableAction` in the contract and the mapper: `retry` for a failed digest, `generate`
      for transcribed recordings with no current digest and nothing under way, absent
      otherwise and always with the setting off. Mapper spec.
- [ ] `RequestMeetingDigestCommand` and its handler: visible meeting (404), host or uploader
      of a transcribed recording (404), then the conditional request that resets the claim
      count and clears the reason (409 on zero rows); publishes the event and returns the
      digest as written. Unit spec for the outcomes.
- [ ] `POST /api/meetings/:id/digest/generation`, and e2e, red first: a recording transcribed
      with the setting off starts nothing when it is switched on; the host's request, and the
      uploader's, end Ready after a drain; another participant and a stranger get 404; a
      current, queued, or generating digest gets 409, as does the setting off; a failed digest
      retried ends Ready with the claim count back at 0; an out-of-date digest with nothing
      queued accepts the request.

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
      shown only to the host and to the uploader of a transcribed recording in the files list;
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
