import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { operations, PeerRole, Streaming } from "@ycoding-ai/protocol/v5"
import type { V5Client } from "@ycoding-ai/client/v5"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { frontendClient } from "../../services/client"
import { ServerConnection } from "../../services/server-connection"

export function resolveOperation(name: string) {
  const operation = operations.find((item) => item.diagnosticName === name)
  if (!operation || !operation.roles.includes(PeerRole.LOCAL_CLIENT))
    throw new Error(`Local operation not found: ${name}`)
  return operation
}

export function invokeOperation(client: V5Client, name: string, data: Record<string, unknown>) {
  const operation = resolveOperation(name)
  const binding = { method: operation.diagnosticName, operationID: operation.operationId }
  if (operation.streaming === Streaming.EVENTS) return client.transport.stream<unknown>(binding, data, data)
  return client.transport.call<unknown>(binding, data, data)
}

export default Runtime.handler(
  Commands.commands.api,
  Effect.fnUntraced(function* (input) {
    resolveOperation(input.request)
    const data = yield* Effect.try(() => {
      const value: unknown = JSON.parse(Option.getOrElse(input.data, () => "{}"))
      if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error("--data must be a JSON request object")
      return value as Record<string, unknown>
    })
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      mismatch: "ignore",
    })
    const client = yield* frontendClient(server.endpoint)
    const output = invokeOperation(client, input.request, data)
    if ("then" in output) {
      const result = yield* Effect.tryPromise(() => output)
      if (result instanceof Uint8Array) {
        process.stdout.write(result)
        return
      }
      if (result !== undefined) process.stdout.write(JSON.stringify(result) + EOL)
      return
    }
    yield* Effect.tryPromise(async () => {
      for await (const event of output) process.stdout.write(JSON.stringify(event) + EOL)
    })
  }),
)
