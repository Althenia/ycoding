# Session-owned selected-tab browser contract

Status: **partial. Pairing, sharing, and observation work in user Chrome; guarded mutations remain unavailable.**

## Ownership and pairing

- `Browser.Service` is Location-scoped and verifies that every supplied Session belongs to that Location. One connected extension bridge belongs to one Session, and each shared tab carries that Session ID plus bridge and document generations.
- Pairing creation requires the normal authenticated HTTP and Session-location path. It returns a random one-time secret that expires after two minutes. Core retains only its SHA-256 digest, consumes it after one successful connection, and limits rejected attempts.
- Successful bootstrap issues one durable random reconnect credential to the extension installation. Core persists only its SHA-256 digest through the existing credential store, with binding metadata for the extension ID, a durable random server identity, the exact approved Session, and its canonical Location digest. No database schema change is required.
- The connect URL contains no credential. The Server accepts only the exact secret-free WebSocket path, validates an exact `chrome-extension://<extension-id>` Origin, and requires the same extension ID plus either the one-time secret or the durable credential and server identity in the first bounded frame before attaching the transport. Origin or extension ID alone never authenticates.
- A successful durable authentication creates a new empty process-local bridge generation. Chrome, extension-worker, and server restart recovery does not restore shared tabs, debugger attachments, observations, pending calls, settlements, or actions. The extension uses alarm-backed exponential reconnect from one to 30 seconds only for the stored approved Session.
- Creating pairing for another explicit Session revokes the previous Location trust and disconnects its bridge before issuing the new secret. Stop detaches tabs and disables automatic reconnect without deleting trust; reconnect requires the popup's explicit **Connect selected Session** action. Forget removes server trust and local credential state; unknown and revoked credentials fail closed.
- A replacement bridge cannot displace a connected owner. Stop revokes only the owning Session's bridge and attachments.

## Selected-tab and non-interruption boundary

The source-only Manifest V3 extension requests `activeTab` and `debugger`, with loopback host access only for its YCoding connection. It attaches only after the user chooses **Share current tab** in the extension popup. Restricted Chrome pages and debugger-policy failures remain unavailable; there is no fallback to profile copying, a remote-debugging port, host UI automation, or arbitrary CDP.

The extension never activates, focuses, moves, or closes the user's existing tab or window and never injects host-global keyboard, pointer, or clipboard input. A shared tab is paused whenever Chrome reports it active. The extension rechecks the tab's own active state before observations and actions, so moving a shared tab between windows does not transfer automation into an active tab.

Navigate, click, and type fail closed before the extension sends any action or guard CDP command. Chrome permits `Fetch` request interception and `Target` auto-attach through `chrome.debugger`, but neither covers every client-generated download. User Chrome rejects deprecated `Page.setDownloadBehavior` with CDP error `-32000`; its `Browser.setDownloadBehavior` replacement is in the browser-wide `Browser` domain excluded from `chrome.debugger`. The profile-wide `chrome.downloads` API requires a new permission and observes cancellation only after a download begins, so it does not satisfy the selected-tab pre-side-effect boundary. No partial download guard is treated as sufficient.

Routine observations are bounded accessibility-tree projections. They omit input values, raw DOM, query strings, fragments, credentials, cookies, storage, and screenshots. Explicit capture rejects pages containing password inputs and returns at most 1 MiB of PNG data. File inputs, password inputs, explicit download links, popups, external protocols, credential-bearing URLs, and unapproved origins fail closed.

## Actions and settlement

Observe requires the owning Session, tab, bridge generation, and call ID. An observation returns document generation and observation revision plus at most 200 semantic elements.

Every action requires the same ownership identity, original call ID, bridge generation, document generation, and observation revision. Click and type additionally require a current semantic element reference. Core permits only navigate, click, type, scroll, and explicit capture; neither the public API nor model tool accepts arbitrary JavaScript or CDP commands.

Only one command may be unsettled per bridge. Internal error frames require an explicit `dispatched` boolean. The extension's guarded-action rejection reports `false`, so Core retains a `rejected` settlement without introducing mutation uncertainty. A mutation failure after dispatch, timeout, or disconnect without a known terminal result remains `uncertain` and pauses the tab. An exact retry returns the retained settlement; reuse of that call ID with different fences or action input is rejected. Neither settlement permits automatic replay. Resume is explicit and invalidates prior semantic references. A disconnect marks retained tab projections unavailable and clears their observations.

## Public operations and generated clients

The Session-location Protocol group exposes status, tabs, start, observe, action, control, stop, forget, and the extension-only WebSocket connect endpoint under `/api/session/:sessionID/browser`. Forget uses `DELETE /api/session/:sessionID/browser/pairing`. Normal HTTP operations retain existing server authentication. Schema owns all bounded wire shapes, and generated Promise and Effect clients follow the assembled `HttpApi`; generated files are never edited directly.

The built-in `browser` model tool omits start/pairing. It applies `browser_read`, `browser_navigate`, `browser_interact`, or `browser_control` permission checks at the leaf. Navigate, click, and type also reserve the `browser_mutation` Session guardrail before dispatch and release it through normal tool settlement.

## Validation boundary

Automated Schema, Core, Protocol, Server, tool, extension-protocol, and service-worker boundary tests cover the typed bounds, single-use pairing, durable server-restart authentication, extension/Session/Location binding, explicit switching, revocation, unknown/revoked fail-closed behavior, reconnect backoff, worker restart without tab or action replay, safe URL projection, stale fences, one-writer behavior, uncertain-mutation deduplication, permission/guardrail ordering, route shape, and zero CDP command dispatch for rejected navigate, click, and type actions. JavaScript parse checks cover extension entrypoints.

A real user-Chrome run verified pairing, sharing, and observation and reproduced the `Page.setDownloadBehavior` incompatibility. It did not establish guarded mutation support. A release must not claim selected-tab mutation support unless an allowed, selected-tab-scoped no-download mechanism and a non-uncertain pre-dispatch settlement are implemented and manually validated through the non-sensitive-tab procedure in [`../../docs/browser-extension.md`](../../docs/browser-extension.md), including unchanged focus, active-tab choice, unrelated tabs, typing, pointer, and clipboard.

The separate [isolated-browser contract](./isolated-browser.md) uses temporary headless state without personal logins. Its Session API, generated clients, model-tool mode, and TUI lifecycle controls are implemented, with full production acceptance pending. It does not make selected-tab mutations available or replace extension pairing semantics. The two modes share exclusive Session admission; a conflicting start or reconnect cannot replace the active mode or revoke extension trust.
