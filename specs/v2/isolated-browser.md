# Session-owned isolated browser

Status: **implemented and locally validated on macOS arm64 with Chrome 152, including Bun and Node packaged runtimes. Validation limits below remain explicit; this is not a release certification.**

This contract adds temporary headless browsing to the existing TUI product. It does not replace the [selected-tab extension contract](./browser.md), provide a desktop browser product, or establish release readiness from proof-of-concept results.

## Approved scope

- A user explicitly starts an isolated browser for the current Session with an HTTP or HTTPS URL. Starting is not a model-tool operation.
- Initial support is restricted to the verified environment: macOS arm64 with installed Google Chrome major version 152. Other environments remain unavailable until their production-path acceptance is established. Version matching alone is not proof that required controls are available.
- The browser uses a fresh dedicated temporary profile and disposable context, with one controllable page. It never attaches to a personal Chrome process or copies a personal profile, login, cookie, password, or browser storage.
- Browser state is temporary. There is no persistent login store, manual-login window, visible browser handoff, or automatic browser recreation after restart.
- Installing or downloading Chrome, changing host policy, and adding dependencies are outside this implementation scope.

## Mode ownership

The selected-tab extension and isolated executor are distinct supported modes, not interchangeable targets. A Session must explicitly stop its active mode before starting the other. Conflicting startup or reconnect must fail without replacing the active target or revoking unrelated trust.

Isolated startup neither consumes nor revokes extension credentials. Isolated stop affects only its own process and temporary resources. Selected-tab stop retains its established trust semantics. Forget remains an explicit extension-trust operation and is not an isolated-browser lifecycle operation.

Every isolated operation validates the Session against the active Location. Observations and actions additionally identify the isolated instance, opaque tab, connection generation, document generation, observation revision where applicable, and original call ID. A newly created instance rejects every identifier and observation from the previous instance. Raw CDP target IDs, controller endpoints, process arguments, and temporary paths remain internal.

## Startup and action admission

The Core executor owns the launched process, private controller transport, context, target admission, and cleanup. Private child-process transport is preferred over a debugging listener and requires production validation; there is no fallback to an existing Chrome debugging endpoint.

Before navigation or ready status:

1. Verify the supported executable and required capabilities.
2. Launch with an owned temporary profile and establish the controller.
3. Create a context with disconnect disposal and acknowledged download denial.
4. Install target admission, popup handling, and required restricted-effect controls.
5. Create the owned page and navigate to the explicitly requested safe URL.

Failure at any step rejects startup, prevents action dispatch, and cleans up owned resources. A partially guarded page must never be presented as ready.

The public surface accepts semantic observe, navigate, click, type, scroll, and capture only. It does not accept arbitrary JavaScript, CDP, filesystem paths, storage extraction, uploads, or host-global input. The model tool applies the existing browser permissions and reserves the `browser_mutation` Session guardrail for navigate, click, and type. Direct authenticated user controls do not grant additional model permission.

The executor must enforce restrictions on downloads, file pickers/uploads, password-field input/capture, clipboard access, external protocols, frames, redirects, and unapproved origins. A successful CDP configuration response alone is insufficient evidence. If any required restriction cannot be enforced, the affected capability stays unavailable rather than using an approximate guard.

Routine observations retain the existing bounded accessibility projection: at most 200 elements, no input values or raw DOM/storage, and no URL query or fragment. Explicit capture remains bounded to 1 MiB and must reject password-bearing pages after inspecting the pierced document tree, including child-frame documents and open or closed shadow roots. Inspection is bounded to 32 levels and 10,000 nodes; incomplete or malformed traversal rejects before screenshot dispatch. Input size and CDP response buffering remain bounded.

## Popups

Unexpected page targets are never automatically adopted. The implementation candidate established by the local experiment is:

1. Pause the new target and verify context ownership.
2. Disable its scripts and acknowledge request-stage interception.
3. Release its debugger pause while interception holds document requests.
4. Close it and verify destruction.
5. Verify that the originating action settles and the opener remains responsive.

Failure of popup containment stops further dispatch and tears down the owning isolated context. Resuming an unguarded target is prohibited. Multiple and repeated popups require the same guarantees, not just a successful single-popup test.

## Settlement and recovery

