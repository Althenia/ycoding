# Process-extension channel v5

## Ownership

Core owns `protocol/ycoding/extension/v5/extension.proto`, its build-generated
Rust bindings/structural rules, framing, and the `extension` supervisor. This
private stdio endpoint has distinct `HostFrame`/`ChildFrame` directions and no
application-wire imports. Only Runtime combines Core and application Protocol;
this descriptor does not change application v5 bindings or their digest.

Extensions are configured trusted OS processes, not sandboxes. Grants constrain
host capability admission, not ambient filesystem/network access. This endpoint
defines tool, transform/hook, event-subscription, resource-registration,
scoped MCP-call, scoped Session-call, scoped provider-attempt, and OAuth-method
families. Providers other than extension-supplied model packages, Session
create/generate/command/synthetic, and bundled integrations are
unsupported. Meeting does not use
this channel. There is no generic application API, database, credential,
filesystem, or event-publication forwarding operation.

## Configuration and authority

`extension::Configuration::load` reads ordered resolved documents and a
host-owned Location directory. Each `extensions` entry specifies `identity`,
absolute `executable`, optional `args`, and explicit `grants`. Each grant supplies
`family: "tools"`, `namespace`, nonempty `tools`, host permission `action`, and
nonempty permission `resources`. Duplicate identities replace definitions in
place, preserving registration order. Children cannot choose Location or grants.

Validation precedes launch: identities, executable permissions, directory,
arguments, grants, unique normalized tool scopes, and handshake size must be
valid. Unsupported fields/families reject. Arguments pass directly without a
shell. JS/TS executable files and Node/Bun/npm/npx launchers reject. Obsolete
`plugins`, `plugin`, `npm`, and executable provider-package declarations produce
actionable fail-closed diagnostics, not configuration mappings.

`Extension::start` receives the existing registry, captured `LeafPolicy`,
launch `Context`, and `Host` services. It requests `extension.launch` permission and a guardrail
reservation for the executable before using `platform::process`. Tool calls
independently check their host-granted action/resources through that captured
policy, including inherited ceilings. Catalog visibility grants no authority.

## Framing and negotiation

Every frame is a four-byte little-endian unsigned payload length followed by one
canonical Protobuf message. Zero length is invalid. Child frames use stdout;
stderr is drained and discarded.

| Bound                            | Value                       |
| -------------------------------- | --------------------------- |
| Payload / startup payload        | 1,048,576 / 16,384 bytes    |
| Decoder retained bytes           | 1,114,116 bytes             |
| Message nesting / fields         | 64 levels / 8,192 per frame |
| Tools                            | 64 per generation           |
| Queued requests / active calls   | 32 each                     |
| Used logical call identities     | 4,096 per generation        |
| Progress updates                 | 128 per call                |
| Retained categorical diagnostics | 32                          |

Host `Hello` declares exact revision 5, extension identity, fresh process
generation, granted capability families/scopes, and approved registration order.
Child `Ready` echoes the exact revision/identity/generation, then one complete
`RegisterTools` batch follows. Registration requires successful negotiation and
complete declaration validation. Every subsequent frame carries that generation.

Malformed/truncated/oversized frames, unknown fields, duplicate singular/oneof
fields, noncanonical encoding, invalid outcomes/enums, repeated startup messages,
stale generations, and unsolicited call output reject the generation. Structural
depth/field checks precede Prost decoding. Field order must match the generated
canonical encoding; alternative equivalent Protobuf encodings are not accepted.

`Text` carries UTF-8 or little-endian UTF-16 units. The unit branch is reserved
for strings with unpaired surrogates; odd byte lengths or scalar-valid unit
encodings reject. `Value` carries finite JSON-domain values, lists, and objects
with lossless keys. Duplicate object keys reject. There is no JSON-string or
opaque application-envelope tunnel. Outbound values have a conservative
preconversion depth/field/size bound before recursive encoding.

## Tools and settlement

Each tool declares namespace/name, description, input/output schemas, and
independent direct/Code Mode visibility; at least one visibility is required.
Namespace/name membership comes from host grants. The typed
`Registry::register_process_batch` installs the complete generation atomically;
materializations retain their captured handlers and leaf policy.

Schemas support objects (`properties`, `required`, boolean
`additionalProperties`), arrays with `items`, null, and Forms-validated string,
number, integer, and boolean constraints. Unsupported keywords reject
registration; this is not a complete JSON Schema implementation. Final
structured output validates against its schema. Typed text/file content passes
through normal materialization image normalization and managed output-store
bounding. Code Mode retains its existing nested-call output policy.

