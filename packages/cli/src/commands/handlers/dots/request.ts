import { createInterface } from "node:readline/promises"
import { Effect, Option, Schema } from "effect"
import { Service } from "@ycoding-ai/client/effect/service"
import { Dots } from "@ycoding-ai/schema/dots"
import { ServerConnection } from "../../../services/server-connection"
import { dotsFailureText, dotsRejection } from "./rejection"

export async function ask(question: string) {
  if (!process.stdin.isTTY) return undefined
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await prompt.question(question)
  } finally {
    prompt.close()
  }
}

export const connectDotsApi = Effect.fn("cli.dots.connect")(function* (server: Option.Option<string>) {
  const connection = yield* ServerConnection.resolve({ server: Option.getOrUndefined(server), mismatch: "ignore" })
  return <A>(schema: Schema.Decoder<A>, path: string, body?: unknown) => Effect.tryPromise({ try: async () => {
    const headers = new Headers(Service.headers(connection.endpoint))
    if (body !== undefined) headers.set("content-type", "application/json")
    const response = await fetch(new URL(path, connection.endpoint.url), {
      method: body === undefined ? "GET" : "POST",
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    if (!response.ok) {
      const body: unknown = (() => { try { return JSON.parse(text) } catch { return undefined } })()
      throw new Error(`Dots request failed (${response.status}): ${dotsRejection(body) === undefined ? text : dotsFailureText(body)}`)
    }
    return (await Schema.decodeUnknownPromise(Schema.Struct({ data: schema }))(JSON.parse(text))).data
  }, catch: (error) => error instanceof Error ? error : new Error(String(error)) })
})

export const connectDots = Effect.fn("cli.dots.connectStatus")(function* (server: Option.Option<string>) {
  const request = yield* connectDotsApi(server)
  return (path: string, body?: unknown) => request(Dots.NativeStatus, path, body)
})

export const dotsPath = (base: string, query: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams()
  for (const [name, value] of Object.entries(query)) if (value !== undefined) search.set(name, String(value))
  return search.size ? `${base}?${search}` : base
}

export const failCommand = (error: unknown) => Effect.sync(() => {
  process.stderr.write(`ycoding: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
