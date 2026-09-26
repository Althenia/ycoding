# @ycoding-ai/web

The YCoding public site and remote workspace: a SolidJS application built with Vite.

Ownership: everything under `apps/web/**`. Root manifests, lockfile, CI workflows, the Cloudflare relay, and the shared contract package are owned elsewhere.

## Scripts

| Script | Purpose |
| --- | --- |
| `bun run dev` | Vite development server on port 3002. |
| `bun run build` | Production build into `dist/`, including `sw.js` at the site root. |
| `bun run preview` | Serve the built output for inspection. |
| `bun run test` | `bun test ./src`. |
| `bun run test:integration` | `bun test ./test`. Requires a production build and fails when `dist/` is missing. |
| `bun run typecheck` | `tsgo --noEmit`. |

## Dependencies

Runtime: `solid-js` (catalog) and `@ycoding-ai/remote` (workspace) for the relay envelope, operation list, and HTTP response types.
Development: `vite`, `vite-plugin-solid`, `typescript`, `@typescript/native-preview`, `@types/bun`, `@tsconfig/bun`.
Routing, theming, icons, dialogs, and the service worker are implemented here without additional packages.

## Surfaces

- `/` — landing page: hero, capability strip, local-execution trust section, install guidance, remote status.
- `/docs/*` — documentation shell with grouped navigation, keyboard search, on-page headings, code blocks with local scrolling and copy, and honest empty states.
- `/changelog` — curated release history with year and change-type filters.
- `/remote`, `/remote/sessions`, `/remote/activity`, `/remote/settings` — the remote workspace: device and session header, session list, conversation with streamed assistant text, tool and terminal output, permission/guardrail/question replies, sticky composer with explicit delivery mode, interrupt, autonomy and goal controls, dismissible in-app notices for live events, and device enrollment plus notification preferences.
- `/sw.js`, `/manifest.webmanifest`, `/offline.html`, `/robots.txt`, `/sitemap.xml` — PWA shell files plus crawler metadata. `sitemap.xml` is emitted by the build from the published documentation allowlist; `robots.txt` disallows the private workspace and names the sitemap.

## Boundaries

