# SL Cloudflare test inventory

Scope: `infra/cloudflare/test/*.test.ts` (the `bun run test:cloudflare` gate), plus the separate integration gate under `infra/cloudflare/test/integration/`. Baseline is cleanup `d30e97bf`. Every file here guards the relay Worker's trust boundary (Google sign-in, browser sessions, device enrollment and credentials, owner isolation, relay authority, push ownership, secret redaction) or its durable storage (D1 migrations, notice log); remote ownership and relay-security tests are always kept, so only exact duplicates and wall-clock waits were changed.

Method: each file run alone with `bun test ./test/<file> --timeout 30000 --reporter=junit` from `infra/cloudflare`, serialized host-wide through the lane wrapper while other lanes were active. Wall times are per-file process times and are not exclusive-machine measurements.

## Before and after

| Measure | Before | After |
|---|---|---|
| Files in `test:cloudflare` | 15 | 15 |
| Cases (JUnit) | 275 | 273 |
| Lines, `test/*.ts` + `test/support/*.ts` | 6,259 | 6,248 |
| Summed isolated wall time | 16.3 s | 6.3 s |

The integration gate file `test/integration/push-diagnostic.test.ts` (7 cases, 2.0 s) is unchanged and counted separately; the other `test/integration/*.ts` scripts are live-flow gates (`real-flow.ts`, `relay-local.ts`, `invite-flow.ts`, `chrome-push.ts`, `admin-push.ts`, `completion-notices.ts`, `push-binding-local.ts`) and were neither run nor changed.

## Per-file classification

| File | Cases | Behaviors guarded | Layer | Wall (before) | Class |
|---|---|---|---|---|---|
| `auth-service.test.ts` | 17 | OAuth transaction binding and single use; browser-session rotation, expiry, revocation; one-use enrollment codes; P-256 challenge redemption; refresh rotation; revoked-device refusal; owner isolation; race-safe rotation; bounded expired-metadata cleanup | unit over memory store | 38 ms | keep all: auth trust boundary, each case a distinct rule |
| `config.test.ts` | 2 → 1 | Production Worker identity, D1/Durable Object bindings, and the exact Worker-first route list that keeps `/api`, `/ws`, `/health` out of the SPA fallback | deploy-config contract | 9 ms | merge: case 1's five assertions are a strict subset of case 2's exact `assets` equality |
| `crypto.test.ts` | 9 → 8 | base64url round-trip and rejection, 32-byte random tokens, SHA-256, constant-time compare, P-256 signature verification, JWT splitting | unit | 12 ms | delete "produces 32-byte P-256 coordinates": 32 bytes → 43 characters is already asserted by "generates distinct 32-byte tokens"; keep the rest |
| `device-cleanup-d1.test.ts` | 1 | Revoked-device cleanup is owner-scoped and cascades dependent rows in real SQLite | D1 store over SQLite | 19 ms | keep: ownership |
| `google.test.ts` | 13 | OIDC endpoints and PKCE URL; token exchange fails closed; ID-token signature, issuer, audience, azp, nonce, subject, unverified email; JWKS cache refetch rate limit, last-good keys, bounded key set | unit with local JWKS | 587 ms | keep all: sign-in trust boundary; the time is RSA key generation, not waiting |
| `invite-router.test.ts` | 7 | Admin bearer fail-closed with bounded attempts; single-use invites; atomic redemption; cross-origin refusal; deletion closes machines and removes account rows; credential rotation closes sockets; hashed credentials and no credential logging | router over memory stores | 55 ms | keep all: trust boundary and secret redaction |
| `notice-store.test.ts` | 16 | Completion receipt baseline silence, high-water and rollback; per-notice coalescing, ordering, paging cursors, idempotent reads, bound-parameter limit, failure atomicity, reopen | store over SQLite | 37 ms | keep all: durable notice log, each case a distinct storage rule |
| `push-crypto.test.ts` | 2 | RFC 8291 Appendix A vector; VAPID ES256 claims and expiry | unit | 13 ms | keep: wire contract |
| `push-d1-store.test.ts` | 10 | Eleven-subscription eviction, account-scoped removal, failure settling; categories survive renewal; one test alert per window; browser-session ownership of registration and renewal; refusal for revoked/expired/wrong-account/unknown session (already one table); failure rollback | D1 store over SQLite | 56 ms | keep all: push ownership |
| `push-migration.test.ts` | 3 | 0002 cascade, 0004 category defaults and CHECK constraint, 0005 browser-owner migration and v0.7.16 write refusal | migration | 28 ms | keep all: migration tests are always kept |
| `push-router.test.ts` | 11 | Push routes require a browser session and same origin; key/endpoint validation and account cap; System choices; admin test alert targeting; owner from verified session; rotation/revocation/expiry during body processing (already one table) | router | 103 ms | keep all: push ownership |
| `push-send.test.ts` | 9 | Encrypted minimal payload, VAPID and bounded headers; per-category targeting; failure/success tracking and overflow topic; test alert outcomes; receipt-driven completion push; redacted push logging; per-owner outcomes; failure before any send; delivery deadline | unit + relay flow | 10,106 ms | keep 8; rewrite "a push service that never answers is abandoned at the delivery deadline…" (below) |
| `relay-core.test.ts` | 121 | Relay role separation, request admission and rate limits, correlation integrity, subscriptions, revocation and expiry, per-connection ordering and authority windows, notice log, machine-offline confirmation, one System alert owner per browser, multiplexed streams | relay core over SQLite notice store | 205 ms | keep all: relay security; rewrite one fail-fast race; remove one repeated identical assertion |
| `router.test.ts` | 53 | Health and unknown routes; Google sign-in, allowlist and rate limits; browser-session routes; device enrollment, credentials, revocation and cleanup; WebSocket upgrade authentication, protocol-version gate and header stripping; message-stream ownership; metadata cleanup cadence; asset delegation and security headers; cookie hygiene under races | router over memory stores | 5,043 ms | keep all: trust boundary; time is per-harness RSA key generation, not waiting |
| `vapid-keys.test.ts` | 1 | Generated VAPID public point and private scalar sizes | script unit | 6 ms | keep |
| `integration/push-diagnostic.test.ts` (separate gate) | 7 | Chrome bootstrap returns only hashes; VAPID diagnostic verification without retaining raw material; allowlisted provider codes only; diagnostic parsing | integration helper | 2,034 ms | keep: secret redaction |

