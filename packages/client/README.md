# @ycoding-ai/client

Private generation target for clients derived directly from YCoding's authoritative Effect `HttpApi`.

## Entrypoints

- `@ycoding-ai/client`: zero-Effect Promise client using `fetch`.
- `@ycoding-ai/client/effect`: rich Effect network client using an environment-provided `HttpClient`.
- `@ycoding-ai/client/v5`: Promise client for the local binary WebSocket connector.

The generated surface includes every standard HTTP group from Server's concrete API. The build compiler reads `@ycoding-ai/server/api`; the generated Effect runtime imports a client-local projection built from Protocol, with a generation-equivalence test preventing transport drift. Custom transports such as the PTY WebSocket connection remain outside the generic HTTP client. Run `bun run generate` after changing the contract and `bun run check:generated` to detect committed-output drift.

The Effect entrypoint uses canonical decoded values such as `Session.ID`, `Location.Ref`, and `Prompt`. These datatypes come from the lightweight `@ycoding-ai/schema` package and are re-exported so callers depend only on the client surface. Protocol owns endpoint construction and middleware placement; Server supplies the concrete middleware keys used by the build-time API.

The Promise root remains structural and has no Core or Effect runtime dependency. `/effect` depends only on Effect, Schema, and Protocol and is browser-bundle safe. Bundle-boundary tests enforce both import graphs.

The local v5 client reports a request that loses its socket before transmission as `unsent`. `V5ClientError.status` carries that classification; its message gives the specific reason, or names the request and the next step for its status when no reason is known. A transmitted mutation without a result stays `unknown`; reconnect never sends it again. A scoped resync lets the affected stream deliver its buffered events in order, then fails that stream with `resync`. Other scopes keep receiving events. Closing or replacing the socket discards unread events from streams that socket still owns.

## Local service lifecycle

`@ycoding-ai/client/service` provides Promise-based `Service.discover`, `Service.ensure` and `Service.stop`; `@ycoding-ai/client/effect/service` provides their Effect counterparts. Discovery reads the registration file and verifies service health. Ensure reuses a compatible service or starts the configured command. Stop addresses the registered service instance.

Pass `expected: { url, pid, auth }` to `Service.stop` when an action belongs to a previously observed connection. The client checks the registered process, normalized URL and authentication capability before sending the stop request. A different registration, refused stop or unconfirmed fallback fails instead of reporting retirement. Omit `auth` for an unauthenticated endpoint. Keep this capability in the native host; do not expose it in logs or renderer state. Calls without `expected` retain the registration-based lifecycle contract.

Effect consumers construct canonical decoded inputs:

```ts
import { AbsolutePath, Location, YCoding, Prompt } from "@ycoding-ai/client/effect"

const client = yield * YCoding.make({ baseUrl: "https://ycoding.example" })
yield *
  client.sessions.create({
    location: Location.Ref.make({ directory: AbsolutePath.make("/workspace") }),
  })
yield * client.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Hello" }) })
```
