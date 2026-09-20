# Ralph Loop — rules for autonomous work

## How the loop is run

`node .claude/ralph-loop.js`, from a terminal, in the worktree. It is one long-lived process
that runs one session at a time and picks the next issue when that session ends; Ctrl-C stops
it, and the iteration counter in `.claude/ralph.iterations.json` survives, so restarting
resumes where it left off.

**It is not the Stop hook, and it must not become one again.** The loop used to chain itself —
every session's Stop hook started the next one with `execSync`, so each session ran inside its
parent's hook. A hook has a timeout (60 seconds unless `settings.json` overrides it) and a
session implementing an issue needs tens of minutes, so every child was killed before it could
commit. It looked like progress from outside: the counter climbed, sessions started, and the
branch gained nothing but half-written scratch files. `ralph.config.json` keeps `active: false`
to hold that hook shut.

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
- Push the branch (`git push -u origin <branch>`) — the loop opens the PR after the last phase
  and expects the branch to be on the remote already
- Do not open a PR — the loop does that
- End the session immediately after closing one issue
- Do not pick up the next issue yourself — the loop starts a new session for it