- A rejection proven to occur before dispatch is not an uncertain mutation.
- An action is completed only with a verified terminal result. Timeout, disconnect, cancellation, or crash after dispatch without a known result settles as uncertain; it is never replayed automatically.
- Disposal of the context does not prove that a website mutation did not already occur.
- Each admitted action has exactly one terminal settlement. Late responses cannot overwrite it.
- Exact retries reconcile without a second dispatch. Conflicting call-ID reuse fails. Bounded settlement retention must not reopen an older call for execution.
- Pause blocks further action admission. Its displayed meaning must match whether in-flight work or page scripts can continue; the UI must not imply that the website is frozen without an enforced and tested freeze.
- Stop remains available for recovery, invalidates observations, terminates owned work, and cleans up only resources created by that executor.
- Browser exit, target crash, controller loss, Location disposal, and server restart invalidate ownership. Recovery requires explicit fresh startup and never restores or replays page actions.

Browser ownership is process-local. Existing durable tool-result handling records user-visible results; this feature does not add a database migration or persist browser authentication/state.

## Additive public surface

The `IsolatedBrowser` Schema namespace and `isolatedBrowser` client group are separate from existing extension shapes. The existing `/browser/start` operation continues to return pairing material.

All isolated routes retain normal server authentication and Session-location middleware under `/api/session/:sessionID/browser/isolated`:

| Operation | Method and suffix | Input or result                                                                    |
| --------- | ----------------- | ---------------------------------------------------------------------------------- |
| Status    | `GET`             | Discriminated isolated lifecycle state and safe target metadata.                   |
| Tabs      | `GET /tabs`       | The owned controllable page, if available.                                         |
| Start     | `POST /start`     | User-supplied safe URL; returns lifecycle status, never pairing material.          |
| Observe   | `POST /observe`   | Instance, tab, generation, and call identity; bounded observation.                 |
| Action    | `POST /action`    | Instance identity plus existing action/freshness fences; discriminated settlement. |
| Control   | `POST /control`   | Explicit pause or resume.                                                          |
| Stop      | `DELETE`          | Stops only the owning isolated instance.                                           |

The status states are `unavailable`, `starting`, `ready`, `paused`, and `stopped`, with `mode: isolated`, an optional safe reason, instance identity, and current tab where valid. The model tool explicitly selects isolated mode; omitted mode retains the existing selected-tab meaning and never falls back based on availability. Status and control results containing page metadata require `browser_read` before model exposure; control permission alone does not authorize reading page metadata.

Schema and Protocol own the wire contract. Promise and Effect clients must be regenerated through the client package's owning command and verified against it, not edited directly.

## TUI requirements

The current Session command palette opens clearly labelled isolated-browser controls. The dialog explains temporary state and absent personal logins. Start asks for a URL and does nothing on cancellation; mounting, reconnecting, refreshing, or reopening never starts a browser.

The dialog displays current state and offers valid explicit controls without double submission. Dismissing the dialog does not imply that the backend stopped. A lost start response triggers status reconciliation, not a second start or selected-tab fallback. Stale responses after Session/Location changes must not update the new view. Fetch failure must not retain a misleading ready state.

Errors and target summaries must exclude credentials, query/fragment values, raw internal errors, and host paths. Keyboard navigation, dismissal, pending/error states, and narrow-terminal rendering require actual component or render tests.

## Acceptance gates

The table defines required evidence, not a blanket completion claim. Production-path coverage is described below; the successful local experiment alone is not a substitute for these gates.

