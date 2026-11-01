export * as AccountConnectorSkills from "./account-skills"

import { Effect, Schema } from "effect"
import { AccountConnectorLibrary } from "./library"

type ReadRequest = (route: string) => Effect.Effect<Response, Error>

export interface ListProof {
  readonly status: number
  readonly keys: ReadonlyArray<string>
  readonly count: number
  readonly hasNext: boolean
  readonly paginationKeys: ReadonlyArray<string>
  readonly ids: ReadonlyArray<string>
}

export interface DetailProof {
  readonly status: number
  readonly keys: ReadonlyArray<string>
}

export interface Read {
  readonly list: () => Effect.Effect<ListProof, Error>
  readonly detail: (id: string) => Effect.Effect<DetailProof, Error>
}

export class RequestRejected extends Error {
  constructor(readonly status: number) {
    super(`ChatGPT account skills request rejected (HTTP ${status})`)
  }
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const invalid = () => new Error("ChatGPT account skills returned an invalid response")

export function make(input: {
  readonly request: ReadRequest
  readonly current: () => Effect.Effect<unknown, Error>
  readonly beforeDispatch?: () => Effect.Effect<void, Error>
}): Read {
  const json = Effect.fn("AccountConnectorSkills.json")(function* (route: string) {
    yield* input.current()
    if (input.beforeDispatch) yield* input.beforeDispatch()
    const response = yield* input.request(route)
    const status = response.status
    const bytes = yield* AccountConnectorLibrary.readBytes(response, 4 * 1024 * 1024).pipe(
      Effect.mapError(() => invalid()),
    )
    const value = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
      new TextDecoder().decode(bytes),
    ).pipe(Effect.mapError(() => invalid()))
    yield* input.current()
    return { status, value }
  })

  return {
    list: Effect.fn("AccountConnectorSkills.list")(function* () {
      const { status, value } = yield* json("/hazelnuts?scope=installed&include_permissions=true")
      if (!record(value) || !Array.isArray(value.hazelnuts)) return yield* Effect.fail(invalid())
      const ids: string[] = []
      for (const item of value.hazelnuts) {
        if (!record(item) || typeof item.id !== "string" || item.id.length === 0)
          return yield* Effect.fail(invalid())
        ids.push(item.id)
      }
      const paginationKeys = ["has_more", "next_cursor", "cursor"].filter((key) => key in value)
      const hasNext =
        value.has_more === true || (typeof value.next_cursor === "string" && value.next_cursor.length > 0)
      return { status, keys: Object.keys(value).sort(), count: ids.length, hasNext, paginationKeys, ids }
    }),
    detail: Effect.fn("AccountConnectorSkills.detail")(function* (id: string) {
      if (id.length === 0 || id === "uploads" || id === "draft" || id === "." || id === "..")
        return yield* Effect.fail(new Error("Unsupported ChatGPT account skill identifier"))
      const { status, value } = yield* json(`/hazelnuts/${encodeURIComponent(id)}?include_permissions=true`)
      if (!record(value) || typeof value.id !== "string" || value.id !== id)
        return yield* Effect.fail(invalid())
      return { status, keys: Object.keys(value).sort() }
    }),
  }
}
