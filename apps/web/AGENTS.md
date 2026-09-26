# Web package guide

## Browser integration verification

Browser-driven checks are explicit integration tests and must not run from `src` unit suites. Run product-state, responsive-layout, design-contract, and public-route checks with an installed Chromium or Chrome executable:

```sh
YCODING_WEB_CHROME="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
  bun test verify/public-fidelity.integration.test.ts
```

`YCODING_WEB_CHROME` is required. Integration tests start local Vite servers and use Chrome DevTools Protocol without adding a browser dependency. Remote fixture states use product scenario names; viewport dimensions and all other fixture query parameters remain explicit.
