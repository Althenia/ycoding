# Contributing to YCoding

YCoding is a TUI-only coding agent. Contributions must preserve the terminal product, V2 runtime, explicit package boundaries, and documented behavior.

## Before changing code

Read:

- [`AGENTS.md`](./AGENTS.md)
- [`docs/README.md`](./docs/README.md)
- [`docs/architecture.md`](./docs/architecture.md)
- The nearest package-level `AGENTS.md`

Verify user-supplied paths, symbols, causes, and expected behavior against the live checkout before implementing them.

## Supported scope

The active workspace is defined explicitly in [`package.json`](./package.json) and enforced by [`script/ycoding-workspace.ts`](./script/ycoding-workspace.ts).

Do not restore removed desktop, web, console, website, statistics, or legacy SDK products. A proposal to change the product boundary must update the workspace test, root documentation, build scripts, and release plan in the same change.

## Development setup

Use the pinned Bun version from `packageManager`.

```bash
bun install --frozen-lockfile
bun run dev
```

Build and smoke-test the distributable terminal application with:

```bash
bun run build:tui
bun run smoke:tui
bun run smoke:runtime
```

## Testing

The root `test` script intentionally refuses an unbounded repository test run. Run the smallest package-level test set that proves the change, then run the relevant repository checks.

Example:

```bash
cd packages/tui
bun test test/branding.test.ts test/app-lifecycle.test.tsx

cd ../..
bun run check:ycoding-workspace
bun run check:ycoding-brand
bun run typecheck
bun run lint
bun run lint:effect-patterns
```

For a bug fix, add a regression test that fails for the reported behavior before changing production code.

## Code requirements

- Keep changes scoped to the requested outcome.
- Prefer existing code, platform APIs, standard libraries, and installed dependencies over new abstractions.
- Preserve package dependency direction documented in `docs/architecture.md`.
- Do not edit generated, vendor, lock, cache, or tool-managed content except through its owning command.
- Handle cancellation, ordering, shared mutable state, and lifecycle explicitly.
- Do not add placeholders, mock product behavior, or dead compatibility paths.
- Use `YCoding` for product prose and `ycoding` for commands, packages, paths, and identifiers.
- Preserve OpenCode Zen and OpenCode Go names only where they identify the external provider integration.

## Documentation

Update documentation in the same change when behavior or public contracts change:

- Product scope: `README.md` and `docs/product-direction.md`
- Package ownership or dependency direction: `docs/architecture.md`
- Runtime behavior: `docs/runtime.md`
- Historical upstream differences: `docs/upstream-differences.md`
- Public schema or API behavior: the relevant `specs/v2` document
- Migration or legacy-name handling: `docs/ycoding-migration.md`

## Commits

Use a Conventional Commit subject:

```text
fix(tui): restore archived history
feat(core): add durable hook state
chore(client): regenerate protocol client
```

Keep commits reviewable and do not include unrelated working-tree changes.

## Pull requests

A pull request must state:

- the problem and verified root cause,
- the exact behavior changed,
- the tests and commands executed,
- any incomplete or blocked work,
- documentation or migration impact.

Do not claim a check passed unless its command completed successfully on the final diff.
