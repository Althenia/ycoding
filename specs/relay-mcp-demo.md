# Relay MCP fixed artifact demo

The client-capability demo adds exactly two read-only tools to the existing authorized Relay MCP connection. It does not admit workspace files or generated HTML.

## Scope

This is a fixed file/image/HTML feasibility demo and Relay transport groundwork, not a general artifact pipeline. It exports one authored PNG and serves one authored interactive HTML document. Arbitrary Session-scoped artifacts, PDFs and complete skill/proposal bundles are not implemented by this demo. Actual-chat UI rendering and native-file delivery remain unverified; local transport and simulated-host checks do not establish them.

## Tools and resources

| Tool                    | Closed operation        | Arguments | Result                                                                                                         |
| ----------------------- | ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `artifact_demo_preview` | `artifact.demo.preview` | `{}`      | Fixed List/Cards data and `_meta.ui.resourceUri: "ui://ycoding/artifact-demo/v1.html"` on the tool descriptor. |
| `artifact_demo_export`  | `artifact.demo.export`  | `{}`      | Original PNG resource link and ID, filename, MIME, byte size, SHA-256, expiry and host-delivery metadata.      |

Both operations reject Session IDs and input objects. Every tool dispatch passes through `executeRemoteOperation`; the demo operations require its explicit connector-owned demo context. Other remote callers cannot select a file, root, URI, Session or Location through these operations.

`resources/list` enumerates only the fixed HTML and the unexpired PNG. `resources/templates/list` returns an empty list. `resources/read` accepts only the exact registered identifiers. Unknown and expired resources fail with the protocol's missing-resource error. Discovery, reads and tool calls retain the existing per-request Relay grant/device/epoch authority. Local admission rechecks authority after reading the request and before releasing a successful result. Cancellation and shutdown return no resource bytes; read retries retain the same immutable identity.

The HTML MIME is `text/html;profile=mcp-app`. Connection, resource and frame CSP allowlists are empty. The fixed nested `srcdoc` probe uses an opaque-origin `allow-scripts` sandbox and a network-denying CSP. Its parent accepts only the fixed readiness diagnostic from that child and forwards no child tool requests. Generated HTML is not accepted into the bridge-bearing document.

The PNG is `ycoding-demo.png`, MIME `image/png`, 79 original bytes, SHA-256 `d3a97d031a3094c93d334c8e01e97c5a235ae1f44d5aab476d51311f16f0bce5`. Its opaque URI is created once when the connector's MCP server initializes on the first forwarded MCP request, including discovery. Access expires 15 minutes after that initialization; calls and retries do not renew it. The fixed HTML does not expire. Protocol blob encoding is not conversational text. A host must verify the decoded size/hash and ingest those bytes through its private native-file facility to deliver an attachment.

MCP revision `2026-07-28`, an MCP Apps descriptor, and locally verified HTML do not establish actual-host rendering or native attachment support. Record those capabilities only after the target chat renders working controls and delivers a downloadable native PNG with matching original bytes. The fixed demo does not establish support for arbitrary generated HTML or proposal bundles.

This additive local integration uses the existing relay endpoint, enrollment, grant and enable epoch. It introduces no OAuth provider, token issuance, tunnel, database migration or additional backend. Loading a changed service executable requires a separately coordinated restart; active root Sessions require explicit resumption with their existing IDs.