- **Head metadata is route-owned and single-sourced.** `src/seo/metadata.ts` resolves one metadata object per path. Published pages get a canonical URL on `https://ycoding.althenia.app`, a description, and OpenGraph plus Twitter summaries; the private workspace and unknown or unpublished paths get `noindex,nofollow` and no canonical. Canonical URLs are built from the normalized path alone, so query strings and fragments never reach the head. The client owns these tags at runtime, while `index.html` carries the matching pre-hydration baseline for crawlers and social previews that do not run JavaScript. `src/seo/sitemap.ts` lists the same public routes and derives from `PUBLIC_DOC_PATHS`, so the sitemap follows the documentation allowlist instead of a second URL list.
- **Public documentation is authored, not generated.** `src/content/docs/pages/*` holds the allowlisted pages; `registry.ts` maps them to the approved routes. `src/content/boundary.test.ts` fails the build if published copy leaks relay topology, hosting provider names, internal package paths, private plans, or credential-shaped values, and `registry.test.ts` fails if a page appears outside the approved route list.
- **The service worker caches the static shell only.** `src/pwa/offline.ts` owns the precache list and the blocked-path policy; `src/service-worker.ts` never intercepts API, authentication, or socket traffic and registers no background sync or mutation queue.
- **Alerts are live-only.** `src/remote/notifications.ts` maps the payloads the relay forwards to the five configured categories and delivers them into the store's in-app notice list and, only when the browser already granted permission, to a desktop alert with fixed generic wording. A category keeps one in-app notice, so repeats replace instead of stacking. The store derives alerts where a live event reaches the projection, so an event dropped as a duplicate raises one alert and the snapshot, history, and reconnect paths raise none. Alerts end with the connection that raised them: sign-out, a rejected credential, a new connection (a device switch or a manual reconnect), a deliberate disconnect, and store disposal close the notices and the desktop alerts, while an automatic reconnect keeps them. A deliberate close raises no device-disconnected alert. The delivery itself stays usable, so the next connection raises its own alerts. `NotificationSettings` requests browser permission only from its explicit button.
- **One session subscription per connection.** The relay registers a client's subscriptions per socket and the agent refcounts them, so `session.unsubscribe` is only sent for a session the live connection registered. Selecting another session releases the previous one, a selection that loses a race releases the subscription it registered itself, and a connection that replaces another starts with no subscriptions and ignores the replaced socket's late status.
- **Remote data is real or absent.** The workspace renders the store's state and keeps the account separate from the relay connection: checking the account, signed-out, not-configured, no machine enrolled, no machine selected, connecting, connected, offline, or error. An open authenticated relay that rejects the current `session.list` request with `agent_unavailable` marks the selected device offline while retaining the signed-in owner and enrolled devices; a later successful advertised list restores the connected state. Other read failures and closed sockets remain connection errors rather than claims that the device is offline. A browser whose account read has not settled yet is shown as checking the account, never as signed out, and a signed-in account with no usable machine is never rendered as signed out either. It never renders sample conversations, and an action that fails to settle stays visible as an unknown outcome instead of being replayed automatically.
- **Mobile machine selection is explicit.** Below 480px, the machine picker is a keyboard-contained dialog. Selecting an option stages it until **Confirm Selection**; Escape, the close control, or the backdrop discards that choice and returns focus to the trigger. Wider layouts select immediately from the popover. Only currently available options can be confirmed.
- **Session creation uses backend choices.** New session appears in Sessions, the conversation sidebar, and the empty conversation. The dialog lists previously opened repositories from `workspace.list` and sends only an opaque workspace ID and a fresh Session ID to `session.create`. Creation stays idle until the user sends a prompt. Unknown outcomes retain the same ID for an explicit check or retry; closing the dialog does not cancel creation or navigate after late success. Selecting an existing Session opens Conversation directly.
- **Drafts belong to the remote store.** Unsent text is held per Session through remote-route navigation and same-machine reconnects, including an account refresh that reports the selected machine offline. A machine switch, explicit disconnect, sign-out, or store disposal clears it. Page reloads do not retain drafts.
- **One account read owns the account state.** `GET /api/me` is the only source of the owner, the device list, and the automatic single-device connection, and a read applies only while the account context it describes still owns the store. Sign-out, a rejected relay device, a deliberate disconnect, and a newer read all invalidate a read that is still in flight, so a response that settles later cannot restore an account, a device, or a socket the user has already dropped. A relay rejection tears down the selected device and refreshes the account without first deleting the signed-in owner: a 401 or 403 answer then signs the browser out, while a failed refresh retains the known account. Device history remains available to settings; automatic connection selects only the single active device, never a revoked one.
- **Keep the one-use enrollment code separate from the identifier.** `enrollmentInstructions` builds `ycoding remote enroll <enrollmentID> --relay <origin>` for the current site; the one-use code is displayed separately and never enters the command, because the CLI reads it from a hidden prompt.
- **Streaming is contract-driven.** `src/remote/projection.ts` projects the actual `packages/schema` event payloads, including `Model.Ref` objects rather than strings, and counts events it does not display. `session.snapshot` loads durable history only: a finalized text or reasoning ordinal is protected against delayed fragments, a fragment for an unfinished ordinal still streams, and fragments received while a snapshot is in flight are replayed on top of it. The durable `Event.Seq` watermark advances per session aggregate, so duplicates are dropped and a gap forces exactly one canonical re-read.
- **Terminal output keeps the device's page and its limits.** The projection keeps the `Shell.Output` page the device sent — its text, `cursor`, `size`, and `truncated` — on both the live `session.shell.*` events and the snapshot message; no local character cap drops device output. The collapsed view is a pure preview (`previewText`), "Show more" renders the whole fetched page, and the device's own limit is a separate notice (`shellOutputNotice`) that names the retained byte count, so a "Show more" control never stands in for output the device did not send.
- **Reading past the first page is one explicit request per click.** `RemoteStore.loadShellOutputPage` sends one `session.shell.output` request for the session that owns the shell, carrying the shell's own recorded ID, the client's absolute byte cursor, and a 65 536-byte page budget, and appends the returned page to the page already held under one byte cursor. It never pages on its own and never polls: a page that adds nothing while the device still holds bytes renders as a held incomplete character with a retry, and the control disappears once the cursor reaches the captured size. "Show more"/"Show less" expands only the text the client already holds and stays separate from "Load output"/"Load more output". Loading, a refused or failed request, an unsettled read, and an unsupported operation are each reported through `shellOutputPaging` without changing the text. A page is applied only while the selection that opened the read still owns the view, only to the shell it names, and bytes a durable update already delivered are dropped instead of repeated. A shell tool part renders the same control for the shell the device reported in `structured.shellID`; no capture path or marker text is ever read.
- **Tool detail keeps what the device sent.** Tool parts retain the `ToolState.*.structured` record (`shellID`, truncation state, exit status) for correlation, and tool text renders as received: the projection rewrites no marker text and strips no device path from the authenticated owner's own output.
- **Recorded file changes come from the session's own ledger.** The store reads `session.fileChange.list` on selection and on reconnect and keeps each path's latest patch, with a live `session.file-change.recorded` updating the same path. A record that arrives while the ledger read is pending wins over that read, and a read that settles after the selection moved writes nothing. A rejected, timed-out, or capacity-limited ledger read preserves live records and reports the failure, including an unsupported operation. Request saturation does not claim that an open connection has closed. The response carries no owner field, so the client never attributes a change to a child session.

## Deployment expectations

The built `dist/` is served at the product origin with an SPA fallback to `index.html`. A separate asset-publishing step (owned by the parent) exports the installer, configuration schema, and example configuration so these canonical paths resolve:

