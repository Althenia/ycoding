---
type: Repository Preference
title: Coding Conventions and Repository Standards
description: Explicit project-wide conventions for TypeScript, Effect, style, naming,
  imports, control flow, and testing as established by tracked instructions, linter
  configuration, and repeated authoritative evidence.
tags:
- conventions
- style
- typescript
- testing
sources:
- id: agents
  resource: repo:///AGENTS.md
- id: contributing
  resource: repo:///CONTRIBUTING.md
- id: oxlint
  resource: repo:///.oxlintrc.json
- id: ast-grep
  resource: repo:///script/ast-grep/sgconfig.yml
---

## TypeScript Conventions

- Avoid `any` type. Rely on type inference. Use explicit annotations for exports and clarity.[^agents]
- Use Bun APIs when possible, such as `Bun.file()`.[^agents]
- Prefer functional array methods (`flatMap`, `filter`, `map`) over loops. Use type guards on filters to preserve downstream inference.[^agents]
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.[^agents]

## Imports

- Never alias imports. No `import { foo as bar }`. No star imports (`import * as Foo`). Import module exported namespaces by name when needed.[^agents]
- Prefer dynamic imports for heavy modules used only in selected paths. Destructure near the top of the narrowest scope. Avoid inline chains or `.then()`.[^agents]

## Variables and Control Flow

- Prefer `const` over `let`. Use ternaries or early returns instead of reassignment. Avoid `else`; use early returns.[^agents]

## Testing

- Use test-driven development for behavior changes: write focused regression test, observe failure, implement smallest fix, rerun targeted suites.[^agents]
- Avoid mocks as much as possible. Do not use `globalThis.*` unless no realistic alternative exists.[^agents]
- Test actual implementation behavior; do not duplicate production logic in tests.[^agents]

## Branch Names and Commits

- Use short branch names of at most three words separated by hyphens. No slashes or type prefixes (`feat/`).[^agents]
- Use conventional commit-style messages: `type(scope): summary`. Valid types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.[^agents]

## Linting and Patterns

- Enforced by oxlint (`@oxlintrc.json`) and ast-grep rules for: no drizzle column name, no effect die string, no import alias, no JSON parse cast, no nested Effect service yield, no star import.[^ast-grep]

## Related Concepts

- [Package Architecture](./architecture.md) — authority order and package boundaries
- [Project Artifacts](./project-artifacts.md) — artifact conventions follow repository standards

[^agents]: repo:///AGENTS.md
[^ast-grep]: repo:///script/ast-grep/sgconfig.yml
