# Web package guide

## Browser integration verification

Browser-driven tests are explicit integration checks and must not run from `src` unit suites. Run public Stitch fidelity checks with an installed Chromium or Chrome executable:

```sh
YCODING_WEB_CHROME="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-mac-arm64/chrome-headless-shell" \
  bun test verify/public-fidelity.integration.test.ts
```

`YCODING_WEB_CHROME` is required. The test starts a local Vite source server, blocks the service worker, and uses Chrome DevTools Protocol without adding a browser dependency.
