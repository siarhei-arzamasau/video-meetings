# User profile — implementation plan

**PRD:** [docs/specs/2026-09-20-user-profile-prd.md](../specs/2026-09-20-user-profile-prd.md)
**Date:** 2026-09-20

Six phases, in three backend-then-frontend pairs: display name, password change, avatar.
Each phase ends on a green tree with the guides updated in the same commit, so the work can
stop after any of them. Phase 1 is the tracer bullet: one shared bound, one command, one
endpoint, one e2e suite, exercising every layer the later phases will reuse.

Every phase ends with the CI order on the finished tree (format:check, lint, build,
typecheck, test) plus `pnpm --filter=@repo/api test:e2e`, and the web phases also run
`pnpm --filter=@repo/web test:e2e`. Every phase updates the affected guides in both their
`CLAUDE.md` and `AGENTS.md`, verified with `diff`.

## Phases

### Phase 1: Display name — API

**Goal:** The display name becomes user-owned. A signed-in user can set it through the API,
and the bounds and messages the browser will reuse exist in one place.
**Touches:** backend, shared

**Tasks:**

- [ ] Export the display name bounds (min and max length) and the user-facing validation
      message from `@repo/shared`, next to the email and password bounds. Registration keeps
      deriving the initial name and nothing else overwrites a name the user has set.
- [ ] Add an update-display-name command and handler to the `user` module (trim, reject
      blank and whitespace-only, enforce the shared bounds) and expose it as an authorised
      endpoint that acts on the caller from the token. No user id in the path or body.
- [ ] Unit tests for the handler and the DTO: trimming, blank, over-long, and the message
      text coming from `@repo/shared`.
- [ ] e2e: a valid name is saved and `GET /api/auth/me` returns it; blank, whitespace-only,
      and over-long names return 400 with the shared message; no token returns 401; one user
      cannot change another user's name.
- [ ] Update the API guide (both files) with the endpoint, the module it lives in, and the
      "registration derives, user owns" rule.

**Done when:** With a valid token, the endpoint changes the name and `me` returns the new
value; every rejection case above is covered by a passing e2e test.

### Phase 2: Profile page and display name — web

**Goal:** The user can see their profile and change their name in the browser, and the home
page reflects the change without a reload.
**Touches:** frontend

**Tasks:**

- [ ] Add `/profile`: gated on the client like the home page, showing initials, display name,
      email, join date, and a link to edit. Link to it from the home page header where the
      signed-in user is shown. Redirect to sign-in without a valid token.
- [ ] Add `/profile/edit` with the display name section: client-side validation using the
      shared bounds and message, field-level errors from the API, and a save that updates the
      signed-in user state so the home greeting shows the new name on navigation without a
      full reload. Leaving with unsaved changes saves nothing.
- [ ] Add the API client function for the display name endpoint, with unit tests for the
      request shape and the error mapping.
- [ ] Unit tests for the two pages: gating, rendering of every field, validation before the
      request, and the error message for a rejected name.
- [ ] Playwright: profile renders for a signed-in user, redirects without a token, a name
      change is visible in the home greeting after navigation. Update the web guide (both
      files) with the two routes and the initials fallback.

**Done when:** A user can open the profile, change their name, and see it on the home page,
with the browser suite proving the flow and the redirect.

### Phase 3: Change password — API

**Goal:** A signed-in user can rotate their password by proving the current one.
**Touches:** backend

**Tasks:**

- [ ] Add a change-password command and handler to the `auth` module: verify the current
      password against the stored argon2id hash with the same rules as login, apply the
      registration bounds and the non-blank rule to the new one, reject a new password equal
      to the current one, and hash and store on success.
- [ ] Expose it as an authorised endpoint that acts on the caller from the token. A wrong
      current password returns the same error shape as a failed login and reveals nothing
      else. If login is rate-limited, the same limit applies here.
- [ ] Unit tests for the handler: correct and wrong current password, bounds, blank, and
      new-equals-current, all leaving the hash unchanged on rejection.
- [ ] e2e: after a successful change, login with the old password fails and with the new one
      succeeds; a wrong current password, a new password outside the bounds, and a missing
      token are rejected with the hash unchanged; one user cannot change another's password.
