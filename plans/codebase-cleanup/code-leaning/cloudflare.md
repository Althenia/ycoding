# SC — Cloudflare Worker source ranking

At `96c6b644`: 21 tracked paths; 21 eligible operational source files, 4,323 physical lines. The S1 classifier covers only `packages/`; its fork class is **unknown/out of scope** for every Worker path below, and the verified upstream snapshot has no `infra/cloudflare` tree.

| Rank | Module under `infra/cloudflare/src/` | Lines × touches = score | Fork class | Current consumer |
|---:|---|---:|---|---|
| 1 | `relay/core.ts` | 909 × 13 = 11,817 | unknown | `relay/durable-object.ts:18` creates the relay core. |
| 2 | `router.ts` | 812 × 9 = 7,308 | unknown | `index.ts:22` imports `createRouter` for Worker requests. |
| 3 | `relay/durable-object.ts` | 378 × 10 = 3,780 | unknown | `index.ts:21` exports `DeviceRelay` as the Durable Object entry. |
| 4 | `auth/service.ts` | 424 × 4 = 1,696 | unknown | `index.ts:19` and `relay/durable-object.ts:13` construct auth services. |
| 5 | `auth/d1-store.ts` | 440 × 3 = 1,320 | unknown | `index.ts:18` and `relay/durable-object.ts:12` construct D1 auth stores. |

Method: tracked operational `.ts/.tsx/.js/.jsx/.css` in `src`, excluding tests, generated files, fixtures and declarations; physical lines × commit-path touches in `git log --no-renames --since=2026-07-20T00:00:00Z --until=2026-10-04T00:00:00Z`. Fork-class ranking is unrankable for this out-of-classifier surface. D14 duplication, workerd-only checks, D1 data safety and relay authentication/ownership are not established by this score; no migration or public-contract change is authorized.
