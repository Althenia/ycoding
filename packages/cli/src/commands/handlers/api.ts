import { EOL } from "node:os"
import { Effect, Option } from "effect"
import { WebSocket } from "ws"
import { LocalTransport, V5ClientError, namedOperation } from "@ycoding-ai/client/v5"
import { ApiCommand } from "../api"
import { Runtime } from "../../framework/runtime"
import { Service, type Endpoint } from "@ycoding-ai/client/effect/service"
import { ServerConnection } from "../../services/server-connection"

const methods = new Set(["delete", "get", "head", "options", "patch", "post", "put"])

export default Runtime.handler(
  ApiCommand,
  Effect.fn("cli.api")(function* (input) {
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      mismatch: "ignore",
    })
    const endpoint = server.endpoint
    const request = rawRequest(input.request)
    const headers = new Headers(Service.headers(endpoint))
    for (const header of input.header) {
      const index = header.indexOf(":")
      if (index < 1) return yield* Effect.fail(new Error(`Invalid header, expected name:value: ${header}`))
      headers.set(header.slice(0, index).trim(), header.slice(index + 1).trim())
    }
    const body = Option.getOrUndefined(input.data)
    if (!request) {
      if (input.request.length !== 1)
        return yield* Effect.fail(new Error("Expected an operation name or an HTTP method and path"))
      yield* Effect.promise((signal) =>
        runNamed(endpoint, input.request[0], Option.getOrElse(input.param, () => ({})), body, headers, signal),
      )
      return undefined
    }
    if (body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json")

    const response = yield* Effect.tryPromise(() =>
      fetch(new URL(request.path, endpoint.url), {
        method: request.method,
        headers,
        body,
      }),
    )
    const output = yield* Effect.promise(() => response.text())
    if (output) process.stdout.write(output + (output.endsWith(EOL) ? "" : EOL))
    if (!response.ok) {
      process.stderr.write(`ycoding: API request failed: HTTP ${response.status}${EOL}`)
      process.exitCode = 1
    }
    return undefined
  }),
)

export function rawRequest(input: readonly string[]) {
  if (input.length !== 2 || !methods.has(input[0].toLowerCase()) || !input[1].startsWith("/")) return undefined
  return { method: input[0].toUpperCase(), path: input[1] }
}

async function runNamed(
  endpoint: Endpoint,
  name: string,
  params: Readonly<Record<string, string>>,
  body: string | undefined,
  headers: Headers,
  signal: AbortSignal,
) {
  try {
    const { binding, data, stream } = namedOperation(name, params, body, headers)
    const transport = new LocalTransport({
      endpoint,
      socket: (url, auth) => new WebSocket(url, { headers: { ...Object.fromEntries(new Headers(auth)), ...Object.fromEntries(headers) } }),
    })
    try {
      const options = { headers, signal }
      if (stream) {
        for await (const item of transport.stream(binding, data, data.payload, options)) {
          await new Promise<void>((resolve, reject) => {
            process.stdout.write(`data: ${JSON.stringify(item)}\n\n`, (error) =>
              error ? reject(error) : resolve(),
            )
          })
        }
        return
      }
      const output = await transport.call(binding, data, data.payload, options)
      if (output instanceof Uint8Array) process.stdout.write(output)
      else if (output !== undefined) process.stdout.write(JSON.stringify(output) + EOL)
    } finally {
      transport.close()
    }
  } catch (error) {
    const tag = typeof error === "object" && error !== null && "_tag" in error && !(error instanceof Error) ? error._tag : undefined
    if (typeof tag === "string") process.stdout.write(JSON.stringify(error) + EOL)
    const message = typeof tag === "string" ? tag : error instanceof V5ClientError ? `${error.status}: ${error.message}` : error instanceof Error ? error.message : "Unknown error"
    process.stderr.write(`ycoding: API request failed: ${message}${EOL}`)
    process.exitCode = 1
  }
}
