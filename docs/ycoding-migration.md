# YCoding identity migration

## Canonical identity

Use these names for YCoding-owned surfaces:

| Surface | Canonical value |
| --- | --- |
| Product | `YCoding` |
| Executable and process | `ycoding` |
| Package scope | `@ycoding-ai/*` |
| Environment prefix | `YCODING_*` |
| Repository configuration directory | `.ycoding` |
| Configuration files | `ycoding.json`, `ycoding.jsonc` |
| HTTP location headers | `x-ycoding-directory`, `x-ycoding-workspace` |
| Terminal title prefix | `YC` |

## External provider exception

OpenCode Zen and OpenCode Go are external model-provider identities. Their provider IDs, URLs, API-key environment variable, integration labels, and provider-specific OAuth identifiers remain unchanged where required to connect to that provider.

This exception does not permit old product branding in YCoding-owned CLI help, TUI copy, paths, environment variables, package names, protocol headers, logs, tests, or documentation.

## Upstream attribution

Historical origin and comparison links belong only in [`upstream-differences.md`](./upstream-differences.md) or in patch/vendor provenance that must identify its source. They are not product identity.

## Compatibility policy

Legacy product identifiers are not active defaults. A compatibility alias may remain only when all of these conditions are true:

1. Removing it would prevent an existing YCoding user from loading durable local state or configuration.
2. The canonical YCoding identifier is tried first.
3. The fallback is isolated and tested.
4. The fallback is not shown in normal user-facing output.
5. The migration path and removal condition are documented here.

No compatibility alias is currently approved unless it is explicitly listed below.

### Approved compatibility aliases

None.

## Verification

Run:

```bash
bun run check:ycoding-brand
bun run check:ycoding-workspace
```

The brand check must report no unapproved old product identifiers. External-provider and upstream-attribution references are classified by `script/ycoding-rebrand.ts` and covered by policy tests.
