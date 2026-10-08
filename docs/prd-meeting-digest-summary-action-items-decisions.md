# PRD: Meeting digest — summary, action items, and decisions from transcripts

**Date**: 2026-10-08
**Status**: Draft

## Goal

Once a meeting's recordings are transcribed, Claude — reached through the Claude Agent SDK —
turns the transcripts into a digest of the meeting: a summary, the action items with the person
responsible for each where one was named, and the decisions that were made. The digest is
stored and shown on the meeting page, so a participant learns what was agreed and who does
what without reading a transcript.

## User scenarios

- The user uploads a recording to a meeting > once it is transcribed, the meeting page shows
  "Generating digest…" and then the digest — summary, action items, decisions — without the
  user doing anything and without a reload.
- Another participant opens the meeting later > they see the same digest.
- An action item names someone who is in the meeting > it shows that participant as its owner.
  It names someone who is not, or a name two participants share > it shows the name as it was
  spoken. It names nobody > it shows "Unassigned".
- The meeting was held in Russian > the digest is in English.
- A second recording is transcribed in a meeting that already has a digest > the current
  digest stays readable, marked as being updated, and is then replaced by one that covers both
  recordings.
- The user deletes a recording the digest was built from > the digest disappears at once and
  is replaced by one built from the recordings that remain; with none left, the meeting has no
  digest.
- Generation fails (Anthropic cannot be reached, the token is refused, the time limit is
  exceeded, the transcripts are too long) > the section shows "Digest failed" with a reason,
  and the meeting's files and transcripts are unaffected.
- The host, or the uploader of one of the meeting's transcribed recordings, clicks "Retry" on
  a failed digest > it is queued and generated again.
- The host opens a meeting whose recordings were transcribed before the feature was switched
  on > they see "Generate digest", click it, and the digest is generated.
- The user opens a meeting with no transcribed recording > there is no digest section.

## In scope

- **One digest per meeting**, built from every recording in it that is transcribed — file
  status `ready`, transcription status Transcribed, not deleted — and from nothing else.
- **Three parts, in a fixed shape:**
  - **Summary** — prose: what the meeting was about and how it ended.
  - **Action items** — a list; each is what has to be done and who owns it.
  - **Decisions** — a list; each is one thing the meeting decided.

  Each holds only what the transcripts state. A meeting with no action items or no decisions
  is a legitimate result, shown as "No action items were identified" or "No decisions were
  recorded" under its heading — not as a missing heading.

- **Always in English**, whatever language was spoken.
- **The owner of an action item** is one of three things:
  - **a participant** — when the spoken name identifies exactly one person among the meeting's
    host and participants; shown under that person's current display name;
  - **a name as spoken** — when it identifies nobody in the meeting, or more than one person;
  - **unassigned** — when the transcripts name nobody for it.
- **Automatic generation**: every time a recording in the meeting reaches Transcribed, with
  no user action.
- **A digest status per meeting**, separate from every file's status and every transcription's:

  | Status     | Meaning                                      | The section shows                                    |
  | ---------- | -------------------------------------------- | ---------------------------------------------------- |
  | Queued     | Waiting to be picked up                      | "Digest queued"                                      |
  | Generating | Claude is working on it                      | "Generating digest…"                                 |
  | Ready      | The digest is stored                         | Summary, Action items, Decisions                     |
  | Failed     | It could not be generated                    | "Digest failed", the reason, and Retry where allowed |
  | _(none)_   | No transcribed recording, or never generated | Nothing, or "Generate digest" where allowed          |

- **The digest follows the meeting's recordings**, by two rules:
  - **A digest is shown only while every recording it was built from still exists.** Deleting
    one withdraws the digest at once — deleted content does not stay readable while a
    replacement is generated — and queues a new one from what remains.
  - **A digest that does not cover every transcribed recording says so.** When a recording is
    added or re-transcribed, the stored digest stays readable, marked out of date, beside the
    status of its replacement; if that replacement fails, it stays, with the failure.
- **Live updates**: a status change, a new digest, and a withdrawal reach every open meeting
  page without a reload.
- **Visible to everyone who can see the meeting** — host and participants — and to nobody else.
- **"Generate digest"**, for a meeting that has a transcribed recording, no digest, and none
  queued or generating: recordings transcribed before the feature was switched on, or while
  it was off.
- **"Retry"** on a failed digest.
- **Generate and Retry belong to the host and to the uploader of any transcribed recording in
  the meeting** — the people who may already retry a transcription there. Other participants
  see the status and the failure without the action.
- **A fixed note on the section that the digest is AI-generated** and may be wrong.
- **Recovery without user action**: an API restart or shutdown during a generation leaves the
  digest queued again, never stuck in Generating and never Failed on account of the restart.
- **A deployment setting, off by default.** Switched off, nothing is sent to Anthropic and
  neither Generate nor Retry is offered; digests already stored stay readable, and the two
  rules above still withdraw and mark them.
- **Stored in the database**: the summary, each action item with its owner, each decision, the
  status, and the failure reason.
