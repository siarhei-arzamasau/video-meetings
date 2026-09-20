# Ralph Loop — rules for autonomous work

## How to pick up issues

- Read the title, the body and the acceptance criteria
- Check that the branch named there already exists (create it if it does not)
- Work only in that branch — do not create new ones

## Commit naming

- Follow the rules in the commit skill

## Implementation rules

- Tests first, implementation second (TDD)
- Run the tests after every finished change
- Run the browser suite on this machine with `E2E_TIMEOUT_SCALE=2`:
  `E2E_TIMEOUT_SCALE=2 pnpm --filter=@repo/web test:e2e`. The machine is busy, and at the
  default scale one to three tests fail on timeouts with nothing wrong in the code — see
  `apps/web/e2e/timeouts.ts`. A test still red at scale 2 is a real break; fix that one
- If the tests are still red after 5 attempts, stop and comment on the issue describing the problem

## Finishing rules

- Make sure every test is green
- Make sure every requirement is met
- Run the /code-review skill for a code review
- Close the issue
- Leave `git status --porcelain` empty: commit what belongs in the repository and **delete
  what does not**. Do not leave scratch specs in `apps/web/e2e/` — every later run of the
  suite executes them; keep them outside the repository or remove them on your way out
- Push the branch (`git push -u origin <branch>`) — the Stop hook opens the PR at the end and
  expects the branch to be on the remote already
- Do not open a PR — the Stop hook does that
- End the session immediately after closing one issue
- Do not pick up the next issue yourself
- The Stop hook starts a new session for the next issue
