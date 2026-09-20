# PRD: User profile page and profile editing

**Date**: 2026-09-20
**Status**: Draft

## Goal

A signed-in user can see who the platform thinks they are and correct it: set the name
other people see instead of the one derived from their email address, put a face to that
name with an avatar, and rotate their password without support involvement. The avatar then
follows the user wherever the app shows who is signed in.

## User stories

- User opens their profile from the home page > sees their avatar (or initials), display
  name, email, and the date they joined, with a way to edit.
- User changes their display name and saves > the profile, the home page greeting, and any
  other place that shows the signed-in user use the new name on the next render.
- User uploads a new avatar > it replaces the old one immediately on the profile and in the
  home page header; the old image is no longer served.
- User removes their avatar > the profile and the header fall back to initials derived from
  the display name.
- User selects a file that is not an image, is too large, or is empty > the form refuses it
  before upload with a message that says which rule was broken; nothing is sent.
- User enters their current password, a new password, and a confirmation, and saves > the
  password changes, the form confirms it, and the next sign-in only works with the new one.
- User enters a wrong current password > the change is rejected with a message that names
  the current-password field, and the new password is not applied.
- User enters a new password shorter than the minimum, longer than the maximum, or a
  confirmation that does not match > the form refuses it before the request is sent.
- User enters a new password identical to the current one > the change is rejected.
- User opens the profile page with an expired or missing token > they are redirected to
  sign-in, exactly as on the home page and the meeting page today.
- User leaves the edit page with unsaved changes > nothing is saved; the profile still shows
  the last saved values.

## In scope

- **Profile page** (`/profile`): avatar, display name, email, join date, link to edit.
  Reachable from the home page header where the signed-in user is shown.
- **Edit page** (`/profile/edit`) with three independently saved sections:
  - **Display name**: single text field, required, trimmed, bounded in length. The bounds
    live in `@repo/shared` like the email and password bounds do, so the browser rejects
    what the API would reject.
  - **Avatar**: pick an image file, preview it, upload it, or remove the current one. Accepted
    types are PNG, JPEG, and WebP. Size cap is a separate, much smaller constant than the
    meeting-file cap. The API stores a normalised square rendition and serves that, so every
    avatar the app draws is the same shape and size regardless of what was uploaded.
  - **Change password**: current password, new password, confirmation. The current password
    must verify against the stored hash before anything changes. New password follows the
    same bounds and non-blank rule as registration.
- **API**: endpoints to update the display name, upload and delete the avatar, fetch an
  avatar, and change the password. All are authorised as the current user only; no endpoint
  lets a user edit anyone else. Password change lives in `auth` (it owns credentials);
  name and avatar live in `user` (it owns the record), per the module split design.
- **Shared contract**: the `User` type gains the avatar reference; the display name and avatar
  bounds and the user-facing validation messages are exported from `@repo/shared`.
- **Avatar display**: the home page header shows the avatar next to the sign-out control.
  The profile page shows it large. Both fall back to initials when there is no avatar.
- **Web app guide and API guide** updated in the same change, both `CLAUDE.md` and
  `AGENTS.md`, plus `.env.example` for any new variable.
- **Tests**: unit tests for the new handlers and forms, API e2e coverage for every new
  endpoint including the wrong-current-password and cross-user cases, and a browser test for
  the name change and the avatar upload flow.

## Out of scope

- Changing the email address. It is the login identifier and needs a verification flow.
- Account deletion or deactivation.
- Invalidating other sessions after a password change. Tokens are stateless and expire in one
  hour; a revocation list is a separate decision (see constraints).
- Cropping, rotating, or editing the avatar in the browser. The user uploads a file; the
  server normalises it.
- Showing other users' avatars anywhere (participant lists, meeting host). This PRD wires
  the signed-in user's own avatar only; the endpoint design must not prevent that later.
- Public profiles or any profile visible to unauthenticated visitors.
- Password strength meters, breach checks, or password history.
- Two-factor authentication or email notification on password change.

## Technical constraints

- **The display name is currently derived from the email at registration** and never set
  by the user. After this change it is user-owned. Registration keeps deriving the initial
  value; nothing else may overwrite a name the user has set.
- **The token lives in `localStorage`**, so profile pages are gated on the client like the
  home page and the meeting page, and an `<img>` cannot send the bearer header. Avatars are
  fetched with the token and rendered from a blob, the way meeting-file thumbnails already
  are. The avatar endpoint therefore requires authentication like every other endpoint.
- **Cache busting is required.** The `User` shape must carry something that changes when the
  avatar changes (a version or a content hash), or a replaced avatar keeps showing the old
  image in the header until reload.
- **Avatar bytes go through the existing local-disk storage** under `MEETING_FILES_DIR`, in
  their own subtree, and are processed with the same image tooling the meeting-file worker
  uses for thumbnails. Unlike meeting files, an avatar is processed synchronously within
  the upload request: the user is waiting for the preview, and the file is small. If the
  image cannot be decoded, the upload fails and the previous avatar stays.
- **Password change verifies against argon2id** with the same hashing rules as login; a
  wrong current password must return the same shape of error as a bad login, without
  revealing anything else. The check is rate-limited the same way login is, if login is.
- **Stateless JWT with `JWT_EXPIRES_IN_SECONDS` (default 3600)** means a password change
  does not sign out other devices. The edit page must say so plainly next to the password
  form. If that is unacceptable, session revocation becomes its own PRD.
- **Shared values, not copies.** Name bounds, avatar type list, avatar size cap, and the
  validation messages must be exported from `packages/shared` and imported by both apps.
- **Prisma migration** adds the avatar reference to `users`; an existing row with no avatar
  must remain valid, so the column is nullable.
- **Every new environment variable** goes into `apps/api/.env.example` and
  `env.validation.ts`; every new API endpoint is covered by `test:e2e`.
- Everything produced is in English, per the root guide.

## Acceptance criteria

- [ ] `/profile` renders avatar or initials, display name, email, and join date for the
      signed-in user, and redirects to sign-in without a valid token.
- [ ] `/profile/edit` saves a new display name; the home page greeting shows it after
      navigation without a full reload.
- [ ] A blank, whitespace-only, or over-long display name is rejected in the browser and by
      the API with the same message, sourced from `@repo/shared`.
- [ ] Uploading a PNG, JPEG, or WebP within the size cap replaces the avatar; the profile
      page and the home page header show the new image without a page reload.
- [ ] Uploading a non-image, an over-size file, an empty file, or a file that cannot be
      decoded is rejected with the matching message and the previous avatar is still served.
- [ ] Removing the avatar makes the profile and the header show initials, and the previous
      avatar URL returns 404.
- [ ] Every avatar the app draws is the same square dimensions regardless of the uploaded
      image's size or aspect ratio.
- [ ] Changing the password with the correct current password succeeds; signing in with the
      old password then fails and with the new password succeeds.
- [ ] A wrong current password, a mismatched confirmation, or a new password outside the
      shared bounds leaves the stored hash unchanged and returns a field-level error.
- [ ] No profile endpoint accepts a user id in the path or body; each acts on the caller from
      the token, and e2e tests prove one user cannot read or change another's avatar or name.
- [ ] Avatar endpoints return 401 without a token, like every other authorised endpoint.
- [ ] `User` in `@repo/shared` carries the avatar reference and a cache-busting value, and
      `GET /api/auth/me` returns them.
- [ ] Root, web, and API guides are updated in the same commit, and
      `diff CLAUDE.md AGENTS.md` prints nothing in all three directories.
- [ ] CI order passes on the finished tree: format:check, lint, build, typecheck, test, plus
      `test:e2e` for both apps.