- **Documentation**: `README.md`, the root, API, and web guides, and `apps/api/.env.example`.

## Out of scope

- Editing a digest, marking an action item done, and due dates or priorities on action items.
- Regenerating a digest that is Ready, and choosing which recordings it is built from.
- A digest per recording.
- Assigning or correcting an owner by hand, notifying an owner, and a list of one person's
  action items across meetings.
- Working out who said what. The transcript is plain text with no speaker labels, so an owner
  comes only from a name that was spoken.
- Any output language other than English, and translating the transcripts themselves.
- Files that are not recordings — PDFs, documents, text — as input to the digest.
- Sending the digest anywhere outside the app (email, Slack, an issue tracker) and exporting it.
- Choosing the model or the instructions per meeting or per user.
- A per-meeting or per-user opt-out and any consent prompt: the deployment setting is the only
  control over what is sent to Anthropic.
- Spend limits and quotas, and showing the cost of a digest to users.
- Generating digests automatically for transcripts that already exist when the feature is
  switched on.
- A digest that appears word by word as it is written, and a progress percentage.
- Digests on the dashboard or the meetings list, and search across them.
- Meetings in progress — only uploaded recordings.

## Technical constraints

- **Transcript text leaves the deployment, which the transcription PRD ruled out.**
  [That PRD](prd-local-whisper-transcription-status.md) promised that neither recording bytes
  nor transcript text reach a third party. This is the first feature to send meeting content
  to one, which is why it is a deployment-wide setting that ships off. Recording bytes still
  never leave.
- **What is sent is bounded**: transcript text and, at most, the display names of the
  meeting's host and participants. No email address, user id, token, or storage path.
