---
type: Repository Preference
title: Coding Conventions and Repository Standards
description: Explicit project-wide conventions for TypeScript, Effect, style, naming,
  imports, control flow, testing, and commits established by tracked instructions
  and linter configuration.
tags:
- conventions
- style
- typescript
- testing
sources:
- id: agents
  resource: repo:///AGENTS.md
- id: contrib
  resource: repo:///CONTRIBUTING.md
- id: oxlint
  resource: repo:///.oxlintrc.json
- id: ast-grep
  resource: repo:///script/ast-grep/sgconfig.yml
---

## TypeScript and Effect Conventions

Avoid the any type, rely on inference, use explicit annotations for exports and clarity, use Bun APIs where possible, prefer functional array methods with type guards, and bind Effect services to named variables instead of nested service yields.[^agents]

Prefer Effect schema helpers for untrusted JSON strings over manual JSON.parse wrapped in Effect.try.[^agents]

Use snake_case Drizzle field names so column names do not need string overrides.[^agents]

## Imports, Variables, and Control Flow

Never alias or star imports; import a module exported namespace by name when needed, prefer dynamic imports for selected heavy paths, and keep branch-specific imports inside the branch that needs them.[^agents]

Prefer const over let with ternaries or early returns, avoid else statements, keep single-use values inline, and preserve context with dot notation rather than unnecessary destructuring.[^agents]

## Testing and Verification

Use test-driven development for behavior changes, avoid mocks where possible, test actual implementation behavior without duplicating production logic, run tests from the affected package, and require TUI-visible changes to prove displayed behavior.[^agents]

Run affected package typechecks and root typecheck, lint, and effect-pattern checks when the change crosses their scope.[^agents]

## Branches, Commits, and Lint

Use short hyphenated branch names of at most three words with no slashes or type prefixes, and use conventional type-scope-summary commits with feat, fix, docs, chore, refactor, and test types.[^agents]

Lint and pattern checks enforce no drizzle column names, no Effect die strings, no import aliases, no JSON parse casts, no nested Effect service yields, and no star imports.[^ast-grep]

## Related Concepts

- [Package Architecture](./architecture.md)
- [Project Artifacts](./project-artifacts.md)

[^agents]: repo:///AGENTS.md
[^ast-grep]: repo:///script/ast-grep/sgconfig.yml
