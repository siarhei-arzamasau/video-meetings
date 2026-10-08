# PRD: Local Whisper transcription of meeting recordings, with status

**Date**: 2026-10-07
**Status**: Draft

## Goal

Every audio or video file uploaded to a meeting is transcribed automatically by a Whisper
`small` model running inside the deployment, and the meeting page shows each recording's
transcription status and, once it is done, a link to the transcript. Participants get the text
of a recording without it being sent to a third party, and can tell whether a transcript is
still coming, finished, or failed.

## User scenarios

- The user uploads an MP3 or MP4 to a meeting > the file becomes downloadable as soon as its
  own checks pass, and its row shows "Queued for transcription" and then "Transcribing…"
  without the user doing anything.
- The user keeps the meeting page open while a recording is transcribed > the status on its
  row changes without a reload and ends with an "Open transcript" link.
- The user clicks "Open transcript" > the plain-text transcript of that recording opens.
- Another participant of the meeting opens the page > they see the same status for every
  recording and can open the same transcripts.
- A transcription fails (Whisper is not running, the recording cannot be decoded, the time
  limit is exceeded) > the row shows "Transcription failed" with a reason, and the file itself
  stays ready and downloadable.
- The uploader or the host clicks "Retry" on a failed transcription > the status returns to
  "Queued for transcription" and the recording is transcribed again.
- The user uploads a PDF or an image > its row shows no transcription status at all.
- The user deletes a recording, before, during, or after its transcription > the file and its
  transcript are gone and the transcript can no longer be opened.

## In scope

- **Automatic transcription of every accepted audio and video type** — MP4, M4V, WebM, MP3,
  M4A, WAV — started with no user action once an upload is accepted, for direct and chunked
  uploads alike. MP4 and MP3 are the two the acceptance criteria exercise in full.
- **Whisper `small`, self-hosted**, with the spoken language detected automatically.
- **A transcription status per recording, separate from the file's own status.** A file is
  ready and downloadable as soon as its checks pass; transcription neither delays that nor,
  when it fails, undoes it.

  | Status       | Meaning                          | The row shows                                               |
  | ------------ | -------------------------------- | ----------------------------------------------------------- |
  | Queued       | Accepted, waiting to be picked   | "Queued for transcription"                                  |
  | Transcribing | Whisper is working on it         | "Transcribing…"                                             |
  | Transcribed  | The transcript is stored         | An "Open transcript" link                                   |
  | Failed       | It could not be transcribed      | "Transcription failed", the reason, and Retry where allowed |
  | _(none)_     | Not a recording, or not eligible | Nothing                                                     |

- **The status is part of what the API reports for each file**, so it is the same for every
  client and every viewer of the meeting.
- **Live updates**: a status change reaches every open meeting page without a reload.
- **"Open transcript"** for anyone who can see the meeting's files (host and participants).
- **Retry of a failed transcription** by the uploader or the host — the same two people who
  may already delete or retry a file. Other participants see the failure without the action.
- **Recovery without user action**: an API restart or shutdown in the middle of a
  transcription leaves the recording queued again, never stuck in Transcribing and never
  Failed on account of the restart.
- **A recording whose own checks fail** (file status `failed`) is not transcribed and shows
  only the file's failure; once a file retry succeeds, it is transcribed like a fresh upload.
- **Transcription stays a deployment setting.** Switched off, no row shows a transcription
  status and uploads behave exactly as they do today.
- **A documented way to run Whisper `small` locally** and point the API at it, in `README.md`
  and the agent guides, with the matching `.env.example` entries.

## Out of scope

- Reading the transcript inline on the meeting page, searching it, editing it, or exporting it
  in another format.
- Timestamps, speaker labels, and subtitle formats (SRT, VTT) — the transcript is plain text.
- Summaries, translation, or any further AI processing of the transcript.
- Choosing the model or the language per file, per meeting, or per user.
- A progress percentage or an estimated time remaining.
- Transcribing files uploaded before the feature was switched on, and any manual "transcribe
  this file" action for a file that has no status. Those files show no status.
- Cancelling a running transcription other than by deleting the file.
- Hosted or third-party transcription services as a supported configuration of this feature.
- GPU-specific tuning, and any throughput guarantee beyond the time limit below.
- Notifications (email, push) when a transcript is ready.
- Transcribing a meeting live — only uploaded files.

## Technical constraints

- **Transcription already exists as a disabled pipeline step, with a different contract.**
  Behind `MEETING_FILES_TRANSCRIPTION_ENABLED` (off by default) a recording stays in the
  file status `processing` until its transcript is written, a transcription failure fails the
  whole file, and nothing in the web app mentions a transcript. This PRD replaces that
  contract; the
  [phase 3 plan](plans/2026-09-19-meeting-file-upload-phase-3.md) is the record of the current
  one and is not edited.
