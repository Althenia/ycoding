# Runtime behavior

This document specifies runtime behavior. Exact types and endpoint names remain owned by Schema and Protocol.

## Sessions

### Workspace knowledge is separate

The built-in `memory` tool accesses explicit linked Markdown knowledge. Repository memories are keyed by the canonical Git common directory, so the main checkout, its subdirectories, symlink aliases, and every linked worktree share one repository collection; shared knowledge lives under `knowledge/` and remains available outside Git. The tool has no automatic transcript extraction, learning, or prompt injection. Permissions protect reads and writes; writes and offline HTML graph export also use the existing file-mutation guardrail. Concepts remain authoritative files, independent of durable Session events and managed project artifacts. See [Workspace knowledge memory](./memory.md) for the configuration, format, retrieval, and conflict contracts.

### Durable admission

A prompt is durably admitted before execution is scheduled. The durable pending row represents unconsumed work only. Promotion into the visible transcript and removal from pending state occur at a safe execution boundary.

Reusing a Session ID adopts the existing session. Reusing a prompt message ID is accepted only for an exact retry with matching session, content, and delivery mode; conflicting reuse fails.

### Archive and unarchive

The session list offers **archive/unarchive** for the selected Session (`ctrl+a` by default). Archive opens a confirmation; cancel returns to the list without changing the Session. Archived entries remain visible with an `Archived` label. Unarchive clears that state. Neither operation changes the last-activity timestamp or deletes history.

Automatic retention deletion is not performed. Standalone and managed processes can share one SQLite database, while execution ownership and active-work tracking are process-local. A safe retention policy requires cross-process coordination before it can permanently delete archived families. Archiving does not start a deletion timer.

