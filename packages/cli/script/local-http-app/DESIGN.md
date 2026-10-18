---
version: alpha
name: YCoding local HTTP app wrapper
description: Trusted MCP App wrapper for a separately hosted registered HTTP app.
surface: web
extends: ../../../../DESIGN.md
breakpoints:
  small: 640
---

# Local HTTP app wrapper

## Overview

Render the registered app itself in a separate-origin sandbox. The wrapper owns only its heading, lease status, Refresh control, limitations, and frame border. Inherit the root brand; reuse `../mcp-app/base.css` tokens unchanged, as documented in `../mcp-artifact-demo/DESIGN.md`. Use its Geist fallback stacks without external font requests.

## Principles

- Keep access and registration in the host; render only the explicitly supplied app lease.
- Report frame loading separately from app response verification.

## Rules

| ID | Status | Binding statement | Enforcing check |
| --- | --- | --- | --- |
| L1 | approved | Accept only the version 1 local-http-app envelope and exact injected preview origins. The empty preview-policy array MUST produce no frame. Bootstrap URLs MUST use the approved origin, `/_ycoding/bootstrap`, and one bounded opaque ticket; never render the URL as text. | `model.test.ts`, `verify.mjs` |
| L2 | approved | The wrapper MUST mount at most one frame with `allow-scripts allow-same-origin allow-forms`, no-referrer, and no bridge injected into its document. NEVER forward nested messages. Remove it on invalid input, expiry, revocation, unavailability, or pagehide. | `verify.mjs` |
| L3 | approved | Refresh MUST call only local_app_status with the current appID and sessionID. Preserve the existing frame for an unchanged lease; an absent hidden URL cannot create a frame. Never poll or open fetch, WebSocket, or SSE connections from the wrapper. | `verify.mjs` |
| L4 | approved | Show Pending initialization, Preview unavailable, Expired, Revoked, or Frame loaded in words. A frame load MUST say the app response is not verified. An unknown unavailable lease has null expiry; NEVER fabricate an expiry or accept null for ready, expired, or revoked. State the HTTP-only and WebSocket/SSE limitations. Never expose host error text. | `model.test.ts`, `verify.mjs` |
| L5 | approved | Use a single column, shared gutter and measure, 24px section gaps, 24px/32px heading, 14px/22px status, and muted limitation text. Reserve a 480px frame region; use full-width frames and strong 1px borders with 10px corners. Refresh MUST use the shared 44px action control and visible focus. Reflow at 320px in light and dark themes; use no motion. | `verify.mjs` |
| L6 | approved | index.html MUST be generated only through the owning build-mcp-apps generator. Keep the literal empty preview-policy script in the canonical resource. Its server replacement is the only source of approved origins. | `../build-mcp-apps.test.ts` |

## Responsive

Use the inherited 16px gutter below 640px and 24px gutter at or above it. The single column and full-width frame reflow without horizontal scrolling at 320px. Preserve the 480px frame region in every state.

## Components

The heading and status precede the native Refresh button. `role=status` announces state changes. The button uses `.action` shared tokens for rest, hover, focus, and dashed disabled states, with native Enter/Space activation. The reserved frame region uses surface, border-strong, and radius-md; its content is outside the wrapper design boundary. Selection uses primary colors; scrollbars use surface and border-strong. Forced-colors rendering remains system-owned. There are no icons, floating layers, transitions, or animation.

## Verification

Run `bun test ./script/local-http-app/model.test.ts ./script/build-mcp-apps.test.ts` from packages/cli. Run the separate integration command `node script/local-http-app/verify.mjs` with YCODING_TEST_PLAYWRIGHT_MODULE pointing to installed playwright-core and optional YCODING_WEB_CHROME. The disposable loopback fixtures verify 320, 639, 640, and 1440px, light/dark, and reduced/full-motion preferences. Results are SIMULATEDHOST evidence only, not proof of actual ChatGPT embedding or production access.

## Maintenance

Keep policy validation, lifecycle tests, and the template aligned. Regenerate the canonical document after changing the template, client, model, or shared inputs. Keep fixture servers confined to the integration harness.