- [ ] Update the API guide (both files) with the endpoint, and record that a stateless JWT
      keeps other devices signed in until `JWT_EXPIRES_IN_SECONDS` elapses.

**Done when:** The e2e suite proves the old password stops working and the new one starts
working, and every rejection leaves the stored hash untouched.

### Phase 4: Change password — web

**Goal:** The user can change their password from the edit page and understands what it does
not do.
**Touches:** frontend

**Tasks:**

- [ ] Add the change-password section to `/profile/edit`: current password, new password,
      confirmation. Refuse a mismatched confirmation and a new password outside the shared
      bounds before any request is sent; show a field-level error on the current-password
      field for a wrong current password; confirm success in the form.
- [ ] Show, next to the form, that other signed-in devices stay signed in until their
      session expires.
- [ ] Add the API client function with unit tests for the request shape and error mapping.
- [ ] Unit tests for the section: client-side refusals, field-level error placement, the
      success state, and the informational note.
- [ ] Playwright: change the password, sign out, sign in with the new one; a wrong current
      password shows the field error. Update the web guide (both files).

**Done when:** The browser suite changes a password and signs back in with it, and a wrong
current password is reported on the right field.

### Phase 5: Avatar — API

**Goal:** A signed-in user can upload, fetch, and remove their avatar, and every avatar the
API serves is the same square rendition.
**Touches:** backend, database, shared

**Tasks:**

- [ ] Prisma migration adding a nullable avatar reference and a cache-busting value (version
      or content hash) to `users`; extend the shared `User` type to carry both, so
      `GET /api/auth/me` returns them. Export the avatar type list (PNG, JPEG, WebP), the size
      cap (separate from and much smaller than the meeting-file cap), and the validation
      messages from `@repo/shared`.
- [ ] Store avatars in their own subtree of the existing local-disk storage under
      `MEETING_FILES_DIR`, and normalise each upload synchronously inside the request to a
      square rendition with the image tooling the meeting-file worker already uses. A file
      that cannot be decoded fails the request and leaves the previous avatar in place.
- [ ] Add upload, fetch, and delete endpoints in the `user` module, authorised as the caller
      from the token. Upload replaces the previous file and bumps the cache-busting value;
      delete removes the file and clears the reference so the previous URL returns 404. The
      fetch endpoint must not prevent later exposure of other users' avatars.
- [ ] Unit tests for the handlers and the normalisation (aspect ratio and size in, square
      out); e2e: upload of each accepted type, over-size, empty, wrong type, and undecodable
      file, removal and the 404 afterwards, 401 without a token, and one user unable to read
      or change another's avatar.
- [ ] Update the API guide (both files) and `apps/api/.env.example` plus
      `env.validation.ts` for any new variable.

**Done when:** Upload, fetch, and delete work end to end through curl, every avatar served
has identical dimensions, and every rejection and cross-user case is an e2e test.

### Phase 6: Avatar — web

**Goal:** The avatar appears on the profile page and in the home page header, and the user
can change or remove it from the edit page.
**Touches:** frontend

**Tasks:**

- [ ] Add an avatar component that fetches the image with the bearer token and renders it
      from a blob, the way meeting-file thumbnails do, re-fetching when the cache-busting value
      changes and falling back to initials derived from the display name when there is no
      avatar.
- [ ] Add the avatar section to `/profile/edit`: pick a file, preview it, upload, or remove.
      Refuse a non-image, over-size, or empty file before upload with the shared message.
      After upload or removal, update the signed-in user state so the profile and the header
      change without a page reload.
- [ ] Show the avatar large on `/profile` and small in the home page header next to the
      sign-out control, with initials as the fallback in both places. Add the API client
      functions for upload, fetch, and delete with unit tests.
- [ ] Unit tests for the component and the section: initials fallback, blob rendering,
      re-fetch on version change, client-side refusals, and the state update after upload
      and removal.
- [ ] Playwright: upload an avatar and see it in the header and on the profile without
      reload, remove it and see initials, refuse an over-size file. Update the web guide
      (both files).

**Done when:** The browser suite uploads, sees, and removes an avatar without a reload, and
the initials fallback is proven in both locations.
