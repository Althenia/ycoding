# Web package guide

## Binary relay contracts

Use the declared v5 operation payloads, result wrappers, scope and error variants. Send Session form operations with Form scope naming the owning Session; keep that Session in the request params. Read event creation times as numeric milliseconds. Preserve the required durable envelope on durable PublicEvent branches and keep live-only deltas ephemeral. Release an owned subscription before replacing it, including reselecting the same Session, using its original connection and subscription identity. Use canonical snapshots and typed bulk delivery for transcript recovery.

Complete initial or invalidated-stream hydration when its snapshot settles. Use the successful snapshot's canonical source epoch, or the connection's verified Ready epoch after rejection, timeout or cancellation; do not complete hydration on a closed connection. Begin hydration again for an invalidated stream before its resync read; keep ordinary subscribed reloads live.

Keep native fixtures schema-valid. Give each subscription its own identity, release its producer ownership on unsubscribe, and acknowledge telemetry batches with their accepted sample count. Wait for delivered events and observable state rather than assuming v5 event coalescing fits an old flush delay.

Serialize in-process fixture agent frames so canonical-epoch resync admission settles before its dependent subscription result.

Detect in-flight goal setting through `session.autonomy.set` with a string `goal`; distinguish YOLO changes and null-goal stops.

## Design rules

Read [`../../DESIGN.md`](../../DESIGN.md) and [`DESIGN.md`](./DESIGN.md) before changing web UI; their approved rules bind. `src/styles/design-md.test.ts` fails when `DESIGN.md` token values drift from `src/styles/tokens.css`, and `src/styles/contrast.test.ts` holds color pairs, including every scrollbar thumb state, to their ratios.

## Browser integration verification

`bun test` loads `test/solid-preload.ts` through `bunfig.toml` to compile JSX with the installed `vite-plugin-solid` compiler in SSR mode. Keep DOM rendering checks in the real-browser integration suites; the Bun source suites have no browser DOM.

Browser-driven checks are explicit integration tests and must not run from `src` unit suites. Run product-state, responsive-layout, design-contract, and public-route checks with an installed Chromium or Chrome executable:

```sh
YCODING_WEB_CHROME="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
  bun test verify/public-fidelity.integration.test.ts
```

`YCODING_WEB_CHROME` is required. Integration tests start local Vite servers and use Chrome DevTools Protocol without adding a browser dependency. Remote fixture states use product scenario names; viewport dimensions and all other fixture query parameters remain explicit.

`verify/scrollbar.integration.test.ts` is the only suite that launches Chrome with visible scrollbars (`launchBrowser(..., { scrollbars: true })`). The other suites pass `--hide-scrollbars`, which hides styled scrollbars but still reserves `scrollbar-gutter`, so their geometry includes the reserved gutter; assert scrollbar rendering only in the visible-scrollbar suite.

## Managed image reuse

Read managed images through `session.attachment.read` and transfer completed raw bytes with `takeAsset`. Bound resolved Blob reuse to 32 sources and 8 MiB, evicting least-recently used sources without invalidating mounted previews or lightboxes. Coalesce pending reads independently of that budget; never abort a pending read for cache eviction. Release each consumer's object URL on unmount or replacement and all object URLs on selection/connection teardown. Preserve MIME validation and explicit retry. Evicted sources may be fetched again.

Run `bun test test/remote-image.test.ts src/remote/image-cache.test.ts` and the configured-Chrome `bun test verify/image-cache.integration.test.ts` after changing this cache or its ownership.
