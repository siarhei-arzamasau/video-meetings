---
name: plan-phase
description: Breaks a PRD into implementation phases. Use when a PRD is ready and the work needs a development plan of independent phases.
---

# Plan Generator

Read the PRD from the file: $ARGUMENTS

Write an implementation plan and save it to 'docs/ plan-$ARGUMENTS.md' (translate the name into
English and use kebab-case)

## Plan structure:

**PRD:** $ARGUMENTS
**Date:** {today's date}

## Implementation phases

### Phase 1: {name}
**Goal:** what this phase delivers
**Touches:** backend / frontend / database

**Tasks:**
- [ ] Task 1
- [ ] Task 2

**Done when:** a concrete criterion

### Phase 2: {name}
...

## Rules for splitting into phases:
- Every phase must deliver something that works.
- Phases are independent; it is possible to stop after any of them.
- The first phase is the minimal working path (Tracer Bullet)
- No more than five tasks in one phase
- The backend and the frontend of one feature belong to different phases.
- Every phase must plan tests covering that phase's functionality.

## Rules
- Read the PRD carefully; the plan must cover every acceptance criterion.
- Do not add tasks that are not in the PRD.
- If the PRD is incomplete, ask before writing the plan.
