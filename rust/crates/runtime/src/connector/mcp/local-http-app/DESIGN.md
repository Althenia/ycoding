---
version: alpha
name: YCoding local HTTP app wrapper
description: Trusted status wrapper for an independently hosted registered HTTP app.
surface: web
extends: ../../../../../../../DESIGN.md
breakpoints:
  small: 640
---

# Local HTTP app wrapper

## Overview

Render the registered app in a separate-origin sandbox. Own only the heading, lease status, Refresh control, limitations and frame border. Read palette, typography, spacing and control tokens from `apps/web/src/styles/tokens.css` through `build.mjs`. Use the shared Geist fallback stacks without external font requests.

## Principles

- Keep registration and access in the runtime; accept only the host-supplied lease.
- Distinguish a loaded frame from a verified app response.

## Rules

| ID  | Status   | Binding statement                                                                                                                                                                                                                                                                                                          | Enforcing check                        |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| L1  | approved | Accept only the version 1 local-http-app envelope and exact injected preview origins. An empty policy MUST mount no frame. Bootstrap URLs MUST use the approved origin, `/_ycoding/bootstrap` and one bounded opaque ticket; NEVER render the URL as text.                                                                 | `model.test.ts`, `verify.mjs`          |
| L2  | approved | Mount at most one frame with `allow-scripts allow-same-origin allow-forms` and no-referrer. NEVER inject a host bridge into the child or forward nested messages. Remove the frame on invalid input, expiry, revocation, unavailability or pagehide.                                                                       | `verify.mjs`                           |
| L3  | approved | Refresh MUST call only local_app_status with the current appID and sessionID. Preserve an unchanged lease's existing frame. An absent private URL cannot create a frame. NEVER poll or open fetch, WebSocket or SSE connections from the wrapper.                                                                          | `wrapper.test.ts`, `verify.mjs`        |
| L4  | approved | Show initialization, unavailable, expired, revoked and loaded states in words. A frame load MUST state that the app response is not verified. Only an unknown unavailable lease may have null expiry. State the HTTP-only and WebSocket/SSE limitations; NEVER expose host error text.                                     | `model.test.ts`, `verify.mjs`          |
| L5  | approved | Use a single column, shared measure, 24px section gaps, 24px/32px heading, 14px/22px status and muted limitation text. Reserve a 480px frame region with a strong 1px border and 10px corners. Refresh MUST use the shared 44px action control and visible focus. Reflow at 320px in light and dark themes without motion. | `wrapper.test.ts`, `verify.mjs`        |
| L6  | approved | MUST generate index.html only with build.mjs. Hash every maintained runtime input and the current shared token source. Keep the canonical empty preview-policy script; replace it only from the server's approved-origin policy.                                                                                           | `wrapper.test.ts`, `build.mjs --check` |

## Responsive

Use the inherited 16px space-4 gutter below 640px and 24px space-6 gutter at or above it. Preserve the single column, full-width frame and 480px frame region at every width.

## Components

Place the heading and live status before the native Refresh button. Own button rest, hover, active, dashed disabled and focus-visible states through shared tokens. Apply hover states only on hover-capable pointers. Use native Enter and Space activation. Selection uses primary colors; scrollbars use surface and border-strong. Forced-colors system rendering is the accessibility exception. The registered app's contents are outside this wrapper's design boundary.

## Verification

Run model.test.ts and wrapper.test.ts from the Runtime package with Bun. Generate the canonical document with build.mjs before Rust compilation. Run verify.mjs separately with YCODING_TEST_PLAYWRIGHT_MODULE pointing to installed playwright-core and optional YCODING_WEB_CHROME. Its disposable fixtures cover 320, 639, 640 and 1440px, both themes and both motion preferences. Treat results as simulated-host evidence, not actual chat-host support.

## Maintenance

Keep the model, client, resource envelope and tests aligned. Regenerate through build.mjs after maintained inputs or shared tokens change. Confine fixture servers to verify.mjs.
