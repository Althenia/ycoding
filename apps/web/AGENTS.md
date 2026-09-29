# Web package guide

## Design rules

Read [`../../DESIGN.md`](../../DESIGN.md) and [`DESIGN.md`](./DESIGN.md) before changing web UI; their approved rules bind. `src/styles/design-md.test.ts` fails when `DESIGN.md` token values drift from `src/styles/tokens.css`, and `src/styles/contrast.test.ts` holds color pairs, including every scrollbar thumb state, to their ratios.

## Browser integration verification

Browser-driven checks are explicit integration tests and must not run from `src` unit suites. Run product-state, responsive-layout, design-contract, and public-route checks with an installed Chromium or Chrome executable:

```sh
YCODING_WEB_CHROME="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
  bun test verify/public-fidelity.integration.test.ts
```

`YCODING_WEB_CHROME` is required. Integration tests start local Vite servers and use Chrome DevTools Protocol without adding a browser dependency. Remote fixture states use product scenario names; viewport dimensions and all other fixture query parameters remain explicit.

`verify/scrollbar.integration.test.ts` is the only suite that launches Chrome with visible scrollbars (`launchBrowser(..., { scrollbars: true })`). The other suites pass `--hide-scrollbars`, which hides styled scrollbars but still reserves `scrollbar-gutter`, so their geometry includes the reserved gutter; assert scrollbar rendering only in the visible-scrollbar suite.
