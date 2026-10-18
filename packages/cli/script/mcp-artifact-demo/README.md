# MCP artifact client demo

This fixed fixture tests host capabilities before admitting generated HTML. The Relay connector and standalone development listener share its tool/resource definitions. Neither reads a workspace, executes a task, exposes arbitrary files, or changes authorization configuration.

## Client trial

Use the existing authorized Relay MCP device connection to call `artifact_demo_preview({})` and `artifact_demo_export({})`. Refresh the client's catalog after loading a changed connector executable. The same connection also exposes its ordinary Session controls; this is not a demo-only authorization scope. No separate endpoint, grant, OAuth setup or tunnel is needed for this route. The [fixed demo contract](../../../../specs/relay-mcp-demo.md) defines its authority and host-verification limits.

## Standalone development listener

Connect a separately authorized test MCP endpoint to this listener. Endpoint routing and client registration are operator actions. Keep the shared listener unchanged.

```sh
bun packages/cli/script/mcp-artifact-demo.ts \
  --port 4098 \
  --resource https://demo.example.com/mcp \
  --issuer https://identity.example.com/ \
  --jwks-url https://identity.example.com/.well-known/jwks.json \
  --subject OWNER_SUBJECT
```

Use an existing externally issued RS256 JWT resource configuration with scope `ycoding:tasks`; this standalone fixture uses the task gateway authenticator, not Relay MCP's OAuth grants. Do not point an existing connector at it without operator approval. It binds only `127.0.0.1`, requires authorization for every MCP request, checks Host and Origin, and serves MCP revision `2026-07-28`. Stop the dedicated foreground process with Ctrl-C. The command never starts or replaces the shared runtime.

The remote agent constructs and retains its own MCP server; launching this script does not change that server or its catalog. The standalone route requires a separately reachable HTTPS MCP endpoint and a separate chat connector using its external JWT authorization configuration. Relay OAuth grants cannot authenticate to this standalone listener. The launch command does not configure a client or publish an endpoint.

## Tools and resources

The preview descriptor contains `_meta.ui.resourceUri: "ui://ycoding/artifact-demo/v1.html"`. `resources/read` of that URI returns `text/html;profile=mcp-app` with `_meta.ui.csp: {connectDomains: [], resourceDomains: [], frameDomains: []}`. The export tool has no UI resource metadata. Its resource URI is `artifact://ycoding-demo/art_<32 hexadecimal characters>`, chosen when the MCP handler initializes; use the exact returned URI rather than reconstructing it.

1. Call `artifact_demo_preview({})`. Confirm that a component appears and **List** / **Cards** switch both structure and the selected label. Check keyboard activation and Back.
2. Read **Host handshake**. `Initialized` requires a reply selecting MCP Apps revision `2026-01-26`; an absent or failed reply does not establish support.
3. Run **Nested frame probe** and try the nested variant controls. Record the displayed status and client/version. The child has `sandbox="allow-scripts"`, an opaque origin, no tool bridge, and a network-denying CSP. A readiness message proves only that this fixed child executed, not that arbitrary generated proposals are safe or supported.
4. Call `artifact_demo_export({})`. The result contains a PNG resource link and immutable ID, filename, MIME, original size, SHA-256, and expiry. Fetch its bytes through `resources/read`, decode the protocol blob, and check size/hash before passing the bytes to the chat host's native attachment facility. Confirm that the resulting file can be downloaded and still matches. An inline image or a resource link alone does not prove native attachment delivery.

The PNG access expires 15 minutes after the MCP handler initializes. For Relay MCP this occurs on the first forwarded MCP request, including discovery; the standalone listener initializes it at launch. Repeating an export/read before expiry returns the same bytes and ID without extending that deadline. Expired and unknown resource identifiers fail. The fixed HTML does not expire. No base64 is returned as conversational text. Protocol blob encoding is transport, not the attachment UI.

The fixed PNG is `ycoding-demo.png`, `image/png`, 79 original bytes, SHA-256 `d3a97d031a3094c93d334c8e01e97c5a235ae1f44d5aab476d51311f16f0bce5`.

The host-side delivery sequence is:

1. Call `artifact_demo_export({})` through the authenticated MCP connection; keep authorization inside that connection, not tool arguments, shell flags, output, or logs.
2. Read the exact resource-link URI using that same connection's `resources/read`. Reject tool errors, expiry, a different URI/MIME, absent blob, or more than 79 decoded bytes. Do not fetch an arbitrary URL supplied as replacement content.
3. Decode the blob in host memory. Require exactly 79 bytes and the SHA-256 above. Retry a failed read only against the same unexpired URI; do not concatenate partial data with a new read.
4. Use the chat host's private native-file ingestion facility with those verified bytes, filename, and MIME, then attach its returned native file reference to the assistant reply. If ingestion needs a file, write only to the host's private attachment directory with exclusive creation and mode `0600`, then remove it after ingestion. Do not publish the PNG or a bearer download URL to an external file host.
5. Download the native attachment and verify its original size/hash again. A screenshot, inline image inspection, manually pasted base64, or a link to the MCP resource is not a successful attachment test.

MCP does not define the host-native ingestion operation. The inspected OpenAI reference documents optional file helpers but does not establish a universal assistant-attachment creation API for this chat. Supply the actual host's file-ingestion capability for step 4; if it is absent, record native attachment delivery as unsupported instead of inventing an API or a file ID.

## Isolation gate

The UI resource uses `_meta.ui.resourceUri` and MIME `text/html;profile=mcp-app`. Its CSP metadata declares empty connection, resource, and frame allowlists. It contains only fixed authored content. Generated HTML must not be inserted into this bridge-bearing document.

OpenAI documents nested frames as blocked by default. Chromium's `frame-src 'none'` does not itself prevent this fixture's `srcdoc` child from executing. The browser harness records that behavior; it does not emulate all chat-host enforcement. Test the actual host before selecting a generated-HTML isolation strategy. Do not add origins or weaken policy to conceal an unsupported client.

## Local checks

```sh
bun test --cwd packages/cli test/mcp-artifact-demo.test.ts
bun test --cwd packages/core test/remote-mcp-transport.test.ts test/task-mcp-auth.test.ts test/task-mcp-transport.test.ts

YCODING_TEST_PLAYWRIGHT_MODULE=/path/to/installed/playwright-core \
YCODING_WEB_CHROME=/path/to/installed/chrome \
node packages/cli/script/mcp-artifact-demo/verify.mjs
```

The browser harness uses temporary loopback listeners and a simulated host, checks 320/639/640/1440px in light/dark and normal/reduced motion, verifies variants, keyboard, history, child-origin isolation, rejected child tool messages, and network denial, then closes its listeners and browser. It installs nothing. It does not verify actual-chat rendering, native attachments, OAuth deployment, or full proposal-skill output.

## References

- [OpenAI UI integration](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI component and file reference](https://developers.openai.com/plugins/reference)
- [MCP Apps specification](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