`Execute` owns a fresh invocation number and Session/message/call/agent identity.
`Result`, `Progress`, and `Cleanup` must echo the complete identity. A logical
Session/message/call identity is dispatched at most once per generation, even
after failure; capacity exhaustion rejects before dispatch. Progress uses an
object-valued structured update and typed content through the captured sink.
Safe failures are categorical `REJECTED`, `EXECUTION_FAILED`, or
`UNKNOWN_OUTCOME`; no child exception text is accepted.

Loss of a transmitted unresolved call, including malformed settlement or exit,
produces visible `extension.unknown_outcome`. The supervisor never restarts or
replays work. Output-schema failure is visible; invalid output is not success.

## Cancellation and lifetime

Explicit cancellation and dropped call futures send owned `Cancel` requests.
Cancellation settles only after matching `Cleanup` or process termination and
reaping. A result after cancellation does not substitute for cleanup. Neither
cancellation nor cleanup promises rollback.

Replacement/shutdown stops intake, cancels/drains active calls, revokes the batch,
then sends `Shutdown`. Child `Stopped` acknowledges shutdown; process policy
performs a bounded graceful stop followed by forced tree termination when
necessary. Exit revokes registrations and visibly fails affected calls. Captured
materializations cannot dispatch against closed generations. Await `shutdown`
to join owned work or `closed` to observe completed cleanup. Dropping an
extension requests stop and forces termination if its control queue is full.

Defaults are five seconds for startup/write, twelve hours for execution, and
two seconds each for cleanup/shutdown. Explicit deadlines may be shorter;
lifecycle/write deadlines cannot exceed five seconds and execution cannot exceed
twelve hours. Deadlines never trigger hidden retries.

Diagnostics retain bounded enum categories only; child diagnostics accept only
`CHILD_WARNING`. Stderr yields `STDERR_DISCARDED`. Raw bytes, arguments, paths,
payloads, and exception text are not captured in diagnostics.

## Ordered capability families

Non-tool grants specify `family`, explicit `scopes`, permission `action`, and
permission `resources`. Families are `hooks`, `transforms`, `events`,
`registrations`, `mcp`, `session`, `providers`, and `auth`. A family/scope pair appears at most once across an
extension's grants; a duplicate rejects configuration. The complete startup batch carries tools, transform declarations,
typed domain registrations, and subscriptions; host validation precedes batch
installation. Transform stages are closed enum values, not arbitrary operation
names or application routes.

`Transform` owns a call identity, declaration ID, stage, revision, and a bounded
domain-valued draft. `Transformed` must echo the call, stage, revision, and process
generation. Failure, cancellation, replacement, and exit use the existing
supervisor lifetime; there is no transform replay. Tool before/after callbacks
run at the existing materialization boundaries and sort by host registration
order. Before hooks can change input, not tool ownership. After hooks can change
structured/content output and result, not invocation input or managed output
paths. Changed output and visible results pass through normal image normalization
and managed output bounding; producer-owned codecs revalidate structured output.
A failed tool cannot be reported as successful by
an after hook.

`extension::Resources::materialize` clones host resource snapshots, composes
generation-scoped agent/command/reference/skill/catalog records and transforms
in host order, validates domain values through Schema, then returns actual
resource services. The original services remain unchanged on rejection. Closed
generations contribute no records to a fresh materialization. Agent defaults,
command fields, skill sources, provider/model records, variants, request overlays,
and catalog defaults retain their native domain representations. Skill transforms
retain existing sources and add sources through the native source interface.

`extension::context::prepare` operates before AI route preparation on a cloned
request. It carries scoped Session/agent/model/route identities, system parts,
typed message parts, and tool definitions. Identity and resident-message trust
checks reject impersonation. Every returned message carries its unique host
`origin` index; missing, duplicated, out-of-range, or fractional origins reject.
Messages without durable IDs still have owned origins. ID, role, volatility,
metadata, and native ownership fields are immutable. Hooks may filter/reorder
owned messages and transform content, but cannot inject unsolicited messages.
Tool names, output contracts, cache hints, metadata, and native ownership remain
host-owned. All tool-definition transforms finish in host order before context
hooks run in host order. Changes affect only the model-visible request, not
durable history. Transport-defect context failures append the existing visible
user warning; typed callback failures propagate. This is a component preparation
boundary, not an assembled Session runner.

