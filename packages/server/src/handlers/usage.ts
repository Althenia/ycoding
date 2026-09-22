import { SessionV2 } from "@ycoding-ai/core/session"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const UsageHandler = HttpApiBuilder.group(Api, "server.usage", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return handlers
      .handle("usage.get", () => session.usageAll().pipe(Effect.map((data) => ({ data }))))
      .handle("usage.report", (ctx) => session.usageReportAll(ctx.query).pipe(Effect.map((data) => ({ data }))))
  }),
)