`push-diagnostic.test.ts` is not run by any package script. Its "bounds provider body bytes and waiting" case waits for the helper's own 2 s body-read bound. That wait is the behavior under test, and a correct implementation passes it at any load, so it is retained.

Support files `notice-storage.ts`, `smoke.ts`, and `support/*.ts` are shared fixtures, not tests.

## Changes and retained assertions

| Change | Retained behavior → surviving assertion |
|---|---|
| `config.test.ts`: case "routes relay paths to the Worker so SPA fallback cannot mask them" merged into the production-Worker case, which is renamed to name the route requirement | `/api/*`, `/ws/*`, `/health` Worker-first, no negated patterns, SPA not-found handling, `ASSETS` binding → `expect(config.assets).toEqual({...})` |
| `crypto.test.ts`: delete "produces 32-byte P-256 coordinates" | 32-byte value encodes to 43 unpadded characters → "generates distinct 32-byte tokens" (`toHaveLength(43)` and decoded length 32) |
| `push-send.test.ts`: deadline case used a real 10 s wait and asserted elapsed ∈ [9.95 s, 13 s) | Uses Bun fake timers, which drive `AbortSignal.timeout`. Waits until both hung push requests are actually in flight, advances to 1 ms before `pushDeliveryTimeoutMs` and asserts nothing aborted, then advances the last 1 ms. All original outcome assertions (unreachable, two `TimeoutError` aborts, three calls, one page presentation per tab, two non-permanent failures) are unchanged, and the 10 s constant is still asserted |
| `relay-core.test.ts`: "a presenter detached during its fresh authority read…" raced the read against `Bun.sleep(100)` | Races the read against the delivery itself settling: a bypassed fresh read lets delivery finish and fails immediately with "Fresh authority read was bypassed"; no wall-clock bound |
| `relay-core.test.ts`: "delivers events only when a client subscribed to that Session" | Repeated identical `expect(h.closed).toEqual([])` removed; the first copy remains |

Zero-delay `settle = () => Bun.sleep(0)` in the System-alert-owner group is a macrotask yield over microtask-only work, not a duration, and is retained. `push-send.test.ts` keeps a 50 ms negative wait in "a push to its owner fails only before any push request is sent…": it can only miss a regression, never fail a correct implementation, and no event exists to await for a send that must not happen.

## Mutation probes

Each mutation was applied to the guarded production line, the retained test was run, and the line was restored with `git checkout -- <file>`; `git diff --exit-code` on the production file then exited 0.

| Production line | Mutation | Result |
|---|---|---|
| `src/push/send.ts` `AbortSignal.timeout(pushDeliveryTimeoutMs)` | `pushDeliveryTimeoutMs - 1_000` | deadline case fails: `aborts` non-empty before the deadline, exit 1 |
| same | `pushDeliveryTimeoutMs + 1_000` | deadline case never settles at the deadline; times out (5 s probe timeout), exit 1 |
| `src/relay/core.ts:825` `checkClientAuthority(client, true)` | `false` (skip the fresh read) | presenter case fails at once with "Fresh authority read was bypassed", exit 1 |
| `src/auth/crypto.ts:7` `.replaceAll("=", "")` | removed (keep padding) | "generates distinct 32-byte tokens" and two dependent cases fail, exit 1 |
| `wrangler.jsonc` `"/ws/*"` in `run_worker_first` | removed | merged config case fails, exit 1 |

## Stability

Touched files (`config`, `crypto`, `push-send`, `relay-core`): three isolated per-file runs, all exit 0 with JUnit `failures="0"` (1 / 8 / 9 / 121 cases each run; `push-send` 103–170 ms, previously 10.1 s). One loaded run at 2026-10-03T14:38:35Z–14:38:37Z while a forced root `bun run typecheck` was running (10–11 `tsgo`/`turbo` processes counted at each file's end): all four exit 0.

## Checks

- `bun run check:cloudflare` (wrapper): `test:cloudflare` 273 pass, 0 fail across 15 files; `typecheck:cloudflare` passed (worker types up to date, `tsgo` clean); the first `build:cloudflare` failed only because `apps/web/dist` did not exist in this fresh worktree. After `bun run --cwd apps/web build` (exit 0), `bun run build:cloudflare` exited 0 (dry run, 193.26 KiB upload, DEVICE_RELAY/DB/ASSETS bindings).
- `bunx --no-install oxlint` on the four touched files: exit 0, 0 errors; the existing `no-unsafe-type-assertion` warnings are on unchanged lines only, none on a changed line.
- Production files unchanged after all probes.
