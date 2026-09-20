---
name: issues
description: Creates GitHub issues and milestones from a plan
  file. Use when a phased plan is ready and the backlog needs to be created on GitHub.
---

# Plan Generator

Read the plan from the file: $ARGUMENTS

For each phase, create a milestone and issues on GitHub using the gh CLI.

## Steps

1. Read the plan file
2. For each phase create a milestone: `gh api repos/:owner/:repo/milestones -f title="Phase N:
name"`
3. For each task in the phase create an issue: `gh issue create --title "..." --body "..." --label "..."
--milestone "..."`.

## Issue format

**Title**: the task text from the plan (without the [])
**Body**: the task description
