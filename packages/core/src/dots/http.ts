export * as DotsHttp from "./http"

import { Effect, Schema } from "effect"
import { DotsTransport } from "./transport"
import { OpenAICodex } from "../plugin/provider/openai-codex"

const origin = "https://chatgpt.com/backend-api"
const decodeJSON = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))
const controlRoute = /^\/tbo\/[^/]+\/runtime\/(?:pause|resume)$/
const routes = [/^\/tbo\/primary$/, /^\/tbo\/by-thread\/[^/]+$/, controlRoute, /^\/messaging\/rooms(\/.*)?$/, /^\/celsius\/ws\/user$/]

export interface Request {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly body?: unknown
}

export interface Interface {
  readonly json: (credentials: DotsTransport.Credentials, input: Request) => Effect.Effect<unknown, DotsTransport.Error>
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

const failure = (reason: DotsTransport.Error["reason"], message: string) => new DotsTransport.Error({ reason, message })

const validPath = (path: string) => {
  if (!path.startsWith("/") || path.startsWith("//") || /[\\#\s\u0000-\u001f]/.test(path)) return false
  const query = path.indexOf("?")
  const pathname = query === -1 ? path : path.slice(0, query)
  if (!routes.some((route) => route.test(pathname))) return false
  return pathname.split("/").every((segment) => {
    const lowered = segment.toLowerCase().replaceAll("%2e", ".")
    return lowered !== "." && lowered !== ".."
  })
}

export function make(options: { readonly fetch: Fetch }): Interface {
  const json: Interface["json"] = (credentials, input) =>
    Effect.gen(function* () {
      const write = input.method === "POST"
      const ambiguous = write
        ? failure("disconnected", "Dots request outcome is unknown")
        : failure("unavailable", "Dots service is unavailable")
      if (!validPath(input.path)) return yield* failure("rejected", "Dots request path is not allowed")
      if (controlRoute.test(input.path.split("?")[0]!) && (input.method !== "POST" || input.body !== undefined || input.path.includes("?")))
        return yield* failure("rejected", "Dots runtime controls require a bodyless POST")
      const headers = new Headers({
        ...OpenAICodex.headers(),
        Authorization: `Bearer ${credentials.access}`,
        "ChatGPT-Account-Id": credentials.accountID,
        "X-OpenAI-Expected-Account-Id": credentials.accountID,
        Accept: "application/json",
      })
      const multipart = input.body instanceof FormData
      if (input.body !== undefined && !multipart) headers.set("Content-Type", "application/json")
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          options.fetch(`${origin}${input.path}`, {
            method: input.method,
            headers,
            redirect: "error",
            signal,
            ...(input.body === undefined ? {} : { body: multipart ? input.body : JSON.stringify(input.body) }),
          }),
        catch: () => ambiguous,
      })
      if (!response.ok) {
        if (response.status === 401) return yield* failure("unauthorized", "Dots credentials were not accepted")
        if (response.status >= 500 || response.status === 408) return yield* ambiguous
        return yield* failure("rejected", "Dots request was rejected")
      }
      if (response.status === 204) return undefined
      const text = yield* Effect.tryPromise({ try: () => response.text(), catch: () => ambiguous })
      return yield* Effect.try({
        try: () => decodeJSON(text),
        catch: () => (write ? ambiguous : failure("invalid-response", "Dots response was not valid JSON")),
      })
    })
  return { json }
}