SQLite can still reclaim pages freed by explicit deletion without deleting additional records; see [automatic SQLite space reclamation](./configuration.md#automatic-sqlite-space-reclamation) for startup conversion and disk-space constraints.

### Daybreak access program

Daybreak is OpenAI's Trusted Access for Cyber program with the access levels `daybreak_blue` and `daybreak_red`. A Session stores its selection in `session.daybreak`; an absent value is off and requests keep standard safeguards. Every change appends the durable `session.daybreak.set` event containing the Session ID and the optional selected program, where an absent program means off.

One toggle command controls the selection: it is visible in the Session command palette and also runs as the `/daybreak` slash command with the optional arguments `blue`, `red`, and `off`. Without an argument it cycles off → blue → red → off, offering only programs the active model advertises and skipping programs it does not advertise. The model picker lists ordinary models only; Daybreak state comes from the toggle, not from picking a special model. Catalog discovery and provider request fields are specified in [configuration](./configuration.md).

### Managed attachments

Prompt inputs remain URI-shaped. Admission reads `data:` and local file URIs, normalizes supported images, enforces a 20 MiB byte limit, and imports the resulting bytes into the global content-addressed attachment store. An opaque existing reference is accepted only in the exact form `ycoding-attachment://sha256/<lowercase SHA-256>` and is reverified before admission.

Durable user attachments contain only `{ content: { type: "managed", digest, bytes, path }, mime, name?, description?, mention? }`. Core derives the managed path from the digest, requires containment below the configured data directory, rejects symlinks and non-regular files, and verifies the declared byte count and SHA-256 before use. Base64 payloads and source URIs are not retained in durable events, pending rows, projected messages, or generated durable attachment types.

During request assembly, PNG, JPEG, GIF, and WebP files are reread into transient `Uint8Array` provider media. Every other attachment, including PDF, XLS, XLSX, and SVG, is model-visible as text metadata containing its MIME, byte count, digest, and internally resolved absolute managed path. The runtime verifies every managed file before exposing either bytes or a path.

The idempotent `managed-attachments-v1` application migration scans `session.input.admitted.1` events plus user rows in `session_pending` and `session_message`. It imports legacy base64 payloads, verifies rows already using managed references, rewrites all three stores in one database transaction, and records its completion marker only after every row succeeds.

### Execution ownership

`SessionExecution` is process-global and keyed by Session ID. It uses a process-local coordinator to:

- serialize drains for the same session;
- join explicit same-session resumes;
- coalesce advisory wakes;
- allow different sessions to execute concurrently.

A drain discovers the session's Location when execution starts. There is no clustered execution ownership yet. Public event replay ownership is separate from local execution ownership.

### Remote relay agent

`ycoding remote connect` runs one foreground outbound agent connection to the configured relay until the operator stops it or the process exits. The agent dials out over WSS and never listens. An authenticated browser may connect only to a device owned by its account. Every local call uses a Location read from the backend's global Session inventory, never from remote input, and execution authority stays in the local `ycoding` process; the relay and browser own no repository, shell, tool, model, or Session execution.

Device ownership grants access to all existing and future Sessions in the connected backend. The agent pages the complete global Session list without a fixed page-count cap; each scoped operation resolves its Session again and verifies it at the inventory's current Location. Moved Sessions follow that authoritative Location, while deleted and unknown IDs fail closed. `remote.json` Session entries are not an authorization source and are not rewritten. The wire sends the bounded `{ type: "sessions" }` invalidation on connect and after Session creation, movement, or deletion; clients then page `session.list`, so no whole inventory crosses one event frame.

The browser's Session list retains the reported `projectID` and `location.directory` from each page. These fields describe the backend's placement; they do not authorize a browser-selected Location. Missing or malformed metadata remains absent rather than being inferred from a Session title.

Inbound frames pass the shared envelope parser before any local call, and every input field is validated before any local side effect. Mutations are attempted exactly once: a prompt carries its durable message ID unchanged so an exact local retry reconciles, approval and Form settlement carry no retry key, and an indeterminate outcome is reported as `outcome_unknown` instead of being replayed. Remote human input uses the native Form contract: `session.form.list`, `session.form.reply`, and `session.form.cancel`. Before reply or cancellation, the agent lists pending Forms at the addressed Session's authoritative current Location and requires the matching Form to carry that Session ID; global, unknown, settled, and cross-Session Form IDs are refused before settlement. Native `form.created`, `form.replied`, and `form.cancelled` events pass through without Question synthesis, with `form.created` ownership read from its nested `form.sessionID`. Tool, shell, permission, Form, and guardrail handling retain their local ownership and pending-state checks.

One local event stream stays open while the agent is connected, even when no browser currently subscribes, so Session lifecycle events can invalidate client lists. Stream end and failure retry with bounded exponential backoff while the relay connection remains live and stop retrying after close. The relay owns each browser client's bounded subscription set and sends complete `{ type: "subscriptions", clientID, sessionIDs }` snapshots to the agent after successful subscribe or unsubscribe settlement, when a browser or replacement agent attaches, and as an empty snapshot when a browser detaches, expires, logs out, or loses authorization. The agent clears this derived index on relay close and open, then forwards Session events only for the union of current snapshots; late acknowledgements from detached clients cannot restore interest. Events are forwarded verbatim, once, in arrival order, and queued events remain bound to the connection that received them so replacement cannot send stale work. Heartbeat pings keep the socket alive. A closed or refused socket reconnects with bounded exponential backoff, starting at one second and doubling to thirty seconds; a rejected credential rotates once, and a device the relay refuses again stops the agent as terminal instead of retrying indefinitely.

After relay hibernation, restoration finishes before new upgrades or messages are admitted. The surviving agent is restored first; expired, unauthorized, or invalid browser attachments send an empty subscription snapshot before closing, so the agent drops their forwarding interest without requiring a connector restart.

A response whose frame would exceed the agent bound is sent as ordered chunks the client reassembles, never truncated. A live event frame that cannot fit the bound closes the connection with `1009` so clients reconcile through the snapshot instead of silently losing an update.

The relay exposes no filesystem read and no caller-selected path. Captured shell output is reachable only through the paged `session.shell.output` operation, whose input is `{ shellID, cursor?, limit? }` and whose result is `{ data: Shell.Output }` with `{ output, cursor, size, truncated }`. `limit` is a positive integer defaulting to and capped at 65 536 bytes, `cursor` is a non-negative integer, and one request returns one page. The shell's recorded `metadata.sessionID` must match the addressed Session, re-verified at its backend Location on every request; another Session's shell, an ownerless shell, and an unknown shell are refused before any output byte is read.

The remote Activity feed lists recorded file changes with their path and addition/deletion counts. `View diff` expands the latest recorded patch for that path as scrollable text within the Activity row; it does not read the current filesystem or execute patch content. The selected Session's file-change ledger is refreshed on selection and reconnect.

Live frames are the local Protocol payloads. Durable events carry their aggregate sequence and the server process `sourceEpoch`. Streaming deltas (`session.text.delta`, `session.reasoning.delta`, `session.tool.input.delta`) are ephemeral: they are live-only and carry no durable sequence, while `session.text.ended`, `session.reasoning.ended`, and `session.tool.input.ended` are the replayable full-value boundaries. `session.snapshot` returns the projected messages, the Session, the process epoch, and the durable watermark in one response, so a reconnecting client can reconcile with a single read and discard replayed durable events at or below that watermark. `session.log` is the incremental read that continues after an exclusive aggregate sequence and emits one `log.synced` marker at its captured watermark.

### Steps and provider attempts

Native HTTP/SSE framing ignores `retry:` reconnect hints without closing or replaying the active response. It preserves subsequent content, completion, usage, and read errors across byte boundaries and mixed LF/CRLF line endings. Empty SSE data and `[DONE]` markers are not provider completion; a stream that never supplies the protocol's terminal settlement still fails rather than synthesizing success.

One step is one logical LLM request. Retryable pre-output failures reuse the same logical request ID; each transport start increments its physical-attempt count. A tool-result continuation is a new logical request. One pre-output provider context overflow may invoke the mandatory gate, rebase, and retry the same Step once; a second overflow or an overflow after durable assistant output completes the Step as an error.

Every started logical Step closes with exactly one durable terminal event. A provider stream that omits required step settlement fails a started assistant as `provider.invalid-output`; a non-LLM stream failure also closes a started assistant with its normalized Session error before the original cause propagates. A valid settled terminal response containing no non-whitespace assistant text and no local-tool continuation receives one bounded text-only recovery Step. Recovery disables tools, appends no new max-step or reset observation and no synthetic recovery prompt, disables stored Responses continuation, and fails rather than creating a third provider request when it is silent, tool-only, malformed, or provider-failed. Previously delivered durable max-step history remains in chronological request history; the recovery request does not physically retry provider failures.

Retryable pre-output transport, rate-limit, and provider-internal failures reuse one logical request and retry up to ten total physical attempts. Empty text or reasoning starts and empty deltas are not observable provider output, so they do not prevent that retry; non-whitespace text or reasoning and any tool evidence establish the no-replay boundary. HTTP response-body read failures, including Anthropic AI SDK socket disconnects, retain transport classification and use this schedule when they occur before observable output; abnormal WebSocket close code 1006 is also a transport failure. A WebSocket lifecycle heartbeat delayed beyond 50 seconds fails the active transport and evicts that connection, so a retry opens a fresh WebSocket connection; fixed Codex WebSocket routes do not fall back to HTTP/SSE. Native response-stream failures are reduced to a bounded category before entering logs, durable Session errors, or the transcript; raw runtime errors, request URLs, stacks, headers, and bodies are not retained. Every configured `LLMClient` HTTP call, including Session, title, compaction, goal, generation, and image helpers, scopes each HTTP physical attempt through Fetch `keepalive: false` and a final `Connection: close` override. Each such attempt therefore establishes an isolated connection; fixed WebSocket routes retain their existing behavior, and no route falls back to another transport. A pre-output body-read failure still follows the bounded physical retry schedule with the same logical request identity. After observable output or tool evidence, the failed physical request is never replayed: the Step and unfinished tools close durably, then the safe boundary promotes a pending steer if present or starts one new logical transport-recovery Step. That recovery reloads durable full history, obeys the selected agent's current Step allowance and tool rules, adds no synthetic user prompt, disables stored Responses continuation, and records a new full logical provider request. If it repeats the same post-output read failure without pending input, `provider.transport` propagates without a third automatic Step. A steer admitted while recovery is running instead creates a new-input boundary after that recovery Step fails: it is promoted once, runs in normal mode, and rearms normal recovery rules. A successful recovery likewise clears recovery mode, so a later normal Step in the same drain may independently recover from a distinct read failure. Provider-status failures, provider-error events, non-read transport failures, interruptions, and non-Codex routes do not enter logical transport recovery. Exponential delays start at two seconds and cap at 120 seconds; a provider `retry-after` is a minimum delay only when it is within that same ceiling. Authentication and existing ineligible failure classes do not retry. Status-less provider messages with a recognized code prefix, including OpenAI `server_error:`, retain their provider-internal classification and use this bounded schedule instead of immediately ending the Session response.

The durable provider-request ledger stores identifiers, model and route identity, stable prompt/cache digests, attempt counts, normalized tokens, cost, continuation mode, and invalidation reason. It does not store prompt, message, tool-result, or response text.

Settled-silence recovery uses one additional logical `step` request recorded as a full request, not as a physical retry or continuation fallback. Its tools-disabled text-only mode remains distinct from Codex transport recovery, which follows normal Step allowance and tool rules and is bounded by next-Step recovery mode rather than one allowance for the whole drain. The settled-silence tool-prefix change may produce the existing cache-invalidation vocabulary.

Before each physical Session-step attempt, the runner derives the exact previously unread promoted user-message IDs that remain in the final model-visible request after history selection, compaction, continuation slicing, and `session:context` hook shaping. It invokes `llm.stream(request)` eagerly once, but records the public durable `session.input.consumed` fact only after the first provider stream event confirms dispatch and before projecting that event; a transport failure before any stream event creates no receipt. The projected user message stores only its first consumption time, so retries do not repeat the fact, and helper-model requests do not create user-message receipts.

The runner records the active context revision used to prepare each candidate and samples it again immediately before provider-request ownership. If compaction activated between those boundaries, the runner discards the stale candidate and prepares again. The stale candidate creates no provider-request ledger row and increments no physical-attempt count.

The runtime reloads projected history before durable continuation. It does not delegate Session orchestration to a legacy in-memory prompt loop.

### Helper model traffic

Session titles are local by default; explicit goal calculation uses a model:

- local title generation selects one sanitized line from the first user prompt and makes no provider request;
- `/goal <text>` calculates an objective through the hidden goal agent and its configured system pre-prompt;
- `efficiency.title: "model"` enables model-generated titles; goal calculation has no local-only mode;
- `title: "off"` keeps the initial generated Session title;
- selective-compaction selectors and manifest structure are trusted Core output. The optional helper emits only strict checkpoint TOON content; timeout or provider failure stops later helper calls, while empty, malformed, or oversized output is also replaced by a local canonical checkpoint;
- Soft context pressure is runtime-owned. The context hook durably admits compaction through the latest complete-message boundary and starts or joins exactly one process-global worker without asking the model to call a tool. Request preparation continues after admission and worker start rather than waiting for settlement; the explicit manual endpoint and mandatory hard-limit gate wait for durable settlement. All three paths share one per-Session admission gate, so exactly one compaction is admitted for a Session at a time.

Model-based titles and goals resolve the hidden agent's explicit model first, then the matching `efficiency.helper_models.title` or `.goal` selection. Before creating a compaction helper child, the owner Session resolves `efficiency.helper_models.compaction.main` for a main chat or `.subagent` for a child Session. An explicit configured value wins over an agent-pinned model; a missing value or `session` retains agent-model then owner-Session-model precedence. Each job then reuses a deterministic taskless child Session with the selected model and the hidden built-in `compaction` agent. That agent remains `mode: primary`; the child is internal provider identity, not a managed subagent task. Its provider requests and usage ledger remain isolated from the owner Session.

Every compaction-helper request places the invariant checkpoint template in stable system content under the isolated `compaction` cache namespace. The previous checkpoint and changing conversation material remain user-side. Context revision and ordinary history tail are not owner namespace inputs, so changing either alone does not rotate the owner key, system digest, or tool digest. Provider, model, variant, policy revision, permissions, system bytes, and tool bytes still legitimately rotate that namespace. A newly activated checkpoint changes the ordinary request's visible tail while the local key and system/tool digests remain unchanged; the next owner row is labeled `compaction-reset`, while provider cache reads remain provider-controlled. Later requests can extend and reuse the deterministic checkpoint prefix when its preceding bytes remain identical. If provider-reported cache reads stay fixed while the post-compaction input grows, the displayed hit ratio falls without another local key or system/tool digest change.

Each job captures its requested boundary, base context revision, target input budget, configuration digest, and trigger. The digest covers both the normalized compaction policy and an internal algorithm revision; the revision is not user configuration. Manual, advisory, and mandatory admissions use this shared digest, so a changed policy or algorithm is eligible while an unchanged pair deduplicates. Legacy policy-only digests remain distinct and cannot suppress the first job admitted by a repaired algorithm. The process-global executor claims the durable job, runs manifest generation and activation in a background fiber with its own lease heartbeat, and signals all process-local waiters for that job at settlement. Same-job callers join that signal instead of starting duplicate provider work. Interrupting a parent or other waiter stops only that wait; it does not cancel the worker or settle the job as `cancelled`. Stale-work recovery remains pull-based: a later caller can claim a pending job or a running job whose 30-second lease has expired. Execution resolves the Session's current Location when it starts.

Core captures the complete boundary and protected-state snapshot, retains at most `compaction.keep_recent_messages` for advisory or manual work, and constructs the manifest without model-authored selectors. Mandatory work protects no recent tail and may summarize through the full captured boundary. Checkpoint content is generated as one strict TOON version 2 `conversation_memory` document. Its required workflow fields are `objective`, `in_progress`, `pending`, `blocked`, `decision`, and `skill`; it also carries `requirements`, `acceptance_criteria`, `current_state`, `facts`, `preferences`, `constraints`, `completed`, `unresolved`, `important_identifiers`, `continuation`, and the exact `through_sequence`. Decision rows include `text` and accepted, rejected, or superseded `status`; fact rows include `text` and confirmed, likely, or uncertain `confidence`. Core repairs generic helper output and locally replaces empty, malformed, oversized, timed-out, provider-failed, model-history-growing, or target-exceeding helper output. The job's target input budget and TOON byte bound guide checkpoint generation: the budget bounds each helper batch and the helper's own input, while the byte bound caps the encoded checkpoint. Activation requires an otherwise valid checkpoint that reduces measured model-visible input below the pre-compaction total, preserves the protected state and captured boundary, and repairs or replaces a candidate that does not. This is lossy semantic compression: arbitrary covered bytes are not guaranteed to survive or be copied verbatim. Protected live state remains exact; activation rejects stale revisions, protected-tail overlap, and invariant corruption. `invalid_manifest` and `migration_failed` remain diagnostic corruption failures rather than helper-output or capacity outcomes.

Compaction captures its final protected-state snapshot after helper generation and refreshes the checkpoint's exact live-state text from that snapshot. A refreshed authoritative snapshot supersedes prior retained snapshots across all checkpoint scalar and collection fields before local continuity merge and duplicate detection, preserving unrelated ordinary continuity text. Background task progress and other live-state updates during helper work do not restart the helper. Activation still recaptures protected state inside the commit transaction and rejects any intervening change, stale context revision, or changed source boundary.

Before a model request, the context hook estimates current system instructions, tool definitions, and model-visible messages against the raw model context window. Advisory thresholds default to 70% (`consider`) and 90% (`advised`) of `context`, accept ordered percentages from 1 through 99, and can be disabled with `compaction.advisory: false`. The hard input cap is `context - compaction.context_safety_margin_tokens`. Structured media payload bytes, including images attached directly or returned by local tools, are omitted from the text-token estimate while their model-visible metadata remains represented. Soft pressure adds no model-visible advisory and exposes no compaction tool-call route, so it does not change the stable system, tool, or message prefix.

The automatic scheduler admits at most once when a Session first rises from `normal` to `consider`, and at most once more when it rises from `consider` to `advised`. It ignores the hidden `compaction` helper agent so helper summary batches cannot recursively schedule compaction. A successful or deduplicated admission latches that level; an admission failure is swallowed and unlatches it so a later context pass can retry. Returning to `normal` rearms the cycle. `mandatory` records the high-water level but never starts soft work, preventing a hard-gate result that remains above `consider` from immediately looping back into advisory compaction. Manual admission uses `POST /api/session/:sessionID/compact`, accepts an optional `cmp_` idempotency ID, intentionally retries deterministic failures, waits for activation or terminal settlement, and returns the settled `SessionCompaction.Result`: `{ id, sessionID, trigger, status: "ended" | "failed", requestedThrough, timeCreated, failure?: <FailureCode> }`. Automatic, manual, and mandatory admissions execute inside the same per-Session admission gate. Automatic and mandatory admitted events capture the estimator's current input count plus the safe input cap as optional pressure diagnostics; manual jobs omit pressure because they are threshold-independent. The projected job-keyed lifecycle retains that admission pressure through running and terminal state. Jobs publish version-2 admitted, started, ended, or failed lifecycle events keyed by `jobID`; failed jobs other than neutral `cancelled` or `superseded` outcomes remain queryable diagnostics but do not render as transcript chat rows.

Activation stores a content-addressed manifest, appends one immutable context revision, replaces only the active exclusion projection, rebases opaque provider state, and invalidates stored Responses continuation. A non-empty valid summary counts as retained model context and may cover the manifest's full boundary when no protected recent tail overlaps it. Model-history reads prepend one stable, non-persisted synthetic `<conversation-checkpoint>` derived from the active manifest digest and activation time, then retain only later selected entries. Covered source messages are never modified. The current compaction lifecycle is projected as one durable message keyed by `jobID`, created at admission and updated in place through completion or failure, so Protocol and TUI transcript reads can rehydrate its boundary after process restart.

The Step runner estimates the safe input budget `context - compaction.context_safety_margin_tokens` before an ordinary provider request. It trips the mandatory gate when the local chars/4 estimate, the last provider-reported input-side total (uncached input + cache read + cache write from the latest assistant step), or the last provider-reported full total (input + output + reasoning + cache read + cache write from the latest assistant step) reaches that budget, then starts or joins a mandatory compaction job and reloads after settlement. Missing model limits, unavailable boundaries, unchanged compaction failures, and insufficient reduction never block the provider request; the gate performs at most two owned admissions before proceeding with its latest rebuilt request.

Provider-assisted checkpoint generation has one total `compaction.timeout_seconds` budget across all internal helper calls, defaulting to 60 seconds; `0` disables the budget. Expiry or provider failure stops later helper calls and completes through the deterministic local checkpoint path rather than failing the job for the helper outcome. The automatic soft-pressure path does not wait for settlement; explicit manual callers and the mandatory gate do wait, and interruption of either waiter does not cancel the worker. The runner reloads after settlement but may send the rebuilt request above the advisory budget. `compaction.advisory: false` disables only automatic soft-pressure admission, not this gate.

Historical destructive summary replacement is decode-only and migration-only: valid historical replacement events may establish a revision-zero baseline and historical markers may render. Selective compaction never creates replacement events or deletes canonical history; no runtime source or tool creates destructive summary replacement.

### Session-owned terminals

The Session command palette opens a terminal picker restricted to the active Session's PTYs. Deliberate selection opens the native embedded terminal inspector without interrupting Session execution. Inspection is read-only until explicit user control acquisition; generation and writer fences prevent concurrent or stale writers. Returning control pauses input, and resuming agent control is a separate action. Closing the view detaches without terminating the PTY.

The inspector retains its emulator across contiguous output reconnects. Input stays disabled until the control connection is open and its captured replay has been applied. Output gaps or generation mismatches disable input rather than claiming a restored screen. Fit-to-pane resize is explicit and available only during synchronized user control. Service shutdown emits an end frame and closes attached WebSockets with code 1012. See the [Session-owned PTY contract](../specs/v2/pty.md) for resource bounds and platform limitations; this is not native Warp/iTerm automation or desktop isolation.

### Selected-tab Chrome bridge

An optional unpacked Manifest V3 extension can attach Chrome DevTools only to a tab the user explicitly shares. Pairing uses a Session-scoped, two-minute, one-time secret in the first WebSocket frame and an exact matching `chrome-extension://` Origin; the WebSocket URL itself contains no credential. Core owns the bridge as a Location-scoped service and rejects cross-Session access.

The browser tool exposes status, shared-tab listing, bounded accessibility observations, generation-fenced semantic actions, pause/resume, and stop. It does not expose pairing, arbitrary JavaScript, arbitrary CDP, cookies, storage, host input, clipboard, uploads, or unrestricted URL data. Shared tabs pause while active. Pairing, sharing, observation, scroll, and capture are available; navigate/click/type fail closed before CDP action dispatch because Chrome's extension debugger transport cannot enforce the required selected-tab no-download guard. An explicit internal pre-dispatch error settles as rejected; mutation failures after dispatch without a known terminal result remain uncertain. Both retain the original call ID and prevent automatic replay. See [Chrome selected-tab bridge](./browser-extension.md) and the [V2 contract](../specs/v2/browser.md) for exact bounds.

### Session-owned isolated browser

The Session command palette exposes **Isolated browser** controls for explicit temporary headless browsing. The user starts a fresh browser with a credential-free HTTP(S) URL; opening or refreshing the dialog never starts it. There is no personal-profile attachment, persistent login, visible-browser handoff, or automatic restart. Isolated mode requires macOS arm64 with installed Google Chrome major 152 and its startup controls; other environments report it unavailable.

The `browser` tool uses explicit `mode: "isolated"` to select this already-started browser. Omitted mode continues to mean the selected-tab extension and never falls back. Isolated status and control results containing page metadata require `browser_read` before model exposure, independently of `browser_control`; semantic mutations retain their permission and `browser_mutation` guardrail checks. Normal authenticated Session-location routes and regenerated clients expose the separate `isolatedBrowser` group.

Isolated ownership is process-local and fenced by Session, instance, tab, connection, document, observation, and call identities. Chrome runs in a dedicated owned process group; shutdown escalates termination to that group so a suspended browser cannot leave renderer processes behind. Pause blocks new actions; it does not freeze website scripts or prove in-flight work stopped. The TUI states this distinction. Stop terminates owned temporary resources; recovery requires explicit fresh startup rather than action replay. A Session must stop one mode before starting the other. The [isolated-browser contract](../specs/v2/isolated-browser.md) defines restrictions and settlement semantics.

### Native computer use

Native cancellation and Session release retain the active target fence until helper settlement, invalidate the claim, and reject late successful responses from cancelled calls.

The Location-scoped `computer` service separates platform-neutral capability reporting, Session ownership, revision fencing, cancellation, permissions, and guardrails from native providers. macOS is the only platform provider. It supports exact iTerm session inspection and text submission plus exact Finder path inspection and move; unsupported platforms expose no capabilities and fail before helper invocation.

Inspect claims one explicit target for the observing Session and returns its revision. A mutation requires the same Session and revision. Session release, cancellation, a stale revision, cross-Session access, or an uncertain native result prevents mutation until a fresh inspect. iTerm text passes through shell guardrails, while Finder moves use canonical Location paths, external-directory permissions when applicable, and file-mutation guardrails.

The macOS helper does not activate or launch applications, target frontmost UI, use global input or clipboard state, reveal Finder items, capture the screen, or prompt for Automation access. Packaged executables resolve a signed sibling helper. Bun source development resolves only an explicitly built helper in Core's repository-ignored cache and never compiles it during runtime startup. See [Native computer use](./computer-use.md) for the exact capability, build, install, and validation boundaries.

### Shell resource control

Shell `timeout` is finite: omission or `0` uses 600,000 ms. A foreground command still running after 300,000 ms moves to the background without being stopped; its eventual settlement is delivered as the existing completion notification.

Shell commands may inherit `shell_memory_limit_mb` or override it with the tool's `memory_limit_mb` input. Zero means unlimited. A finite limit supplies Go and Node runtime memory hints, then monitors aggregate resident memory for the POSIX command process group. If sampled usage exceeds the limit, the existing scoped process-group kill path terminates the command once and records the distinct `memory-limit` terminal status; timeout, normal exit, interruption, and memory enforcement still compete through one first-terminal-state-wins boundary.

The model-visible built-in guidance directs agents to use finite memory limits for high-memory builds, typechecks, test suites, bundlers, and large data processing rather than ordinary commands. The POSIX monitor is sampled resource control with a 250 ms overshoot window, not hard isolation. Windows rejects finite limits until the process launcher can assign a Job Object before execution.

`GET /api/shell/:id/output` reads one page of the captured combined output at an absolute byte cursor. A page ends on a character boundary: it reads at most three bytes past the requested `limit` to complete a character that straddles the budget, so a page never splits a character the command wrote. A trailing byte sequence that is an incomplete but valid character prefix is held back while the command runs, so the page reports the completed prefix, or nothing at the returned cursor, without advancing; once the capture settles, the same bytes decode as the replacement characters standard UTF-8 decoding produces. Paging from cursor `0` to `cursor == size` therefore reproduces exactly the bytes the command wrote, for valid and malformed captures alike. A zero `limit` reads nothing and leaves the cursor unchanged, and a cursor at or past `size` clamps to `size`. Reads the service starts mid-character, for example from a cursor chosen outside the paginator, decode the orphaned bytes as replacement characters and still advance.

Current version-2 completed compaction messages carry the activated revision and boundary plus excluded-message, excluded-part, input-token, and retained-token metrics. Historical version-1 completed rows may carry optional folded-message and normalized provider-token metrics; absent historical values remain absent rather than becoming zero.

### Stable tool prefix

The provider sees one fixed `execute` tool definition. Its description explains the restricted JavaScript language and the search-first workflow, but it does not embed the current MCP or plugin tool catalog. Connecting, disconnecting, or refreshing an MCP server therefore does not change the provider-visible `execute` schema or the prompt-cache tool digest.

The live catalog remains available inside CodeMode through `search(...)` and exact runtime tool paths. Direct non-CodeMode tool definition changes still rotate the prompt-cache namespace.

MCP server instruction blocks are sorted by server ID, normalized to LF line endings, stripped of trailing whitespace, and limited to 2,048 UTF-8 bytes per server with an explicit truncation marker. These instructions can still change when server guidance changes, but their ordering and size are deterministic and bounded.

### Provider prompt caching

The cache policy revision is part of the prompt-cache namespace. The current policy uses `provider-native/v8`; the revision changes only for incompatible namespace or stable-prefix semantics. Compatible code upgrades retain the key when every namespace input remains byte-identical. Prompt-cache keys do not rotate on a timer or in response to a low provider-reported hit ratio. Provider, model, and variant namespaces remain independently reproducible, so switching away and back restores the prior key and system/tool digests when their inputs are unchanged. Restoring the complete provider-visible prefix additionally requires the selected history and any plugin-owned volatile suffix bytes to match. Compaction helper requests add an internal `compaction` namespace scope while retaining their exact system and tool digest bytes, so their provider-cache key cannot share normal Session-step state. Instruction, system, tool, provider, model, variant, permission, or policy changes legitimately change the ordinary namespace. GitHub Copilot Chat and Responses routes carry the generation-derived key so an explicit cache invalidation cannot reuse the prior provider prefix.

The namespace and durable diagnostics retain the selected catalog model identity. Provider cache capability and model-profile decisions use the executable API model ID, so an aliased catalog model receives the cache controls and limits of the provider model it invokes.

Anthropic-compatible requests start with a concrete five-minute policy, including unknown future models on direct and compatible Anthropic routes. The bounded process-local cache runtime tracks provider-reported read and write usage by stable namespace. Two reusable observations within five minutes promote later requests for an extended-TTL-capable model to one hour, and later reusable reports extend that promotion for one hour. Missing or zero telemetry does not demote an unexpired promotion. After service recreation or bounded-state eviction, the runtime folds the existing durable provider-request ledger in request order for that Session and namespace; empty restores are memoized for five minutes, and no cache-specific table or Session reconstruction dependency is added. Namespace rotation, an expired promotion, and unsupported model profiles remain at five minutes. OpenRouter cache policy is profile-gated: the native route uses top-level automatic `cache_control`, while the AI SDK route lowers bounded inline markers.

Direct OpenAI Responses requests authenticated with a public API key use GPT-5.6-and-later prompt-cache options and exact `input_text` breakpoints. YCoding keeps one combined system-text breakpoint plus the newest eligible non-volatile user and local tool-result text boundaries within OpenAI's latest-50 read-candidate window. Assistant replay always uses `output_text` and never receives a breakpoint. A marked local tool result uses an `input_text` block inside `function_call_output.output`; structured media remains in its existing provider-native blocks. Tool definitions, tool calls, provider-executed tool results, and plugin-owned volatile messages receive no generated marker. `openai_mode: "auto"` normally sends request-wide `{ mode: "implicit", ttl: "30m" }`, reserves one read candidate for OpenAI's managed implicit breakpoint, and emits at most 49 explicit candidates. When a plugin-owned volatile message trails the request, the compiled request switches to `{ mode: "explicit", ttl: "30m" }`, retains the volatile suffix without a generated marker, and emits at most 50 explicit candidates before it. `openai_mode: "explicit"` disables that managed breakpoint and emits at most 50 explicit candidates. OpenAI can write the latest three explicit candidates plus the managed breakpoint in implicit mode, or the latest four explicit candidates in explicit mode. `30m` is a minimum reuse lifetime, not a hard expiry; OpenAI may retain state longer up to its separate 24-hour maximum. Older public OpenAI models remain implicit and use opt-in `24h` retention only on supported families. The ChatGPT/Codex subscription backend has separate `openai-codex-responses` HTTP/SSE and `openai-codex-websocket-responses` WebSocket identities and is key-only for every model: YCoding emits no `prompt_cache_breakpoint`, `prompt_cache_options`, or `prompt_cache_retention`. Codex sends `session-id`, `thread-id`, and `x-client-request-id` equal to the same stable prompt-cache key and the explicit WebSocket route uses that key for process-local affinity, so equivalent Sessions with identical namespace inputs share backend affinity. Request-shape tests verify serialization only; Codex retention and cache reuse remain provider-controlled and no hit rate is guaranteed. Compatible gateways and unsupported families also omit GPT-5.6-only fields. Model-based title, goal, and compaction calls use the same policy and observation runtime as normal Session steps.

OpenAI Responses assistant `phase` metadata is preserved through durable message projection and replayed as `commentary` or `final_answer` on later requests. This applies to direct OpenAI and the ChatGPT Codex Responses route when the backend reports a phase.

The ChatGPT/Codex Responses route preserves trusted chronological `Message.system(...)` updates as native `system` input instead of lowering them into escaped user wrappers. Direct public OpenAI Responses and GitHub Copilot Responses do the same for GPT-5.6-and-later model IDs, independently of implicit or explicit prompt-cache placement; TeamView observations are available on every provider route as chronological synthetic user-authority messages. Earlier model IDs retain the escaped chronological-system fallback.

Direct GPT-5.6 Responses requests enable server-side context management with a `200000`-token compaction threshold. When OpenAI returns an encrypted compaction item on a stateless request, YCoding retains the opaque state for the same model, includes it in the next input, and omits the earlier input items from that request. Stored-response continuation remains separate and still requires explicit provider storage.

OpenAI-hosted web search URL citations enter the normal assistant text lifecycle as a `Source: <title>` line followed by the URL. The same text is returned by the native AI call, stored in durable Session history, and rendered by the TUI transcript.

### Prompt delivery

- **Steer** inputs promote at the next safe step boundary and require the active drain to continue.
- **Queue** inputs remain pending until the session would otherwise become idle.
- The TUI model and variant pickers record a Session-local desired selection without switching the runtime or interrupting active work. Rapid choices replace that target; navigating to another Session does not carry it over. Ordinary prompt submission applies a changed selection before admitting the prompt, then wakes the Session. A rejected or over-budget switch retains the draft, attachments, and desired selection without admission or wake. Successful submission clears only the matching target, preserving a newer choice made during submission. `/goal` does not consume the desired selection.
- **Send and steer now** (`<leader>d`, `prompt.steer`, palette) admits the prompt, interrupts the active step so the boundary is reached immediately, then wakes the Session. The admitted steer is promoted by the successor drain rather than waiting for the running step to finish on its own. An idle or locally unowned Session makes interruption a no-op.
- Promoting new user input resets the selected agent's step allowance.
- Durable pending user and synthetic inputs are projected back into the resident transcript after message eviction or child-chat navigation. Reopening a child therefore preserves an admitted steer without promoting it early.
- Outbound user bubbles render lifecycle receipts from durable state only: a clock while the admitted input remains pending, one subdued check after promotion, and two info-colored checks after a physical model request consumed that exact message. Assistant, synthetic, and system rows do not render these receipts. Historical promoted messages without a consumption event remain in the sent state; assistant activity is not treated as proof of consumption.
- Outbound user bubbles render the complete prompt at full wrapped height, including long pasted documents. Scrolling reaches the final lines, attachments, and following transcript rows; there is no generated truncation ellipsis. Canonical message actions, including copy, editor, fork, and revert, retain the same full text. Tool-output collapsing remains a separate presentation policy.

### Composer preparation and recovery

The composer displays one correlated preparation phase while reading the clipboard, creating a Session, activating skills, admitting attachments, or waking an admitted prompt. After ten seconds it also displays elapsed seconds. `Cancel pending action` and Escape cancel that local operation without interrupting Session execution; a newer draft is not cleared by an older submission's completion.

A terminal paste transfers text only, so an image on the host clipboard is never carried by the paste payload itself. The composer reads the host clipboard directly for an image-only clipboard that arrives as an empty bracketed paste, and a pasted file path that resolves to a supported attachment type becomes a real attachment instead of literal text.

Missing temporary clipboard images block the first send with re-paste/remove guidance. A second explicit Enter, or `Remove unavailable attachment and send`, removes the missing attachment and sends the retained text. Clipboard subprocesses are bounded and cancellable; temporary image files are uniquely owned and released after managed attachment receipts are retained.

Admission and wake are separate. An unresolved admission or failed wake retains the original Session, prompt, and skill identities and any managed attachment receipts for exact retry of the unchanged draft. `Retry previous submission` restores the retained input. A changed draft replaces the unresolved send: the previous draft is stashed and local recovery state is discarded, then the changed draft is admitted with fresh identities. `Discard previous submission recovery` discards local recovery state, not a durable admitted prompt. Skill activation failure prevents prompt admission and allows an intentional changed next prompt after that pre-admission attempt settles.

Definitive attachment validation rejection or prompt-ID conflict is distinguished from an uncertain admission result. Rejection retains the editable draft and attachments for correction; uncertainty retains them for an exact retry with the same prompt ID. Once admission is confirmed, the composer retains managed attachment receipts before requesting the execution wake. A wake failure therefore retries the same admitted prompt identity and managed references rather than re-admitting with new identity.

The full composer ranks matching agent and reference candidates together for `@` autocomplete; backend file-search results remain in backend ranking order and are not scored against those candidates. Mini `@` mentions likewise rank agents and references together while keeping files in their backend order. Mini model startup drops a stored session or saved variant when the resolved model offers no variants, but retains stored variants while the model catalog is unresolved. An explicit CLI variant remains selected even when the catalog has no variant data.

### Durable runtime observations

`session.context.observed.1` is an append-only durable Session event with `{ sessionID, source, text }`. `source` is one of `session-state`, `team-view`, or `step-limit`. Its projection is chronological: `session-state` and `step-limit` become trusted System messages, and `team-view` becomes a Synthetic message with user authority and the description `TeamView update`. Session-state and TeamView notices stay in the message store but never render in the transcript. This is presentation only: stored event/message text and model-facing history remain unchanged.

At serialized safe boundaries after prompt promotion and after compaction reload, the runner compares each source with its latest selected trusted observation and appends an event only when the text changes. Returning from A to B to A appends a new observation; previously stored bytes are never changed or moved. Restart does not duplicate an unchanged observation, and compaction or revert refreshes a missing selected observation. Goals and reminders fold into `session-state`, including an explicit clearing notice for ended goals; step-limit entry and exit are both observed, and step-limit tool-disable enforcement applies.

TeamView observes the current child state when available, including terminal state. Sessions that have never received a TeamView do not get an initial empty notice; when previously observed or inherited children disappear, one empty update clears the prior view. These are automatic visible runtime notices, not assistant narration: routine bookkeeping remains undescribed by assistant text unless the user asks.

Automatic TeamView observations use a model-facing projection rather than the explicit inspection response. The projection retains child and parent identity, description, agent/model, background mode, lifecycle state, progress text, and question identity/text/data. It omits task revisions and task/progress/question timestamps. Questions sort first, then other active children before terminal children, with Session ID as the stable tie-breaker. JSON object keys are canonicalized and the observation remains bounded to 32 KiB with an omitted-child count. Timestamp/revision-only changes therefore do not append another observation or reorder the selected children. Explicit TeamView inspection and subagent-control output include the complete operational metadata; task persistence and protected-state revision/digest tracking keep that metadata.

Previously delivered observations, including older full TeamView snapshots, remain byte-for-byte historical messages. A changed projection is appended at the next normal observation boundary, not rewritten into earlier history. Session-state observations continue to include full todo content/status/priority, autonomy and goal iteration/budget state, and permission ceilings; these fields are not suppressed to improve caching. Notice visibility and provider cache policy are independent of the automatic projection.

### Tool activity lifecycle

The TUI derives tool activity state and duration from each durable tool's `time.created`, `time.ran`, and `time.completed` fields. Streaming input renders as pending, active execution renders as running with a live elapsed duration, and terminal success, failure, or cancellation freezes the completed duration. Execute child calls, exploration groups, shell and direct CLI rows, and generic tools use the same status grammar; parsed command-result failures override a transport-level completed state. Expanding request or response details never removes the lifecycle status from the primary row.

### Restart safety

The TUI restores active Session status from a snapshot on connection. Execution events received while that snapshot is loading take precedence for their Sessions. A response from an earlier connection cannot replace the current connection's status.

Managed-server shutdown marks only process-local active Sessions as suspended before the owned drains stop. Managed-server startup never replays suspended provider work or resumes a Session automatically. Post-crash continuation recovery requires an explicit durable design before it may retry a provider request; retained suspension markers therefore do not themselves admit or execute work.

## Autonomy

Session autonomy is durable and supports:

| Mode     | Behavior                                                    |
| -------- | ----------------------------------------------------------- |
| `normal` | Standard interactive execution.                             |
| `yolo`   | Autonomous execution under the effective permission policy. |
| `goal`   | Repeated continuation toward a durable goal.                |

`yolo` (levels `1-3`) and active `goal` mode also govern managed descendants. Level `1` auto-answers questions and deterministic forms, level `2` also auto-approves `ask` permission decisions (`true` maps to `2`), and level `3` also auto-approves guardrail reviews. A child Session automatically inherits the maximum effective `yolo` level from its ancestor chain; `goal` active also auto-answers questions/forms and permissions even at `yolo 0`, but guardrail reviews require explicit `yolo 3`. Explicit permission denies remain denies. Auto-handled requests do not enter the pending request collections, so the TUI does not emit their approval or question notification sound.

The expanded AUTONOMY sidebar renders Guardrails as `auto · YOLO 3` only when the effective YOLO level is 3. Normal, YOLO 0-2, and active goal below YOLO 3 render Guardrails as `enforced`. This automatic handling applies only to ordinary reviews. Hard reviews always require a fresh human `once` or `reject` decision; the sidebar separately labels them `human only`.

Goal state stores the goal text, status, automatic continuation iteration, consumed no-progress attempt count, and maximum no-progress attempt count. Historical stored progress digests remain decodable but do not decide current progress.

The user owns the objective. `/goal <text>` explicitly creates or replaces it, even while a goal is active. Tracked pasted text is expanded before calculation. Ordinary prompts, exact retries, synthetic continuations, and agent goal-tool calls do not replace the objective or reset its no-progress budget. The agent retains inspection, reporting, completion, and stop actions, but cannot supply replacement text or activate a stopped goal.

Bare `/goal` and the goal toggle stop an active goal, resume a retained goal verbatim without recalculation, or request explicit objective text when none exists. Resume preserves the retained iteration and no-progress counters. A newly calculated replacement starts its own counters. Failed calculation preserves the prior goal and draft; it never silently activates raw text. A durable autonomy revision fences settlement so a stop or another autonomy change cannot be undone by a late result. Stop intent advances that fence even if no goal has yet been stored. Successful creation or resume admits a synthetic goal continuation rather than an ordinary user prompt.

Goal activation, resume, and automatic continuation use the hidden goal agent to generate a concise user-proxy steer from the active objective, recent Session history, and latest assistant response. Routine questions receive a context-aware direction using the safest reasonable default. Generated text retains synthetic autonomy provenance and does not grant human approval or bypass permission ceilings or guardrails. Helper failure or interruption admits no generic fallback; a stale autonomy revision cannot activate or advance the goal. Successful continuation advances the iteration only after steer generation.

Terminal goal states are:

- `completed` — the agent explicitly called the goal tool's `complete` action after verification;
- `stopped` — the user or runtime left goal mode;
- `exhausted` — explicit agent `report` actions consumed the configured no-progress attempt budget.

The agent does not report ordinary progress. It calls goal `report` only after encountering a blocker, attempting reasonable self-resolution, and remaining unable to progress. Every accepted report consumes one no-progress attempt; the configured bound exhausts the goal, and later progress does not reset the consumed budget. A successful settled drain with an active goal advances the durable iteration and admits the next continuation without requiring a report. Assistant text, empty assistant output, completion markers, and terminal execution do not infer no progress or complete a goal.

An active direct durable child task or running background shell blocks automatic goal continuation. Such work is unfinished rather than automatic no progress; its existing terminal notification wakes the parent so goal work can resume without consuming a no-progress attempt. This prevents a parent goal from spinning while background work remains active. The TUI refreshes autonomy when session execution reaches a terminal event so displayed progress is current. Its top-right session status combines active YOLO or goal mode with the operational state; while retrying, it shows a failure marker, completed failure count, next retry number, and seconds until that retry. While main-session working is active, its decorative dot trail advances every 160 ms and uses the same semantic color as the adjacent status label.

## Session guardrails

Guardrails are a root-Session-family safety boundary independent of agent permissions and autonomy mode.

Current behavior:

- recognized catastrophic shell commands, including recursive deletion of a filesystem root or the home directory, are denied before process creation;
- standard catastrophic denies and built-in broad-deletion hard reviews are unoverrideable; otherwise the first matching custom source layer decides before ordinary standard review or allow behavior;
- ordinary guardrail reviews remain reviews in `normal`, `yolo 1-2`, and `goal` modes; only `yolo 3` auto-approves ordinary reviews;
- hard reviews require a fresh human one-time approval or rejection, even with YOLO 3, active goal, disabled optional guardrails, custom allow rules or an earlier reusable approval; `always` cannot settle a hard review;
- direct Session shell, tool shell, edit, write, patch, subagent launch, mutation-capable MCP tools, and project-artifact mutation use the same service boundary;
- running shell, running subagent, and pending review caps are shared by the root Session family and release on settlement or interruption;
- custom files are direct `guardrails/*.md` children of the global config directory and every discovered repository `Config.Directory`; nearer repository directories precede broader repositories, which precede the global directory;
- within one custom source layer, matching rules sort by descending numeric priority and then deterministic lexical file-path/rule-ID order; enabled invalid configuration fails mutation actions closed with review while retaining its source-layer position;
- replies are `once`, `always`, or `reject`; `always` is process-memory reuse for the root Session family and exact action, ordered rule IDs, ordered resources, and request metadata only after a fresh evaluation still asks;
- pending reviews rehydrate through the canonical Session guardrail API and live events, including reviews initiated by child Sessions.

A pending review blocks the whole root Session family, so its review row and prompt render in every Session view that can be blocked by it, including a subagent chat. The transcript row renders whenever a review exists; the request list only contains reviews still awaiting a reply, so the row disappears on reply.

`once` is not reusable. A deny or a changed evaluation cannot reuse an `always` approval. The approval set is Location-service/process-memory only, is cleared with the service, and is never durable or global. Descendants share the root-family key.

After a pending-review checkpoint of 500 ms, the TUI emits a root-owned notification titled with the root-family Session ownership and the message **Guardrail approval needed**. The root system notification is blurred-only, uses the `permission` sound, and is suppressed when the review resolves before the checkpoint. Permission approval does not bypass guardrails, and guardrail approval does not widen an agent permission denial.

The built-in TUI attention lifecycle keeps routine child completion and settlement while a goal remains active silent. Pending human-input requests still alert once per unresolved request. Top-level completion and exhausted-goal alerts are coalesced across successor executions; a retained terminal goal from earlier work does not determine the alert for a later ordinary execution. Global MCP forms are local-only: the TUI may use desktop and sound attention, while Core's remote ntfy lifecycle does not post them or grant additional authority.

Core runs the remote ntfy lifecycle through one process-global observer. For each Session event it resolves the owning Location, then reads that Location's ntfy configuration, effective permission, and HTTP delivery service. The observer waits 500 ms before eligible delivery and requires an already-effective `allow`; it does not prompt for `ask`. A completed explicit ntfy tool call after an execution starts suppresses that execution's automatic successful-terminal post only. It does not suppress other attention categories or define general notification deduplication.

Eligible automatic ntfy messages use transient generation from the current Session context and latest assistant response. Output is bounded to 200 characters, stripped of terminal controls, and sanitized for recognizable secrets, paths, URLs, contact details, and identifiers. Empty output and explicit claims of human approval are rejected. Generation failure skips delivery without a static fallback. Configuration, permission, and attention-episode liveness are checked again before posting; a resolved request or successor execution suppresses a stale generated message.

Permission and guardrail choices keep their labels on fixed terminal rows during keyboard navigation and mouse hover. Selection changes the highlight without moving labels or surrounding content; approval and rejection semantics are unchanged.

A Session view surfaces the pending permission and form prompts of its own Session and that Session's descendants. A root view therefore covers the whole family, while a subagent chat still shows prompts raised by the subagent and its own children instead of blocking invisibly behind them.

Operator configuration is documented in [`guardrails-and-provider-usage.md`](./guardrails-and-provider-usage.md).

## Subagents

Subagents are durable child sessions.

### Built-in agents

Every Location activates the maintained built-in catalog. The default selectable primary agent is `god`; omitting a configured primary selection resolves `god`. The selectable primary built-ins are `GSD`, `architech`, `god`, and `yangi`. The maintained task subagents are `occam`, `omoikane`, `wittgenstein`, and `zeus`.

`god`, `architech`, `GSD`, and `yangi` use the `build` permission defaults. `occam`, `omoikane`, `wittgenstein`, and `zeus` use the `general` subagent permission defaults. All eight agents explicitly allow `shell:*`; these profiles do not change the read-only `btw` advisor or the hidden `compaction`, `title`, `goal`, and `summary` utility agents.

`GSD` (Get shit done) has an orchestration-only prompt contract. It owns scoping, dependency decisions, worker assignments, evidence review, and acceptance; it delegates implementation, file changes, experiments, integration edits, and build/test execution. Ready independent tasks run in parallel within configured resource limits and a maximum of five direct workers. Each mutable resource has one writer; real dependencies and approvals remain gates. Workers must use repository standards, TDD for executable behavior, and the smallest complete solution. Completion requires verified evidence and affected checks, not worker status alone. This role is expressed through its instructions, not a separate tool-permission sandbox.

Maintained built-in agents share bounded repository-search guidance: constrain searches by scope and output, reuse settled results, pivot a broad search that returns nothing toward a likely file, symbol, caller, or directory, and repeat reads only when inputs or evidence change. GSD catalog metadata declares request temperature `0.3` and orange color (`#e67e22`). Session model requests do not apply the agent's request-body temperature; generation options come from resolved route/model defaults and model-request options.

`btw` remains a visible read-only advisor. The hidden `compaction`, `title`, `goal`, and `summary` agents remain internal helpers. `build`, `plan`, `explore`, and `general` are not built-ins, and the disabled source definitions `analyze` and `brainstorm` are not registered.

### BTW side chats

Opening a BTW Session copies a recent parent-history snapshot directly; it does not call the parent's generation API to summarize that history.

The main Session's team composer includes a separate **Side chats** tab. It lists direct BTW conversations independently of managed subagents: Enter or a click reopens a conversation, and **New side chat** or `n` creates one. These entries do not contribute to delegated-task counts or cancellation actions. `/btw` also opens a side chat through the model picker.

A BTW Session uses the shared typed transcript and read-only `btw` agent profile with its own side-conversation layout. It names the source of its parent-context snapshot, exposes one ordinary composer, and shows its own context usage without delegated-task counts, sibling navigation, or subagent economics. The visible **Back to main** action and `<leader>up` return to the immediate parent even while the composer is focused; navigation preserves the unsent draft and sends no prompt. Ordinary managed subagent Sessions remain read-only except for their existing blocked-question answer surface.

`Send to main chat` and `/btw-send` open the same editable text preview. The preview names the actual immediate parent and BTW source Session. Cancel leaves the original BTW composer draft unchanged, and whitespace-only previews do not send. Confirmation admits the preview text exactly once to that captured parent with `steer` delivery and a retained Protocol message ID; an ambiguous or failed retry reuses that ID and immutable text rather than replaying under a new ID. Export performs no model summarization, does not interrupt the parent, does not copy hidden transcript content, and stays in BTW unless the user separately chooses parent navigation.

Current behavior:

- The `subagent` tool always launches work in the background.
- The model-facing tool contract requires the caller to choose a model variant proportional to task difficulty and reserve stronger variants for tasks that need them; the runtime validates the supplied canonical provider, model, and variant rather than inventing a difficulty classifier.
- The tool returns the child Session ID immediately.
- The child runs a configured non-primary agent with fresh context.
- The parent receives lifecycle state and completion or failure notification.
- Once a parent has no local runnable work, it completes its own response and is free even while child Sessions continue in the background.
- Completion notifications are delivered automatically; parent guidance prohibits polling and sleep or no-op waiting, and directs the model to continue useful work or finish its response until notification arrives.
- TeamView is a durable chronological `team-view` observation whenever its selected child-state text changes. It is available on every provider route, including Codex, as a Synthetic user-authority message with description `TeamView update`; final terminal state remains stored. An empty update clears a previously observed or inherited view when no children remain, but Sessions with no prior view receive no initial empty observation.
- TeamView and other automatic runtime observations stay in the message store but never render in the transcript; they are not assistant narration. The parent does not add routine assistant status text for launch, running, completion, or other bookkeeping unless the user asks.
- A child failure may still be reported when it blocks the requested outcome, but not as routine orchestration bookkeeping.
- Running children receive a status, blocker, and ETA request every ten minutes.
- An optional child `timeout` accepts at most 86,400,000 ms and defaults to 3,600,000 ms when omitted. On expiry, the runtime interrupts the child, settles its durable task as failed, and delivers the existing parent failure notification.
- A child question reported through orchestration receives the safe default answer immediately when its managed Session family is in `yolo` or active `goal` mode. The task remains running, and no parent-question notification or sound is emitted.
- The effective permission policy limits which subagents are available.
- Configured and managed subagents materialize the Location's registered tool catalog through their ordered permission rules and inherited parent ceiling. Empty managed-agent rules resolve to safe defaults with shell requiring approval; final `subagent` and `subagent_control` denies prevent nested orchestration.
- Nested subagents are bounded by `experimental.subagent_depth`; the default depth is one.
- Session restart and TUI rehydration use durable orchestration state rather than requiring the user to open every child chat.

The public managed-subagent list returns one page of at most 10 direct durable task records plus exact family-wide `total`, `active`, `running`, and `waiting` counts. `active` includes `waiting`, `starting`, `running`, and `cancelling`. Rows sort by `waiting`, `starting`, `running`, `cancelling`, then the terminal group, with each group ordered by durable update time descending and Session ID ascending; opaque previous and next cursors preserve that order in either direction.

The TUI keeps one such page resident per parent and replaces it rather than appending when the user moves older or newer. The header, rail, and composer use the exact summary independently from the resident row count. Reconnect refreshes every resident parent ledger even when no Session is executing, preserving active waiting tasks and rejecting pre-disconnect responses. Sibling navigation loads adjacent pages only when crossing a page boundary or locating a child absent from the current page; paging never deletes or truncates durable child Session, task, message, ownership, permission, nesting, or background-execution state.

Subagents do not synchronously return their final result to the initiating tool call. Parent notification and child-session inspection are the completion paths.

## Skills

Skills can activate through an explicit reference or the `skill` tool.

MCP servers that declare the Resources capability and `io.modelcontextprotocol/skills` contribute metadata-only skill entries to the available-skill catalog. Catalog discovery never retrieves skill content. Loading an MCP skill first obtains its current fixed entry, requires approval bound to that entry's complete digest manifest, and only then retrieves and verifies `SKILL.md`. The durable completed tool message retains the verified entry for activation; it is the authority for later supporting-resource reads, not a second mutable registry. A resource read requires that active MCP skill and its held manifest, repeats the content-bound permission check, and verifies the returned resource before rendering it. Dynamic manifests cannot load.

Session skill status derives from the durable transcript and instruction state:

- an activated skill is `active`;
- an agent switch marks prior active skills inactive with `agent_switched`;
- completed compaction marks prior active skills inactive with `compacted`;
- resolving an active skill-to-skill conflict marks only the chosen loser inactive with `conflict_resolved`;
- conflicts are computed between active skills and against declared instruction keys;
- already-active tool loads are not duplicated as new active entries.

`SessionV2.resolveSkillConflict({ sessionID, winner, loser })` verifies the current derived conflict and records `session.skill.deactivated.1`. Its projection annotates the losing skill's existing activation message, so status remains derived from durable messages and current instruction keys. A missing or inactive pair, or a pair without a current skill conflict, fails without changing Session history. Resolution does not resume model execution or change the remaining skill's instruction snapshot.

Clients invoke the durable operation with `POST /api/session/:sessionID/skill/resolve` and JSON payload `{ winner, loser }`. Success returns no content. A missing active conflict returns the stable public `SkillConflictNotFoundError` response without exposing the internal Core error or either skill identifier.

The TUI provides a session-skills dialog, expandable skill content, conflict details, and transcript rows for loaded skills. A completed skill's `Loaded` badge uses the skill accent color; inactive or unavailable state remains visually subdued.

## Instructions

Instruction state is Session-owned.

- Built-ins live in `packages/core/src/instructions`.
- Discovery observes ambient global and upward-project instruction sources.
- Guidance and persisted instruction entries are composed explicitly by the session runner.
- `session.instructions.updated` stores changed source keys and content hashes.
- Instruction blob content is stored once; instruction state is a rebuildable fold cache.
- Initial complete instruction loading blocks on unavailable required sources; later unavailable sources retain their previous value.
- Completed compaction advances the instruction epoch.
- Session movement and committed revert clear the instruction epoch.

There is no global instruction registry that owns Session history.

## Project artifacts

Project artifacts are the managed customization system for skills, commands, agents, and plugin drafts.

### Kinds

- `skill`
- `command`
- `agent`
- `plugin`

Agent artifacts currently define subagents. Command artifacts are non-subtask commands. Plugin artifacts store validated drafts rather than arbitrary executable mutation.

### Scopes

- **Project** — bound to one project scope.
- **Global** — shared through the global artifact scope.

Project artifacts can shadow global artifacts through the explicit lifecycle rather than file-order accidents.

### Lifecycle

Artifact stages are:

- `trial`
- `active`
- `degraded`
- `disabled`
- `quarantine`

Versions preserve content digests, provenance, parent versions, state transitions, and fallback identity. Manual destructive or cross-scope operations use preview/confirmation tokens. Trash, restore, revert, promotion, disable, shadow, and fork operations are explicit store operations.

Automatic creation is governed by per-kind and accounting caps. Plugin automatic creation is currently disabled by a zero automatic cap.

Artifact learning is non-punitive: after the primary task is complete and validated, an artifact may capture a safer reusable rule from a validated repeated mistake, failed approach, or repository gotcha. One-off failures and transient task state are not artifact material.

### Integration

Adapters expose active artifacts to the existing agent, command, skill, and plugin discovery paths. The TUI exposes a project-artifact dialog and project-artifact tools use the validated store instead of writing directly to source directories.

Unmanaged resource names outside the managed-artifact ID grammar, including namespaced MCP commands, remain available through their owning registries and do not participate in managed-artifact collision lookup. Managed skill-tool and subagent-launch activations use the matching durable tool-call event's sequence and timestamp; command activations use the durable input-admission event. Distinct invocations have distinct activation identities, while exact retries retain the same identity and timestamp even after input promotion. Agent-selection activations use the sequence supplied by their event commit transaction.

## Transcript history

The canonical transcript projection remains complete and durable. The TUI keeps a bounded resident projection and releases covered resident rows after completed selective compaction without changing canonical history.

The SQLite `session_file_change` ledger is a rebuildable projection. Its dedicated housekeeping service runs at startup and hourly, deleting ledger rows only when `session.time_updated < now - 30 days`, except for executor-active Sessions. Durable events and message/transcript projections are never deleted; replaying retained `session.file-change.recorded` facts rebuilds a removed ledger row deterministically.

### Resident transcript

Opening or refreshing a Session fetches its complete current projected transcript in one canonical ascending-order request. A resident message changed by live admission or promotion remains protected until a canonical response contains that message, so a stale list response cannot make a newly admitted or just-promoted user row disappear. The TUI hydrates completed compaction lifecycles from their durable projected messages and applies boundary pruning in one reactive publication, so covered rows never become resident between fetch and pruning, including after a TUI or server restart. It releases resident message rows through each completed compaction boundary; a later completed boundary advances the release point. This affects only resident memory and rendering: durable history and the canonical fetch remain complete, and reconnect or navigation reapplies the same boundary pruning. The transcript renders only the latest visible compaction lifecycle or historical marker. A completed latest lifecycle renders a compact metrics panel with cumulative tokens saved plus that compression's removed-token, reduction, item-count, and timestamp values; durable summary prose is not rendered as transcript chat content. Historical summary messages decode as markers, and migration can derive an initial context baseline from valid replacement state; selective compaction never authors destructive summary replacement.

### Rendering guarantees

Transcript rows are reduced from resident messages. A row whose backing message or assistant part has been evicted is not mounted, so it consumes no blank terminal block during navigation, resume, or reconnect.

Tool and subagent activity rows update elapsed time only while their underlying lifecycle is active. Their timers stop when a tool or child task reaches a terminal state, preserving the terminal duration without a continuing redraw.

The transcript bottom-follows a completed compaction metrics row at the chronological tail exactly like any other new chat row. The latest job-keyed compaction lifecycle row occupies its canonical compaction-message position as soon as that message is resident, including while the job is pending or running, so later user and assistant chat progresses below a background advisor compaction. A newer visible compaction replaces the previous compaction row instead of accumulating historical metrics panels. An event-only provisional lifecycle remains one tail placeholder until message hydration; hydration repositions the same keyed row without duplication, and terminal settlement updates that row in place. Main and child Session routes retain separate viewport state: returning to a Session restores its prior non-tail position and message navigation, while a Session left at the tail resumes tail following. Repeated navigation does not duplicate rows.

Restored instruction and other notice text renders as Markdown. Goal-generated synthetic input renders its full text in a labeled **Goal · steer** block rather than as an ordinary user message. Goal tool-call rows are hidden in every lifecycle state and consume no transcript lines; their durable history and execution are unchanged. Active guardrail rows follow the projected transcript, including completed compaction markers, so current activity stays at the transcript tail. Child activity renders in the sidebar and session picker instead of the parent transcript. Root Session todos render in the sidebar. Managed subagent chats hydrate and display their own current todo list at the transcript tail, update it from live todo events, and retain completed and cancelled items; only pending and in-progress items count as open.

The final change summary normally aggregates only parseable diffs captured by completed `edit` and `patch` tool parts from the parent and completed direct-child transcripts. When completed compaction leaves no completed assistant resident, the TUI instead renders a collapsed recovery summary from the durable file-change ledger beside the compaction marker. The recovery ledger is not combined with transcript changes and stops once a completed assistant is resident. Completed diffs with the same resolved path aggregate into one collapsed expandable row, preserving first-seen order and summed additions and deletions. It does not represent shell or `write`-tool mutations or every final workspace change.

Collapsed file-change headings align with their expanded diff text grid. Embedded headingless diffs omit a redundant frame, and patch rows use ASCII `+` and `-` markers for additions and removals.

Timeline selection is preserved by option value rather than list index because new messages can reorder the list.

## Provider caching and diagnostics

Caching is split into distinct concerns:

- stable model-visible prompt prefixes;
- provider-native prompt caching;
- normalized cache-usage telemetry;
- TUI diagnostics;
- project artifact reuse, which is not a provider prompt cache.

### OpenAI

For GPT-5.6 and later, direct public OpenAI Responses lowering supports `prompt_cache_options` and explicit `prompt_cache_breakpoint` fields on system, user, and local tool-result input blocks; assistant replay always remains unmarked `output_text`. Auto mode combines explicit stable-prefix markers with OpenAI's implicit latest-message marker; explicit mode disables the managed marker. Pre-5.6 public models use the compatible retention field. ChatGPT Codex requests are key-only for every model and emit no `prompt_cache_breakpoint`, `prompt_cache_options`, or `prompt_cache_retention`. Their cache, thread, and client-request identities use the stable prompt-cache key; the explicitly selected WebSocket route also uses it for process-local socket affinity. Request-shape tests do not establish live Codex reuse, which remains provider-controlled without a hit-rate guarantee. Direct OpenAI is Responses-only; OpenAI-compatible Chat remains available only for configured third-party deployments. Model family and route capability are gated independently because sending the wrong cache field can be rejected by the provider.

Direct OpenAI Responses lowers user image attachments and local tool-result images into `input_image` content. The optional `providerOptions.openai.imageDetail` selects `auto`, `low`, `high`, or `original`; omission leaves the provider default `auto`. `original` is rejected before the request for unsupported models, including GPT-5.4 mini and nano. Remote image URL and `file_id` references are not implemented.

### OpenAI Responses continuation

Stored OpenAI Responses continuation is durable Session state and is enabled only when `efficiency.openai_responses_state` is `stored`, the continuation policy is not `off`, and the effective request has `store: true`.

A stored response can be reused only when the context revision, continuation generation, connection identity, route, model, variant, prompt-cache namespace, system digest, tool digest, semantic request-options digest, and represented message boundary all match. The volatile-context digest is recorded, but its mismatch is tolerated when those stable fields and the represented boundary match. The next request sends `previous_response_id` plus only the stable message suffix after that boundary; current system instructions and tools are always sent again, while plugin-owned volatile suffix messages are omitted. Credential or connection changes alter the connection identity and prevent reuse.

ChatGPT/Codex uses HTTP/SSE route `openai-codex-responses` by default and always sends `store: false`. Explicit provider setting `transport: "websocket"` selects `openai-codex-websocket-responses`; that route never falls back to HTTP. A completed WebSocket response may anchor strict-extension follow-ups through `previous_response_id`. A failed exchange retains the last successful anchor so a normal retry repeats the same incremental request instead of silently rebasing to full history. Process restart, Session or request-identity mismatch, and explicit full replay still lack a compatible process-local anchor and therefore send canonical full history. This transport state is never written to `SessionContinuation` and provides no provider cache-hit guarantee.

GitHub Copilot Responses through the AI SDK route is explicitly stateless (`store: false`). Every follow-up sends full selected history instead of `previous_response_id` continuation or provider-stored item references. Retained encrypted reasoning items and local tool outputs are replayed directly, and the route still receives the stable `prompt_cache_key`; Copilot-specific options override generic Responses options when both are present. Copilot reasoning-summary fragments close before the next fragment starts, while the final closure retains encrypted reasoning metadata for replay.

GitHub Copilot catalog models using the Anthropic Messages AI SDK package also resolve through the configured AI SDK loader, preserving Copilot authentication and transport rather than attempting direct Anthropic API authentication. Direct Anthropic models retain their native Messages route.

Continuation state is invalidated by context-revision activation and explicit clear paths; any fingerprint mismatch also makes a stored row ineligible. Response IDs are not written to Session history, request diagnostics, or the durable provider-request ledger. If a continued request fails before observable output with an invalid-request error, the runtime clears the response state and retries the same logical request once with full history. A second failure follows the normal provider-error path.

### Anthropic and compatible routes

Anthropic cache-control placement is normalized across direct and compatible provider routes. Profiled Anthropic models on native OpenRouter use top-level automatic `cache_control` plus stable session affinity; the AI SDK OpenRouter route uses bounded inline markers. Plugin-owned volatile suffixes and context-pressure advisories do not receive cache breakpoints. Claude Code OAuth requests derive `x-claude-code-session-id` from the stable incoming `X-Session-Id`; an explicit interceptor override wins, and process-random identity is only the fallback when neither value exists. The OAuth billing system prefix samples the first durable canonical user message for that Session, so local compaction and runtime recreation do not replace its fingerprint with checkpoint text. A missing or unreadable durable Session falls back to the current visible first-user sample. Public Anthropic API-key requests do not use this Claude Code translation.

### OpenCode Zen and OpenCode Go requests

Every model request identifies the client as `ycoding/<version>`; the runtime never presents itself as another client. Requests to the `opencode` and `opencode-go` providers additionally carry `x-opencode-session` set to the Session ID, which is the stable per-conversation identifier those gateways use for routing and prompt caching and which survives compaction. Other providers receive no `x-opencode-session` header, and the value is never a credential.

OpenCode Zen's anonymous free tier is not reachable from a third-party client: the gateway rejects it for any client identity, including the official one, so the runtime does not advertise anonymous free-model access as usable. Zen and Go models require a real provider credential.

### Telemetry

The runtime preserves provider-reported cache reads, writes, creation detail, mechanisms, and model/context identity where available. Missing provider telemetry is reported as unreported rather than silently treated as zero.

The TUI exposes last-step context, provider-cache diagnostics, current model context, and total session cost. As soon as a provider step reports its terminal usage, the live `session.diagnostics.updated` event refreshes that step's context and cache values even while local tools are still settling. This event is instance-local telemetry and is not replayed; the durable assistant projection becomes authoritative when the step ends or fails, so reconnect and restart retain the same values after terminal settlement. While an automatic or mandatory compaction is pending or running, the Session rail replaces the older provider context occupancy with the durable admission pressure as `estimated input / safe input cap` and marks the percentage and value with `est`; provider-reported cache hit, read, and write telemetry remains unchanged and separate. When summarization ends, the rail returns to the latest provider-reported context. Context and provider-cache fields otherwise describe the latest assistant step after the latest completed compaction, while request-summary totals cover the Session's lifetime durable provider-request ledger. Cost is calculated from the selected catalog model's input, output, cache-read, cache-write, and eligible context-tier prices. ChatGPT/Codex and Claude Code subscription routes retain those catalog prices, so their nonzero total is an API-equivalent usage estimate rather than a claim about the subscription invoice. Parent and child Sessions can reuse a prefix only when every model-visible namespace input matches; changing provider, model, variant, policy, permission ceiling, system, or tool definitions creates a distinct key. The Session rail and subagent economics show the provider-reported hit ratio and read/write token evidence but omit a prefix-stability status because unchanged local namespace metadata does not guarantee provider reuse.

Session diagnostics also expose a bounded request summary: logical requests, transport attempts, helper calls, continued requests, fallbacks, raw token categories, estimated cost, and the latest cache invalidation reason. Internal HTTP-attempt observation settles after the response stream rather than at response headers, distinguishing request-stage failure from response-read failure with only route, transport, status, elapsed time, and a bounded failure category; raw causes are excluded. The reader recognizes historical records without an explicit variant as the default variant. The owner's first provider request after an ended compaction reports `compaction-reset`; that reason takes precedence over `model-switched`, which takes precedence over `model-variant-switched`. Unchanged model identity then reports system, tool, or generic prefix changes. Only the first eight characters of the latest prompt-cache namespace are exposed; prompt content, full cache keys, system digests, tool digests, and internal provider-request events remain private. When any request lacks both provider and OpenRouter master catalog pricing, estimated request cost is absent and the TUI renders `Estimated cost unavailable` instead of `$0.00`.

Provider-request rows and per-session, per-model usage aggregates are durable projections of `session.provider.request.recorded` events. `GET /api/session/:sessionID/usage` returns their aggregate after transcript compaction or when cache diagnostics are unavailable. A root Session folds its complete child family by provider, model, and variant; a child Session remains scoped to its own requests. For historical rows without durable cost, the read model uses the current Location catalog and then the current OpenRouter master catalog for the same model and variant; the TUI presents the resulting amount without a separate provenance label. Historical rows backfill when the aggregate table is introduced. Pricing absent from both catalogs keeps the affected model group and whole-session estimated cost unreported; it never becomes zero.

The runtime removes only raw provider-request and usage-aggregate projections for Sessions whose `time_updated` is older than 30 days and which are not active in the local `SessionExecution` process. Cleanup runs at service startup and hourly. It never removes EventV2 records or transcript rows, and pending or suspended status does not change retention.

`GET /api/session/:sessionID/usage/report` groups retained provider-request records by model, UTC hour/day/month, Session, project, or recorded agent. A root includes its descendant family once; a child includes only itself. Optional epoch-millisecond bounds include `from` and exclude `to`. Optional `sort=key|tokens|cost` and `order=asc|desc` sort the complete filtered group set before bounded offset pagination (100 by default, at most 200); omission selects ascending keys. Equal numeric values use ascending keys as the tie-breaker, and absent costs sort last in either direction. Totals cover the complete filtered scope rather than the current page. Token totals sum the disjoint durable categories: uncached input, visible output, reasoning, cache reads, and cache writes. Each priced result identifies recorded or current-catalog cost provenance; partially unpriced totals remain absent. Reports expose normalized counters and tokens, not request IDs, routing details, cache namespaces, digests, prompts, or raw provider payloads.

`GET /api/usage` and `GET /api/usage/report` provide local-backend summary and grouped reports across every stored Session exactly once, including independent roots, descendants, archived Sessions, projects, and Locations. Recorded costs require no Location initialization. Missing historical prices resolve through each Session's own Location; if catalog acquisition encounters a filesystem `NotFound`, retained requests, tokens, and recorded costs remain available while unavailable estimates stay absent. Other acquisition failures still surface. These operations require normal local Server authorization, accept no Session or Location selector, and are excluded from the closed remote shared-Session transport. Totals describe retained projections, not complete historical billing coverage after cleanup.

The Usage screen reads these backend-wide operations and exposes ten direct views: **Overview, Usage, Models, Daily, Hourly, Monthly, Sessions, Projects, Stats, and Agents**. Navigation uses evenly sized, padded cells with vertical separators; narrow terminals show a window containing the active view. Overview shows retained totals and a model breakdown. The Usage view displays provider-reported quota windows separately, using the current Location's available configured providers independently of Session or model selection; account percentages are never summed. The current Session is the return-navigation target, not the scope of usage statistics. Overview and quota content scroll vertically when needed, without a horizontal scrollbar above the footer.

Left/Right or Tab/Shift+Tab switches views. Up/Down selects report rows or scrolls Overview and quota windows; Home/End and PageUp/PageDown navigate the current body. Enter opens selected-row details; Escape closes details before returning to chat. Bracket keys and paging controls load bounded 100-row report pages. Switching report views or changing a range or sort resets paging. `d`, `t`, and `c` sort the full filtered dataset by identity/date, total tokens, and cost; repeating the current sort reverses its order. Date-range controls offer Last 7d, Last 30d, All, and custom `YYYY-MM-DD..YYYY-MM-DD` bounds. Presets include the current UTC day; custom From is inclusive and To exclusive. Totals cover the full filtered scope rather than the current page.

Wide tables allocate remaining width to model identities and share header/row geometry with right-aligned numeric cells and distinct metric colors. Narrow layouts retain identity and token/cost details on separate rows. Missing cache-read telemetry stays unreported. Durable visible output and reasoning are disjoint categories; total tokens include each once. Stats maps retained daily records onto 52 Sunday-aligned UTC calendar weeks, leaves future cells blank, and labels unknown retention coverage. Activity counters describe recorded requests, not inferred user activity. Refresh preserves same-query results and row identity with explicit stale/loading/error labels; late responses cannot replace a newer query or an unmounted screen.

### Model-switch context admission

Changing a Session model uses a serialized process-local transition reservation. The runtime validates the target provider/model/variant before interrupting active requests and tools, waits for settlement, then rereads model-visible history. Invalid targets leave active work untouched. The target safe input budget is its context window minus effective `compaction.context_safety_margin_tokens`, which defaults to 4096 tokens; unresolved or nonpositive budgets are refused.

A fitting switch appends the normal durable model-selection event without a helper call. If context is too large, switching joins already-admitted compaction and may admit at most one additional mandatory job targeting the new model's safe budget. It keeps configured helper selection, bounded internal passes/timeouts, and protected-state validation. Selection is published only after the resulting context fits. Failed compaction or final budget refusal retains the prior selection; a successfully activated summary can remain even if a later check fails. Raw transcript history is never deleted or rewritten by switching. `ModelSwitchBlockedError` retains its structured budget details and optional advisory boundary; resolution/authorization/compaction errors return safe messages and correlation references.

The transition blocks new drains until all reserved switches release. Concurrent advisory wakes are coalesced, so eligible durable pending input can run afterward; the switch never silently replays already-promoted interrupted work. Explicit resume remains an explicit execution request. Canceling the selection waiter cannot publish a late selection, but an already-admitted compaction may finish independently and activate a validated summary without selecting a model or waking the Session. See the [Session contract](../specs/v2/session.md#model-selection-requires-context-fit).

## Provider quota and credit diagnostics

Provider usage is a read-only Location service separate from Session-local token and cost telemetry.

- OpenRouter uses documented current-key data and optional management-credit data.
- OpenAI organization usage uses documented usage and cost endpoints when an explicitly marked admin credential is available.
- Claude subscription state combines live unified response headers with a cached OAuth usage snapshot for cold start, session, all-model, model-specific, and extra-usage buckets. Reported Pro/Max type is included in the safe label.
- Codex and Spark preserve weekly and every additional named limit lane from a configured app-server client contract, with a ChatGPT OAuth backend fallback. Reported Plus/Pro type is included in the safe label.
- GitHub Copilot reporting uses its existing OAuth credential without a configuration key. A read-only, best-effort refresh reads paid quota snapshots or free and limited quota windows; token-based-billing seats instead read organization AI-credit billing summaries and expose exactly one monthly AI-credit window carrying used credits and the monthly reset. GitHub reports no AI-credit entitlement, so that window has no limit and renders without a progress bar rather than inferring one. GitHub AI credits use the fixed rate of `$0.01` USD each. A remembered organization is re-discovered if it no longer returns AI-credit data.
- snapshots are cached by provider and credential identity; concurrent refreshes are deduplicated;
- a failed refresh retains the last valid snapshot as `stale`;
- provider failures never block Session execution;
- unknown amounts remain absent and render as `Not reported`, not zero;
- Protocol and TUI state contain normalized values only, not credential values or provider response bodies.

The Usage screen separates backend-wide retained statistics from provider quota windows; see [report controls](#telemetry). `GET /api/provider/usage` lists each provider available in the current Location's catalog once, including connected providers unused by any Session, while honoring disabled providers and provider policy. Independent provider refreshes run with concurrency bounded to four; a failed provider does not discard successful snapshots. The quota view preserves Spark and other named windows and shows source, stability, freshness, reset times, and ten-cell progress bars. Unknown values remain unreported; reported zeros remain visible. Failed refreshes retain prior snapshots as stale and surface the partial failure. Providers without a supported quota path remain visible with an explicit unsupported status and safe message, without invented windows or amounts.

Provider failure rows render the provider's structured error message through the safe display sanitizer. Ordinary text remains visible, while structured or sensitive historical payloads render only an omission label; interrupted steps retain their existing presentation. The Session header renders only the generic `provider error` status and never repeats the detailed provider message.

The header treats retry metadata as live-only: scheduled backoff shows completed failures, the next attempt, and countdown; an in-flight retry animates; terminal assistants never remain labeled retrying. Execution settlement clears transient retry projection without changing usage, cost, cache, or quota reporting.

For GitHub Copilot models with a non-tiered registry cost, each local token bucket—raw input, raw output, cache read, and cache write—adds an AI-credit column calculated from that model's registry rate and the fixed `$0.01`-per-credit conversion. Other providers retain a single token column. No context-length price multiplier is applied: the presentation selects no context-tiered rate. Missing windows, resets, account tiers, and prices remain unreported rather than becoming zero or being inferred.

## Shell output

A dedicated shell-output route provides full-width shell inspection separate from the session transcript.

### Entry

The shell tab in the composer lists running shells grouped by owning session (Main chat, Subagent, or Unknown session). Each entry shows the command, working directory, PID, elapsed time, and status. Selecting a shell entry and pressing return navigates to that shell's dedicated output view.

### Dedicated output view

The `shell-output` route renders a full-width view with:

- **Header** — command, owner label, PID, and status, color-coded by status.
- **Stream** — a scrollable output area that loads the shell's captured output incrementally. Output is fetched from the server with a cursor-based paginator and accumulated in the view. Running shells poll for new output every second; a poll that lands inside a character the command is still writing returns no new text and leaves the cursor unchanged until that character completes.
- **Metadata** — Owner, Status, Started, and Capture.
- **Footer** — shell ID, PID, owner, and action labels with bound shortcuts.

### Actions

- **Back** — the configurable `shell-output.back` binding returns to the parent session transcript. Its default is escape.
- **Kill** — the configurable `shell-output.kill` binding sends a server-side shell removal request for a running shell. Its default is ctrl+d, and the footer shows the kill binding only while the shell is running.

### Keybindings

| Default key | Command             | Action                         |
| ----------- | ------------------- | ------------------------------ |
| escape      | `shell-output.back` | Navigate back to session       |
| ctrl+d      | `shell-output.kill` | Kill the running shell command |

## Subagent sibling navigation and economics

The TUI provides sibling-subagent navigation within a parent Session's child family.

### Sibling switcher

A `SubagentSiblingSwitcher` renders at the top of a child session's content area when its parent has child tasks. It uses the parent's current bounded task page and renders:

- a clickable compact agent chip for each visible task on that page;
- the current child first when it is resident;
- a warning-colored `?` prefix when a task is waiting with a question;
- fixed parent, previous-page, and next-page navigation hints plus an overflow count when all chips do not fit.

The parent Session is an ↑-prefixed clickable item in the same strip. The active child uses info-colored text, and a blocked task uses warning-colored text. Arrow navigation lazily replaces the resident page when it crosses a page boundary and wraps only after reaching the corresponding family edge.

### Child-session economics and durable state

Managed subagent routes mount `SubagentFooter`. For an unblocked managed child Session, the route mounts `SubagentEconomicsSurface` below the composer. The economics surface renders the available detailed strip: context, reported or unreported cache telemetry, cost, and parent rollup. BTW side conversations use their own return-navigation and context footer.

### Economics computation

`subagentEconomics` computes a summary string and a detailed strip from Session info and cache diagnostics. The mounted `SubagentEconomicsSurface` uses the detailed strip, which includes context, reported or unreported cache telemetry, cost, and parent rollup. Tokens are formatted with `Intl.NumberFormat` and cost with `Intl.NumberFormat` currency formatting. Diagnostics are derived from the same `SessionCacheDiagnostics` type used by the main Session.

### Blocked subagent answer presentation

A subagent is considered blocked when its orchestration task state is `waiting` and a `question` is present. The TUI surfaces blocked state in:

- **Sibling switcher** — warning-colored text and a `?` prefix on the agent chip.
- **Child Session** — `SubagentBlockedSurface` appears above the transcript, and `SubagentAnswerComposer` replaces the normal composer only while the child is waiting with a question. The ordinary economics surface is withheld while blocked.
- **Sidebar rail** — an `awaitingInput` glyph, warning-colored value text showing the question text, and the `attention` prop on the rail section header.
- **Composer subagent tab** — an `awaitingInput` glyph rendered in warning color, the question text shown as detail.

## Rail priority and expanded-state behavior

Every rail section can expand. Defaults expand only `session`, `context`, and `todo`; all other sections start collapsed. Expand/collapse state is shared across Session navigation, so going to a subagent chat and back to the main transcript preserves what was expanded or collapsed.

### Section keys

The rail supports these section keys: `session`, `context`, `todo`, `goal`, `autonomy`, `subagents`, `shells`, `skills`, `mcp`, `plugins`, `guardrails`, `lsp`.

### Default expanded sections

The defaults are `session`, `context`, and `todo`. Every other section (`goal`, `autonomy`, `subagents`, `shells`, `skills`, `mcp`, `plugins`, `guardrails`, `lsp`) starts collapsed behind its header summary but can expand via header toggle or attention. Expansion is driven by the rail's own state; provider inputs do not change it.

### Independent expansion

There is no fixed expansion-count cap. Opening one section does not evict another expanded section.

### Attention-driven expansion

The `RailSection` component accepts an `attention` boolean prop. An attention transition opens a collapsed section. Clearing attention re-collapses only a section opened by that attention transition; a section already expanded by default or by the user stays open. A manual re-expansion made during an attention-owned interval does not transfer ownership and still collapses when attention clears.

Attention-triggered expansion preserves other expanded sections.

### Attention triggers

The `subagents` section enters attention mode when any subagent has a pending question. The `shells` section enters attention mode when orphaned shells (shells whose owning session is no longer known) are present. The `autonomy` section enters attention mode when YOLO mode is active.

### Shells section

The sidebar shells section (`SHELLS`) summarizes running shells grouped by owner (Main chat, Subagent, Unknown session). The summary shows counts of running, terminal, and orphaned shells. Orphaned shells trigger the attention state. Each group row shows the owner label and count.

### Subagents section

The sidebar subagents section (`SUBAGENTS`) renders the current managed-task page in API order: `waiting`, `starting`, `running`, `cancelling`, then the terminal group, with durable update time descending and Session ID ascending inside each group. Each row shows the task description with a glyph, the elapsed time or question text, and a warning color when awaiting input. Its exact family summary is `running/total running`, with an additional waiting count when nonzero; older and newer controls replace the resident page. An attention state highlights when any subagent is waiting for input.

The team composer is a separate picker from the sidebar `SUBAGENTS` section. Its tabs are ordered **Subagents**, **Shell**, **Side chats**, **Idle**. It filters only the resident page; it does not fetch other pages automatically. If the current page has no terminal tasks but adjacent pages exist, Idle shows **No idle tasks on this page** and keeps clickable older/newer controls and matching keyboard hints available even without a selected row. Active tasks appear under Subagents; completed, cancelled, failed, and lost tasks appear under Idle. Elapsed duration is measured from task creation to its update time after terminal settlement and then remains frozen. Selecting a task attaches to its child Session. A parent message steered or queued to a terminal child can reactivate it, preserving its Session context.

### Goal section

The goal section (`GOAL`) appears when goal state exists. It shows the goal text and status; the header summary is the goal status, not a no-progress count.

### Autonomy section

The autonomy section (`AUTONOMY`) shows the current mode label as summary, with attention when YOLO mode is active. Expanded content shows the approval mode (auto for YOLO, manual for normal).

### Rail placement

Rail placement follows terminal width:

- Below 100 columns: hidden.
- 100–119 columns: overlay (floating over the main pane).
- 120 columns and above: docked (fixed sidebar).

Rail width grows linearly from 32 columns at a 120-column terminal to the 50-column design width at 160 columns, then remains capped at 50.

## Terminal release behavior

The TUI is the only release surface and currently includes:

- session transcript and timeline;
- normal, yolo, and goal mode controls;
- subagent tabs, status, notifications, navigation, and sibling switcher;
- child-session sibling switcher, economics surface, and blocked-answer composer;
- session skills and project artifacts;
- distinct guardrail, permission, and form prompts;
- MCP and provider connection flows;
- prompt file, agent, command, skill, and reference autocomplete;
- cache, context, memory, cost, provider quota, and guardrail diagnostics;
- theme and keymap customization;
- complete resident transcript loading;
- one-time startup loading that never remounts resident Session content during later route-specific plugin, tool, or MCP refreshes;
- toast overlays anchored to the physical terminal top-right, including above a docked Session rail;
- dedicated shell output view with kill/back actions;
- rail sidebar with session/context/todo-only expansion persisted across Session navigation.

TUI-visible state must rehydrate from durable or canonical API state after process restart. A feature that appears only after visiting a child session or reopening a dialog is a defect unless the interaction itself is the explicit trigger.

## Known boundaries

- Session execution placement is process-local; clustering is not implemented.
- Resident transcript memory excludes canonical message rows through completed compaction boundaries for each open Session.
- Only the current runtime paths are supported.
