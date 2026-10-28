import { Session } from "@ycoding-ai/core/session"
import { UsageDashboardRead } from "@ycoding-ai/core/usage-dashboard-read"
import { InvalidRequestError } from "@ycoding-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { requestRef } from "../location"

const validateTimeZone = (timeZone: string | undefined, field: string) =>
  timeZone === undefined
    ? Effect.void
    : Effect.try({
        try: () => new Intl.DateTimeFormat("en-US", { timeZone }),
        catch: () => new InvalidRequestError({ message: "Invalid IANA time zone", field }),
      })

export const UsageHandler = HttpApiBuilder.group(Api, "server.usage", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const dashboard = yield* UsageDashboardRead.Service
    return handlers
      .handle("usage.get", () => session.usageAll().pipe(Effect.map((data) => ({ data }))))
      .handle("usage.report", (ctx) => Effect.gen(function* () {
        yield* validateTimeZone(ctx.query.timeZone, "timeZone")
        return { data: yield* session.usageReportAll(ctx.query) }
      }))
      .handle("usage.dashboard", (ctx) => Effect.gen(function* () {
        yield* validateTimeZone(ctx.payload.daily?.timeZone, "daily.timeZone")
        yield* validateTimeZone(ctx.payload.monthly?.timeZone, "monthly.timeZone")
        yield* validateTimeZone(ctx.payload.breakdown?.timeZone, "breakdown.timeZone")
        return { data: yield* dashboard.read(requestRef(ctx.request), ctx.payload) }
      }))
  }),
)