Subscriptions use explicit known event-family grants, with at most eight
subscriptions per process and sixteen families per subscription. Credential/auth
families are excluded. Hosts publish typed Schema ephemeral/durable payloads;
children cannot publish events. `EventDelivery` retains a delivery identity until
matching `EventReceipt`. At most eight deliveries are outstanding, counting both
queued and handed frames. Admission reserves the whole subscription fanout before
sending any frame and rejects quota exhaustion without partial delivery. A
receipt is due within the write deadline after its delivery frame is handed to
the child. Each
complete event payload is bounded to 65,536 bytes and uses the bounded supervisor
queue. Missing receipts,
unknown/duplicate receipts, or exhausted outstanding capacity close the affected
generation. `Subscribe` after startup follows the same grants and bounds; an
`Unsubscribe` for an unknown subscription closes the generation. `Unsubscribe`,
generation close, replacement, and exit release subscription state. Durable event identities/sequences remain in the envelope.

## Scoped MCP calls

`mcp` grants use `scopes` as MCP server names, with the same permission `action`
and `resources` fields. `Extension::start` and `replace` receive a `Host` that
carries the optional MCP `Service`; without one, every MCP call is rejected.

A child issues `HostCall` only for an owned in-flight `Execute` or `Transform`,
echoing its complete call identity, with a child-chosen `request` that is unique
within the generation (at most 4,096 used identities). Operations are
`McpServers`, `McpTools`, `McpReadResource`, and `McpCallTool`. Listings contain
only granted servers. Each server operation checks its grant, then the captured
permission and guardrail policy with the parent call's Session context, before
dispatch. Results are JSON-domain `Value`s: servers expose `name` and `status`,
tools expose `server`, `codemode`, and `definition`, resource reads return the
MCP result or null, and tool calls return `isError`, `content`, and optional
`structured`. Connection and credential details are not exposed.

`HostReply` echoes the call and request and carries either a `Value` or a
categorical `Failure`. `REJECTED` covers an ungranted server, an absent service,
denied policy, and more than eight in-flight calls; `EXECUTION_FAILED` covers MCP
errors and results too large for one frame. A `HostCall` for an unknown,
completed, or cancelling call, a duplicate `request`, or exhausted identities is
a protocol violation that closes the generation. Cancelling, completing, timing
out, or replacing the parent signals its nested MCP operations to cancel and
drops their replies; generation exit aborts them. Children cannot select servers
outside their grants or publish events.

## Scoped Session calls

`session` grants use `scopes` `get`, `prompt`, and `interrupt`, with the same
permission `action` and `resources` fields. `Extension::start` and `replace`
receive a `Host` that carries the optional `SessionHost` store and Location;
without one, every Session call is rejected.

