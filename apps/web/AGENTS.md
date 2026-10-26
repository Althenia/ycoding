# Web package guide

## Design rules

Read [`../../DESIGN.md`](../../DESIGN.md) and [`DESIGN.md`](./DESIGN.md) before changing web UI; their approved rules bind. `src/styles/design-md.test.ts` fails when `DESIGN.md` token values drift from `src/styles/tokens.css`, and `src/styles/contrast.test.ts` holds color pairs, including every scrollbar thumb state, to their ratios.

## Browser integration verification

`bun test` loads `test/solid-preload.ts` through `bunfig.toml` to compile JSX with the installed `vite-plugin-solid` compiler in SSR mode. Keep DOM rendering checks in the real-browser integration suites; the Bun source suites have no browser DOM.

Browser-driven checks are local-only integration tests and must not run from `src` unit suites or CI. From the repository root, provision the pinned Chrome for Testing build, then run selected product-state, responsive-layout, design-contract, or public-route files:

```sh
browser="$(bun script/chrome-for-testing.ts .cache/chrome-for-testing)"
YCODING_WEB_CHROME="$browser" bun test --cwd apps/web verify/public-fidelity.integration.test.ts
```

`YCODING_WEB_CHROME` is required. `script/chrome-for-testing.ts` owns the exact test-browser version and verifies the downloaded executable; local web/extension checks use that provisioner, not whichever Chrome is installed. Native paired-browser acceptance retains its installed Chrome host. Integration tests start local Vite servers and use Chrome DevTools Protocol without adding a package dependency. Remote fixture states use product scenario names; viewport dimensions and all other fixture query parameters remain explicit.

`verify/scrollbar.integration.test.ts` is the only suite that launches Chrome with visible scrollbars (`launchBrowser(..., { scrollbars: true })`). The other suites pass `--hide-scrollbars`, which hides styled scrollbars but still reserves `scrollbar-gutter`, so their geometry includes the reserved gutter; assert scrollbar rendering only in the visible-scrollbar suite.

Use native wheel, touch, keyboard, or jump controls to leave latest-follow before positioning a conversation reader. Do not use `scrollIntoView()` alone for this transition. Await the reader's visible navigation state before measuring hover, focus, or hit targets.

## Managed image reuse

Bound resolved managed-image reuse to 32 sources and 8 MiB of data-URL text, evicting least-recently used sources without invalidating mounted previews or lightboxes. Coalesce pending reads independently of that resolved budget; never abort a pending read for cache eviction. Preserve MIME validation, explicit retry, and selection/connection teardown. Evicted sources may be fetched again.

Run `bun test test/remote-image.test.ts src/remote/image-cache.test.ts` and the configured-Chrome `bun test verify/image-cache.integration.test.ts` after changing this cache or its ownership.