- **No recording bytes and no transcript text leave the deployment.** Whisper is reached only
  at a deployment-local address, and the feature needs no credential for an outside service.
- **Whisper cannot run inside the API's Node process.** It is CPU-bound and would starve the
  event loop that serves every request
  ([research §7](research-meeting-upload.md#7-transcription-phase-3)).
- **`small` costs about 0.5 GB to download and roughly 2 GB of memory once loaded** (Whisper's
  published figures). The first run needs the network to fetch the model; every later run must
  work offline.
- **Throughput is hardware-dependent and unmeasured on the target machines.** The current
  600-second bound (`TRANSCRIPTION_TIMEOUT_SECONDS`) was not chosen for a local `small` model
  or for uploads of up to 1 GiB. The limit has to be set from a measurement, and a recording
  that exceeds it must end in Failed with a reason that says so rather than run indefinitely.
- **Video containers must be accepted as uploaded.** Not every self-hosted Whisper server
  decodes MP4 or WebM itself (research §7); the user is never asked to convert a file.
- **The app must boot, and uploads must work, with Whisper not running.**
  `pnpm dev` and `pnpm start:dev` stay free of Whisper set-up ([root guide](../AGENTS.md)), so
  running it locally is opt-in.
- **Several API replicas may process files at once**; a recording is transcribed once, not
  once per replica.
- **The status vocabulary is shared.** The API and the web app take it from `@repo/shared`
  rather than each restating it.
- **The transcript route needs the bearer token**, which a plain link cannot send — thumbnails
  and downloads are fetched with the header for the same reason
  ([web guide](../apps/web/AGENTS.md)). Live updates travel over the existing files stream.
- **Failure reasons shown to users are fixed copy.** Whisper's own error text stays in the
  server log, as every other processing failure's cause does.
- **Automated tests cannot depend on a running Whisper.** The unit and e2e suites substitute a
  fake transcriber, as they do today; the real model is covered by a recorded manual run.

## Acceptance criteria

Unless a criterion says otherwise, transcription is switched on and a local Whisper `small` is
running.

- [ ] Uploading an MP3 with speech: the file reaches `ready` and can be downloaded before its
      transcription finishes, and its row goes Queued → Transcribing → Transcribed with no
      reload.
- [ ] The same holds for an MP4 with an audio track, uploaded directly and, for a file over
      100 MB, through the chunked upload.
- [ ] An M4A, a WAV, a WebM, and an M4V each reach Transcribed.
- [ ] "Open transcript" on a reference recording of a known sentence shows text containing
      that sentence's words (case and punctuation ignored).
- [ ] A PDF and a PNG show no transcription status, and their upload, thumbnail, and download
      behave as before.
- [ ] A second participant sees the same statuses and can open the transcript; a user who
      cannot see the meeting gets a 404 for it.
- [ ] Two recordings uploaded together each show their own status, and one failing leaves the
      other unaffected.
- [ ] With Whisper stopped, an uploaded MP3 reaches file status `ready`, its transcription
      ends in Failed with a reason on the row, and Download still works.
- [ ] After Whisper is started again, Retry by the uploader ends in Transcribed. The host can
      retry too; another participant sees no Retry control and the API answers their retry
      request with 404.
- [ ] A recording that passes the type check but cannot be decoded ends in Failed, with the
      file still `ready`.
- [ ] A recording that exceeds the time limit ends in Failed with a reason naming the limit.
- [ ] The reason shown for a failure never contains Whisper's raw error text, verified by
      forcing an error with a recognisable message.
- [ ] Restarting the API while a recording is Transcribing: the recording reaches Transcribed
      with no user action, is at no point left in Transcribing indefinitely, and is not marked
      Failed by the restart.
- [ ] Deleting a recording while it is Transcribing removes its row, leaves no transcript
      stored once the work stops, and makes the transcript URL answer 404.
- [ ] With outbound network access blocked and the model already downloaded, an upload is
      transcribed successfully.
- [ ] Following the documented local set-up without changing any setting transcribes with the
      `small` model, as shown by the Whisper service's start-up output or the API's log.
- [ ] With transcription switched off, no row shows a transcription status, recordings reach
      `ready` as they do today, and the API boots with no Whisper setting present.
- [ ] With transcription switched on and Whisper not running, the API boots and uploads and
      downloads work.
- [ ] A recording uploaded while transcription was off shows no status after it is switched
      on.
- [ ] `README.md`, the root, API, and web guides, and `apps/api/.env.example` describe the
      feature and the local Whisper set-up.
- [ ] `pnpm format:check`, `pnpm lint`, `pnpm build`, `pnpm typecheck`, and `pnpm test` pass,
      and both `test:e2e` suites pass with no Whisper running.
