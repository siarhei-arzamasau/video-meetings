---
name: review-all
description: Runs a full code review through three parallel subagents — security, performance, and test coverage.
---

Launch three subagents in parallel with the Agent tool:

1. `security-reviewer` — check the changes for security problems
2. `performance-reviewer` — check performance
3. `test-coverage-reviewer` — check test coverage

Launch all three at once. When all of them have finished, synthesize their results into a
single report.
