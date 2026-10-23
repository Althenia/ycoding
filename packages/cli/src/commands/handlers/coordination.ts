import { Effect, Option } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import { CoordinationCommand, coordinationRequest } from "../coordination"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"

export default Runtime.handler(CoordinationCommand, Effect.fn("cli.coordination")(function* (input) {
  const request = yield* Effect.try(() => coordinationRequest(input.action, Option.getOrUndefined(input.group), Option.getOrUndefined(input.data)))
  const connection = yield* ServerConnection.resolve({ server: Option.getOrUndefined(input.server), standalone: input.standalone, mismatch: "ignore" })
  const headers = new Headers(Service.headers(connection.endpoint))
  if (request.body !== undefined) headers.set("content-type", "application/json")
  const response = yield* Effect.tryPromise(() => fetch(new URL(request.path, connection.endpoint.url), {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
  }))
  const result = yield* Effect.promise(() => response.text())
  if (!response.ok) return yield* Effect.fail(new Error(`Coordination request failed (${response.status}): ${result}`))
  if (result) process.stdout.write(`${result}\n`)
}, Effect.catch((error) => Effect.sync(() => {
  process.stderr.write(`ycoding: ${error.message}\n`)
  process.exitCode = 1
}))))
