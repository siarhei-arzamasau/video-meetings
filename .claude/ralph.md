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
- If the tests are still red after 5 attempts, stop and comment on the issue describing the problem

## Finishing rules

- Make sure every test is green
- Make sure every requirement is met
- Run the /review skill for a code review
- Close the issue
- Do not open a PR — the Stop hook does that
- End the session immediately after closing one issue
- Do not pick up the next issue yourself
- The Stop hook starts a new session for the next issue