- `/install.sh`
- `/ycoding.schema.json`
- `/examples/ycoding.jsonc`
- `/sitemap.xml` — emitted by `vite build` from the documentation allowlist, not by the asset publisher

`src/content/site.ts` is the single place that references them.

## Brand assets

`public/brand/ycoding-mark.svg`, `public/icons/icon-256.png`, and `public/icons/icon-512.png` are byte-identical copies of the canonical files in `assets/brand`. `src/brand-assets.test.ts` fails if a copy drifts; regeneration belongs to the repository brand generator, not this package.

## Verification

A bare word argument selects by filename rather than by directory, so `bun test test` also matches source tests. The scripts pass explicit relative paths (`bun test ./src`, `bun test ./test`), which select by directory: `bun run test` selects the source suite and `bun run test:integration` selects the integration files under `test/`.

```
bun run typecheck
bun run test
bun run build
bun run test:integration
```

- `bun run test` states the source-level behavior: route matching, route head metadata (canonical, OpenGraph, and noindex decisions), sitemap routes drawn from the documentation allowlist, defensive storage, theme resolution and persistence, the service-worker cache policy, the documentation allowlist and publication boundary, changelog integrity, the online/offline notice rule, event projection, shell output metadata with its preview, device-limit, and page-control helpers, paged output merging with its duplicate-drop rule, tool structured retention, recorded file-change projection, notification categorisation, and notification channel gating.
- `bun run test:integration` states client behavior against real local boundaries: the relay envelope over a real HTTP and WebSocket double (`test/relay-double.ts`), snapshot synchronization (duplicate suppression, missed-sequence re-read, finalized-ordinal protection, fragments received during a reload), request replies, alert delivery from live events, alert lifetime across sign-out, credential rejection, and device switch, session subscription release including a superseded selection, recorded file-change ledger reads on selection and reconnect with live-record precedence over a pending read and a fence for a read that settles after the selection moved (`test/remote-file-changes.test.ts`), explicit shell-output page reads with their cursor, page budget, in-flight de-duplication, stalled held tail, unsupported-device copy, and fences for a selection or connection that moved while a page was in flight (`test/remote-shell-output.test.ts`), and the built artifact served by `vite preview` (routes, service worker, PWA files, responsive CSS).

The integration suite deliberately fails instead of skipping when `dist/` is absent, because an unbuilt artifact is a missing verification step.

### Browser verification fixture

`verify/remote.html` renders the real store, projection, and workspace components against a synthetic transport and account client. It exists to check interface behavior in a browser without a hosted relay or credentials.

```
YCODING_WEB_VERIFY=1 bun run build
bun run preview --host 127.0.0.1 --port 4319
# open http://127.0.0.1:4319/verify/remote.html  (add ?view=settings for the settings surface)
```

The fixture is an extra build input only when `YCODING_WEB_VERIFY=1` is set, and its page states that the data is synthetic. A production build must not contain it; confirm after `bun run build` that `dist/verify` does not exist.

The fixture's device answers `session.shell.output` with exactly one page per request under absolute byte cursors, including a capture whose second page carries multi-byte characters, a running shell whose first read holds an incomplete character, a shell the device does not serve paged output for, and a backgrounded shell tool. With `?connection=offline`, it instead keeps the synthetic browser relay open, advertises sessions, and rejects the list read with the relay's structured `agent_unavailable` response. `window.remoteShellOutputReport()` reports the rendered text, device-limit notice, page control, and request state per captured output, so a browser check reads what the real components painted instead of querying the DOM ad hoc.

Fixture limitations: the transport, account responses, devices, sessions, and transcripts are local stubs. It proves interface behavior only — dialog and drawer behavior, stream rendering, request replies including hard guardrail reviews, reconnect handling, and settings — and it is not evidence for account authentication, device enrollment, relay authorization, or session ownership, which require a configured deployment.

### Interface requirements the browser check verifies

- No page-level horizontal overflow at 320, 390, 768, 1024, 1280, and 1440 pixels across landing, docs, changelog, the remote workspace, settings, and the not-found route.
- Both themes render at 390x844, 1024x1366, and 1440x900 for landing, docs, changelog, and the remote conversation and approval surfaces.
- The stored theme preference is applied before first paint; explicit light and dark override the system preference, and `system` follows it in both directions.
- Offline status text meets the 4.5:1 normal-text contrast threshold against its translucent background in both themes.
- Search and drawer dialogs trap Tab, close on Escape, and return focus to the control that opened them.
- Reduced motion removes transitions, and a 200% zoom leaves no horizontal overflow.
- The composer stays visible and focusable while the transcript streams, and terminal output remains bounded with local scrolling.
- A deployment without API routes reports remote access as unavailable and lists no sessions, messages, or devices.

Authenticated account, device, and relay flows are outside this package's verification and depend on a configured deployment.
