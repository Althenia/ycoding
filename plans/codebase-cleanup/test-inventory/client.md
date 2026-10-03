# SL Client test inventory

Current cleanup commit `4982188a`. All nine `packages/client/test` files are retained; no test change was justified. Promise and Effect endpoint tests exercise distinct client surfaces rather than duplicate assertions. No source-text-only or mock-call-only cases were found.

| File | Retained contract |
|---|---|
| `contract-identity.test.ts` | Schema identity and DTO shapes |
| `effect.test.ts` | Effect decoding, requests, streams, typed errors |
| `file-change-summary.test.ts` | Transcript grouping and child attribution |
| `import-boundaries.test.ts` | Public bundled import boundaries |
| `isolated-browser.test.ts` | Isolated-browser routes, generation, and fences |
| `owned-browser.test.ts` | Owned/profile routes, leases, and failures |
| `promise-service.test.ts` | Promise service lifetime |
| `promise.test.ts` | Promise request/API shapes, SSE, and errors |
| `service.test.ts` | Effect service lifetime and concurrency |

Focused nine-file Client run: `bun test --timeout 30000 test/contract-identity.test.ts test/effect.test.ts test/file-change-summary.test.ts test/import-boundaries.test.ts test/isolated-browser.test.ts test/owned-browser.test.ts test/promise-service.test.ts test/promise.test.ts test/service.test.ts` from `packages/client`: exit 0, 75 pass, 0 fail. Package `bun run typecheck` and `git diff --check` exit 0; source and tests unchanged. A direct `bunx oxlint <nine test files>` did not execute because that invocation rejected the repository config's `options.typeAware` location; root `bun run lint` on the identical merged source revision exited 0 with 2,900 warnings and 0 errors. This is not a claim that the direct Client lint invocation passed. `service.test.ts` timing waits are resolved in the AC15 pass below. `promise-service.test.ts` uses bounded fixture-event polling. Protocol/Schema contract and wider browser integration suites were not part of this Client slice.

## AC15 pass (lane `ai-contracts`, base `d30e97bf`)

All nine files stay `keep`; live JUnit registers 75 cases (contract-identity 2, effect 8, file-change-summary 10, import-boundaries 1, isolated-browser 4, owned-browser 3, promise-service 5, promise 30, service 12), equal to the table. Baseline summed JUnit time 48.250 s (service 36.399 s, promise-service 9.244 s).

`service.test.ts` rewrite (`test(client): await service probe events instead of fixed sleeps`), 12 cases retained, one assertion added:

| Case | Before | After |
| --- | --- | --- |
| waits for a registered service to finish starting | `Bun.sleep(500)`, then the starting process is alive | the fixture appends one line per 503 health answer; wait for two, then assert `ensure` is still unsettled and the process is alive |
| does not spawn contenders while an incompatible service rejects replacement | first stop attempt, then `Bun.sleep(500)` | the fixture appends one line per rejected stop; wait for the second attempt, a full `ensure` iteration after the first rejection, then assert no contender started |
| replaces an incompatible owner that appears during startup | `Bun.sleep(1_000)` before registering the old owner | wait for the delayed contender's `.owner` file, so the old owner always appears during startup |

The fixture changes (`test/fixture/service.ts`) only record events; served responses are unchanged. `promise-service.test.ts` keeps its bounded polls on actual files and process exit.

Mutation probes (production restored with `git checkout -- packages/client/src/effect/service.ts`):

| Production line | Mutation | Retained test result |
| --- | --- | --- |
| `client/src/effect/service.ts:110` | a compatible waiting service no longer short-circuits | "waits for a registered service to finish starting" fails: the starting process was stopped (exit code 0, expected null) |
| `client/src/effect/service.ts:114` | after a rejected replacement, fall through to spawning | "does not spawn contenders..." fails: contender `.started` exists |
| `client/src/effect/service.ts:112` | skip stopping a version-mismatched owner | "replaces an incompatible owner that appears during startup" fails (20 s timeout; the old owner never exits) |
