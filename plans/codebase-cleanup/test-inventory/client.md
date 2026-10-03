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

Focused nine-file Client run: `bun test --timeout 30000 test/contract-identity.test.ts test/effect.test.ts test/file-change-summary.test.ts test/import-boundaries.test.ts test/isolated-browser.test.ts test/owned-browser.test.ts test/promise-service.test.ts test/promise.test.ts test/service.test.ts` from `packages/client`: exit 0, 75 pass, 0 fail. Package `bun run typecheck` and `git diff --check` exit 0; source and tests unchanged. A direct `bunx oxlint <nine test files>` did not execute because that invocation rejected the repository config's `options.typeAware` location; root `bun run lint` on the identical merged source revision exited 0 with 2,900 warnings and 0 errors. This is not a claim that the direct Client lint invocation passed. `service.test.ts` has two 500 ms sleep-based assertions, including a negative contender check; a deterministic replacement was not established, so they are retained and remain timing risks. `promise-service.test.ts` uses bounded fixture-event polling. Protocol/Schema contract and wider browser integration suites were not part of this Client slice.