- **Claude is reached only through the existing `claude-agent` module**
  ([API guide](../apps/api/AGENTS.md#claude-srcmodulesclaude-agent)). The Claude Agent SDK is
  Claude Code as a library: each call starts a process of about 220 MB. That module gives the
  process no tools, a replaced environment, and no settings from disk, and this feature
  loosens none of that.
- **`ANTHROPIC_AUTH_TOKEN` is the only credential and there is no fallback.** It is optional
  at boot today because nothing needs it. With this feature switched on it is needed, and its
  absence must be found at boot — as a missing `TRANSCRIPTION_API_URL` is — not at the first
  digest.
- **A transcript is untrusted input and the digest is untrusted output.** Anything can be said
  in a recording, including text addressed to the model. The digest is rendered as plain text;
  an owner can only ever be linked to the host or a participant of that meeting, whatever the
  model answers; and an answer that does not fit the digest's shape is a failure, never a
  partly stored digest.
- **A wrong owner is worse than no owner.** Whisper writes a name as it hears it — misspelt, or
  in another script. When a match is in doubt, the owner stays a name as spoken.
- **No user can read another user's name today.** The meeting page shows a participant count,
  files carry only `uploaderId`, and no route returns anyone's profile but the caller's. An
  owner shown as a participant makes the display names of a meeting's host and participants
  readable by everyone who can see that meeting — and only those, and never an email address.
- **A meeting's participants are fixed when it is created**; no route changes them. A display
  name can change, and a linked owner shows the current one.
- **A meeting's transcripts are not bounded by what one request can carry.** A meeting holds
  up to 50 files of up to 1 GiB each, and hours of speech are hundreds of thousands of words.
  A digest of part of the transcripts must never be presented as the digest of the meeting.
- **Every generation is a paid request to Anthropic**, and the SDK reports what each cost.
  Generations happen only because a recording changed or someone clicked Generate or Retry —
  never on a timer — and a meeting never has two running at once.
- **How long a generation takes is the provider's to decide.** It has to be bounded by a time
  limit, and exceeding it ends in Failed with a reason that names the limit.
- **Uploads and transcription never wait on a digest and never fail because of one.** The API
  boots and serves both with Anthropic unreachable.
- **Several API replicas may run at once**; a change to a meeting's recordings produces one
  generation, not one per replica.
- **Transcripts are files on disk; the digest is rows in the database.** New tables follow
  [`.claude/rules/prisma.md`](../.claude/rules/prisma.md).
- **Reading the digest and following it live both need the bearer token**, which a plain link
  or a native `EventSource` cannot send. The page's one live channel today is the files stream,
  whose events are files; a digest belongs to the meeting.
- **The status vocabulary and all fixed copy are shared** — the API and the web app take them
  from `@repo/shared`.
- **Failure reasons shown to users are fixed copy.** The SDK's and Anthropic's own error text
  stays in the server log.
- **Automated tests cannot depend on Anthropic.** `pnpm test` and both `test:e2e` suites
  substitute a fake, and cannot load the ESM-only SDK in any case. Only `test:live` sends a
  real request; it costs money, needs a token, and is not run by CI.
- **New transcripts need transcription switched on.** With this feature on and transcription
  off, Generate on existing transcripts is all that produces a digest.

## Acceptance criteria

Unless a criterion says otherwise, the digest setting is on with a working token, and
transcription is on with a local Whisper running. The **reference recording** is a recording
of a known script that states two action items — one naming a participant of the meeting by
their display name, one naming nobody — and one decision.

**Generation and content**

- [ ] Uploading the reference recording to a meeting with no digest: with no user action and
      no reload, the meeting page shows the digest status and then a digest with a summary,
      both action items, and the decision.
- [ ] The action item that names the participant shows that participant's display name as its
      owner; the other shows "Unassigned".
- [ ] An action item naming someone who is not in the meeting shows the name as spoken, linked
      to no user. So does one naming a first name that two participants share.
- [ ] With the model's answer forced to name a user outside the meeting as an owner, the
      stored owner is a name as spoken and the API returns no link to that user.
- [ ] After a linked participant changes their display name, the digest shows the new name
      with no new generation.
- [ ] A recording spoken in Russian produces a summary, action items, and decisions in English.
- [ ] A recording that states no decision shows "No decisions were recorded" under Decisions;
      one that states no action item shows "No action items were identified".
- [ ] The section carries the note that the digest is AI-generated.
- [ ] After an API restart the same digest is shown, and no request was sent to Anthropic to
      show it.
- [ ] A second participant sees the same digest; a user who cannot see the meeting gets a 404
      for it.
- [ ] Uploading a PDF or a PNG starts no generation and changes no digest.

**Following the recordings**

- [ ] A second recording transcribed in a meeting with a digest: the first digest stays
      readable and marked out of date until it is replaced, and the replacement contains a
      statement made only in the second recording.
- [ ] Three recordings uploaded together: the final digest contains a statement from each, and
      at no moment were two generations running for the meeting.
- [ ] Deleting one of two transcribed recordings: the digest stops being shown and stops being
      returned by the API at once, and the one that replaces it contains nothing stated only
      in the deleted recording.
- [ ] Deleting the meeting's only transcribed recording leaves no digest, shown or returned,
      and starts no generation.
- [ ] A recording whose transcription failed contributes nothing and does not hold up the
      digest of the others; once its transcription is retried and succeeds, the digest is
      replaced by one that includes it.

**Failure, retry, and recovery**

- [ ] With Anthropic unreachable, an uploaded recording reaches `ready`, is transcribed, and
      its transcript opens; the digest ends in Failed with a reason on the section.
- [ ] With a token Anthropic refuses, the digest ends in Failed.
- [ ] The reason shown for a failure never contains the SDK's or Anthropic's raw error text,
      verified by forcing an error with a recognisable message.
- [ ] After the cause is removed, Retry by the host ends in Ready. The uploader of a
      transcribed recording can retry too; another participant sees no Retry control and the
      API answers their request with 404.
- [ ] A generation that exceeds the time limit ends in Failed with a reason naming the limit.
- [ ] For a meeting whose transcripts are together longer than one request can carry: either
      the digest contains a statement made only at the end of the last recording, or it ends
      in Failed with a reason saying the recordings are too long. It is never Ready without
      that statement.
- [ ] With the model's answer forced into a shape that is not a digest, the status is Failed,
      nothing of that answer is stored, and a digest that was already shown is unchanged.
- [ ] A transcript containing instructions addressed to the model and HTML markup produces a
      digest in which any such markup appears as literal text.
- [ ] Restarting the API while a digest is Generating: it reaches Ready with no user action,
      is at no point left in Generating indefinitely, and is not marked Failed by the restart.
- [ ] With two API replicas running, one transcribed recording produces one generation.

**Generate, and the setting**

- [ ] A meeting with a recording transcribed while the setting was off shows no digest after
      the setting is switched on, and no generation starts by itself.
- [ ] On that meeting the host and the recording's uploader see "Generate digest", and
      clicking it ends in Ready. Another participant sees no such control and the API answers
      their request with 404.
- [ ] Generate is not offered while a digest exists, is queued, or is generating, and the API
      answers such a request with 409.
- [ ] With the setting off: a newly transcribed recording starts no generation, neither
      Generate nor Retry is offered, a digest stored earlier is still shown, and the API boots
      with no token present.
- [ ] With the setting on and no token, the API refuses to boot with a message naming
      `ANTHROPIC_AUTH_TOKEN`.
- [ ] With the setting on and Anthropic unreachable, the API boots, and uploads, downloads, and
      transcription work.

**What leaves, what is recorded, and the checks**

- [ ] The text handed to Claude for a generation, captured by the fake, contains no email
      address, user id, or storage path.
- [ ] Each generation writes its cost, as the SDK reported it, to the server log, and no API
      response contains it.
- [ ] `test:live`, against the real model, turns the reference recording's transcript into a
      digest that contains both action items, the named owner, and the decision.
- [ ] `README.md`, the root, API, and web guides, and `apps/api/.env.example` describe the
      feature, its setting, and what it sends to Anthropic.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm build`, `pnpm typecheck`, and `pnpm test` pass,
      and both `test:e2e` suites pass with no token and with Anthropic unreachable.