| Gate                | Required evidence                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target isolation    | Cross-Session, cross-Location, cross-mode, and previous-instance references cannot dispatch; personal Chrome is untouched.                                                                    |
| Startup failure     | Missing/incompatible Chrome and failed controls produce no action dispatch or orphaned owned process.                                                                                         |
| Happy path          | Real semantic actions work through the Session API and TUI/tool path with fresh observations.                                                                                                 |
| Downloads           | Attachment navigation, network link, blob link, data link, typing-triggered blob, and popup download denial; Browser events and empty owned download directories; separate positive controls. |
| Popups              | Repeated and concurrent rejection prevents unauthorized document/script effects, destroys targets, and leaves opener/input/action settlement usable.                                          |
| Restricted effects  | File picker/upload, password input/capture, clipboard, external protocol, frame, redirect, and unapproved-origin boundaries have executable coverage.                                         |
| Settlement          | Cancellation, timeout, late result, duplicate/conflicting call ID, and retention boundaries cannot replay or report false success.                                                            |
| Recovery            | Stop, controller loss, browser exit, target crash, Location disposal, and server restart invalidate ownership and clean up owned resources.                                                   |
| Privacy             | Responses, observations, logs, events, tool results, and TUI output do not disclose prohibited content.                                                                                       |
| Compatibility       | Existing extension pairing, reconnect, stop, forget, selected-tab restrictions, and generated clients retain their meanings.                                                                  |
| Usability/resources | Rendered lifecycle/error controls work; process count, output, startup, action, and shutdown limits are bounded and tested.                                                                   |
| Distribution        | Real-browser and packaged-runtime checks pass on every advertised environment; others report unavailable.                                                                                     |

### Packaged-runtime verification

Production-path tests now cover:

- `packages/core/test/browser`: unit tests for Session/instance/mode fences, startup/stop races, unavailable-executor rejection before launch, exactly-once settlement, cancellation, late results, retention, controller loss, and Location disposal. Popup-failure settlement and teardown are injected at the service boundary, not by forcing a Chrome containment command to fail.
- `packages/core/test-integration/browser/isolated-executor.test.ts`: real Chrome fixtures cover all six download triggers with separate positive controls and empty denied-download directories, repeated/concurrent popup containment, restricted effects, browser/target crashes, oversized capture rejection, and bounded shutdown of a deliberately suspended owned browser.
- `packages/core/test-integration/tool-browser-integration.test.ts`: real semantic actions through canonical tool settlement, with synthetic query, fragment, input-value, and hidden-DOM markers excluded from textual results. Image payloads are not covered by that text-secrecy assertion.
- `packages/server/test-integration/isolated-browser.test.ts`: authenticated lifecycle, privacy markers, Session-derived Location, eviction, cross-Location references, and durable Session restart without browser recreation or stale dispatch.
- `packages/tui/test-integration/isolated-browser-integration.test.tsx`: rendered explicit Start and Stop through the generated client, real Server, and installed isolated Chrome. Component tests separately cover lifecycle/error controls, stale responses, safe rendering, and narrow terminals.

From the repository root, `bun run test:unit:browser` runs the mocked Core boundaries and TUI component checks. `bun run test:integration:browser` separately runs the real Core, Server, and TUI browser suites and requires the supported host and Chrome installation.

Real-browser execution is verified only on macOS arm64 with Chrome 152. Missing/incompatible installations are represented by unavailable executor fixtures; other host environments have not been runtime-validated. Tests do not inspect or interact with personal Chrome profiles. Both Bun and Node SEA candidates passed the explicit checks below after the final runtime change; future runtime changes require a fresh build and rerun.

On macOS arm64 with Chrome 152 installed, run the isolated-browser smoke harness against each freshly built candidate. From `packages/cli`:

```sh
bun script/isolated-browser-smoke.ts --binary="$BUN_OUT/cli-darwin-arm64/bin/ycoding"
bun script/isolated-browser-smoke.ts --binary="$NODE_OUT/cli-node-darwin-arm64/bin/ycoding-node"
```

`BUN_OUT` and `NODE_OUT` must identify the output directories from the owning `script/build.ts --single --outdir=...` and `script/build-node.ts --single --skip-install --outdir=...` commands. The Node build requires its existing cached runtime and installed build dependencies. Do not install dependencies or download a browser merely to satisfy this check without approval.

The harness starts the candidate with temporary HOME/XDG/project directories and a loopback fixture, then checks private-pipe start, observe, click, stop, and synthetic-marker privacy. The release workflow runs the integration gate and this harness against its built darwin-arm64 Bun candidate before packaging release assets; Node SEA verification remains an explicit local check. Rebuild and rerun after runtime changes; a passing candidate smoke does not replace the other acceptance gates or establish support on another environment.

Release 0.2.0 remains blocked until applicable production acceptance passes. Release notes must distinguish isolated actions from unavailable selected-tab mutations; they must never claim that this executor adds mutation support to the user's personal Chrome tab.
