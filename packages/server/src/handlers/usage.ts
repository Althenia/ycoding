import { SessionV2 } from "@ycoding-ai/core/session"
import { InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const UsageHandler = HttpApiBuilder.group(Api, "server.usage", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return handlers
      .handle("usage.get", () => session.usageAll().pipe(Effect.map((data) => ({ data }))))
      .handle("usage.report", (ctx) => Effect.gen(function* () {
        const timeZone = ctx.query.timeZone
        if (timeZone !== undefined) yield* Effect.try({
          try: () => new Intl.DateTimeFormat("en-US", { timeZone }),
          catch: () => new InvalidRequestError({ message: "Invalid IANA time zone", field: "timeZone" }),
        })
        return { data: yield* session.usageReportAll(ctx.query) }
      }))
  }),
)
