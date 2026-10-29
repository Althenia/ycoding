import { SessionDecisions } from "@ycoding-ai/core/session/decisions"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const DecisionHandler = HttpApiBuilder.group(Api, "server.decision", (handlers) => Effect.gen(function* () {
  const decisions = yield* SessionDecisions.Service
  return handlers.handle("decision.list", () => decisions.list().pipe(Effect.map((data) => ({ data }))))
}))
