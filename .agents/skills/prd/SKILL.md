---
name: prd
description: Writes a PRD for a feature in the project's standard structure. Use when a new feature's requirements need to be described before implementation.
---

# PRD generator

Write a PRD (Product Requirements Document) for the following feature: $ARGUMENTS

Save the result to 'docs/prd-$ARGUMENTS.md' (translate the name into English and use kebab-case)

If there is no /docs directory, create one

## Document structure

# PRD: {feature name}

**Date**: {today's date}
**Status**: Draft

## Goal
One or two sentences: what this is and why the user needs it.

## User scenarios
- The user {action} > {result}
- 
## In scope
What the feature includes — a concrete list

## Out of scope
What this iteration explicitly does not do

## Technical constraints
Known constraints that have to be accounted for

## Acceptance criteria
- [ ] Criterion 1
- [ ] Criterion 2

## Rules

- Be concrete — no filler
- Acceptance criteria must be verifiable
- Do not describe how to implement it — only what and why
- If the description is thin, ask clarifying questions until you understand it fully, before creating the file
