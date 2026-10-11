# Plugin MCP domain

Effect and Promise plugin contexts expose the current Location's existing MCP registry. The public structural contracts live in [`packages/plugin/src/effect/mcp.ts`](../packages/plugin/src/effect/mcp.ts) and [`packages/plugin/src/promise/mcp.ts`](../packages/plugin/src/promise/mcp.ts); [`PluginHost`](../packages/core/src/plugin/host.ts) delegates to Core MCP and [`PluginPromise`](../packages/core/src/plugin/promise.ts) adapts Effect results to promises.

| Operation                         | Boundary                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `servers()`                       | Current configured runtime server status.                                                              |
| `tools()`                         | Current tool names, schemas and descriptions; no authority inferred from metadata.                     |
| `readResource({server, uri})`     | Existing MCP resource read and not-found behavior.                                                     |
| `callTool({server, name, args?})` | Existing MCP execution/result/error behavior; opaque arguments and structured output remain untrusted. |

These methods are trusted runtime-plugin capabilities, not a model-visible tool or automatic permission grant. Plugin authors must implement required approval and source-scope controls before exposing them to users or models. There is no additional registry, OAuth flow, network transport, server mutation method, or public HTTP endpoint.

The [Meeting extension](../docs/meeting-intelligence.md) is an active consumer. It binds search/read/write explicitly, keeps its analysis Session tool-free, validates evidence, and restricts canonical writes to native human review plus revision/read-back checks. A capture credential cannot invoke its native control endpoint.

## Verification

`packages/core/test/plugin/promise.test.ts` checks Effect/Promise forwarding and errors. `packages/core/test/meeting-mcp.integration.test.ts` exercises the existing MCP client and registry over a real loopback SDK server, while `packages/core/test/meeting-plugin.integration.test.ts` exercises actual plugin discovery, tool denial, bridge startup and cleanup. No Protocol generation is needed because the HTTP contract is unchanged.