A child issues `HostCall` only for an owned in-flight `Execute` or `Transform`,
echoing its complete call identity, with a child-chosen `request` that is unique
within the generation (at most 4,096 used identities). Operations are
`SessionGet` (session), `SessionPrompt` (session, message, user pending input,
optional resume), and `SessionInterrupt` (session). A child granted the
`session` family may get, prompt, or interrupt any Session in its own Location
(the generation host's Location); Sessions in other Locations, missing
Sessions, and malformed identities are rejected. Each operation checks its own
scope grant, then the captured permission and guardrail policy with the parent
call's Session context, before dispatch.

`SessionGet` returns the Session `Info`. `SessionPrompt` admits one durable
user pending input under the child-chosen message ID through
`SessionExecution::prompt`: the first admission wins and is returned with its
admitted sequence, while cross-Session or cross-kind prompt ID reuse is
rejected; only `session_pending` user messages are accepted. `resume: false`
requests admit-only behavior, otherwise admission wakes execution.
`SessionInterrupt` interrupts the active process-local ownership chain for that
Session; interruption of a known but idle or locally unowned Session is a
no-op, while an unknown Session is rejected. Session create, generate, command,
and synthetic have no general public Core API and remain unsupported.

`HostReply` echoes the call and request and carries either a `Value` or a
categorical `Failure`. `REJECTED` covers an ungranted scope, an absent session
host, denied policy, a foreign or missing Session, malformed identities, and
durable input-identity conflicts; `EXECUTION_FAILED` covers store, admission,
and interruption errors, and results too large for one frame. A `HostCall` for
an unknown, completed, or cancelling call, a duplicate `request`, or exhausted
identities is a protocol violation that closes the generation. Cancelling,
completing, timing out, or replacing the parent signals its nested Session
operations to cancel and drops their replies; generation exit aborts them.

## Scoped provider attempts

`providers` grants use `scopes` as `aisdk:` model package names, with the same
permission `action` and `resources` fields. A granted extension supplies those
packages: `Extension::start` registers each granted scope in the process
provider registry bound to its generation, and generation close, replacement,
or exit unregisters them. `from_catalog_model` maps a non-native `aisdk:`
package to the process-backed provider-attempt transport while a granted
extension provides it; otherwise the package keeps its built-in route.

The ai crate defines the narrow `ProcessAttempt` trait and the
`Transport::Process` route variant, so ai never depends on Core. A route with
process transport lowers the request through its native protocol, forwards the
model, provider options, and lowered body as one `ProviderAttempt`, and replays
the returned wire frames through the same native parser and event pipeline as
its built-in routes, so text, tool-call, usage, and finish shapes are
identical.

The host sends `ProviderRequest` frames with a host-allocated `request`
identity, at most eight outstanding per generation, bounded by the execution
deadline. Each attempt checks the live providers-scope grant, then the captured
permission and guardrail policy with the extension launch Session context,
before dispatch; oversized attempt bodies are rejected without sending. The
child replies with one `ProviderResult`: a `frames` array of protocol wire
values or a categorical `Failure`. Malformed frames or invalid failure codes
close the generation; results too large for one frame fail the attempt without
closing it. A result for an unknown or already settled request is ignored so
cancellation races cannot close the generation. Dropping the attempt future
sends `ProviderCancel` and discards the late reply; generation exit aborts
pending attempts with an unknown outcome and revokes the packages. Children
cannot supply packages outside their grants.

## OAuth integration methods

`auth` grants use `scopes` as integration identifiers, with the same permission
`action` and `resources` fields. `Host` carries the optional integration
`Registry`. A child declares each method in the startup batch as an
`OAuthRegistration`: its integration, an `OAuthMethod` domain value, and whether
it supplies refresh and labels. Registration requires a granted integration
scope, a host registry, and unique integration/method pairs. The host installs
all of a generation's methods through one registry transform, which is revoked
when the generation closes, is replaced, or exits.

The host sends `AuthRequest` frames with a host-allocated `request` identity, at
most eight outstanding, bounded by the execution deadline. Operations are
`AuthAuthorize` (integration, method, inputs), `AuthCallback` (the authorize
request as `authorization`, plus the code for a code-mode method), `AuthSubmit`
(a manual code for an automatic attempt), `AuthRefresh` (the stored OAuth
credential), and `AuthLabel` (a newly obtained credential). `AuthReply` echoes
the request and carries one outcome matching the operation: an authorization
(URL, instructions, optional expiry, `AUTO` or `CODE` mode, manual-code
support), a credential, a label or done, or a categorical `Failure`. An unknown
or already settled request, an outcome that does not match its operation, or an
invalid failure code closes the generation. A returned credential must decode as
an OAuth credential for the registered method; otherwise the attempt is
rejected. A label is requested after each exchange and consumed once by the
registry label hook.

A request past the execution deadline closes the generation. Shutdown and exit
fail pending requests with an unknown outcome and leave the registry without the
methods. Credentials and authorization codes
appear only in message fields whose `Debug` rendering is redacted, and host
errors are categorical.

## Verification boundary

`extension_process` exercises real Python children, stdio pipes, merged tool
registry/materialization, captured permission/guardrail services, Code Mode,
and managed output storage. `extension_mcp` additionally runs a real MCP stdio
server through the committed `mcp-timeout` fixture, which requires `bun`.
`extension_auth` drives the real integration registry and credential store
through authorize, code and automatic completion, manual-code submission,
refresh, labelling, revocation, and redaction.
`extension_session` drives real Session store and execution placement through
get/prompt/interrupt, own-Location confinement, per-scope grants, durable first
admission with cross-Session and cross-kind rejection, and revocation on exit.
Oversized host-call results beyond the frame bound are rejected without closing
the generation.
`extension_providers` drives a fake provider child through text, tool-call,
and usage round-trips, denied provider authority, attempt cancellation with
generation reuse, and revocation on shutdown. The ai `process_transport` suite
covers the same shapes through a stubbed attempt without a child.
`extension_wire` covers independent golden framing,
canonical negatives, lossless values, and structural bounds.
`extension_contract` covers descriptor ownership/direction. These checks require
`/usr/bin/python3`, install nothing, and use synthetic temporary resources. They
do not prove unsupported families or OS sandbox enforcement.
