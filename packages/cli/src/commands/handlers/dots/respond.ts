import { Effect, Option, Schema } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDotsApi, failCommand } from "./request"

const decodeAnswers = Schema.decodeUnknownSync(Dots.RequestResponse)

export default Runtime.handler(DotsCommand.commands.respond, Effect.fn("cli.dots.respond")(function* (input) {
  if (Option.isSome(input.decision) === Option.isSome(input.answers))
    return yield* Effect.fail(new Error("Pass exactly one of --decision or --answers"))
  const body = Option.isSome(input.decision)
    ? { decision: input.decision.value }
    : yield* Effect.try({
      try: () => decodeAnswers({ answers: JSON.parse(Option.getOrThrow(input.answers)) }),
      catch: () => new Error("--answers must be a JSON object mapping question IDs to arrays of answer strings"),
    })
  const request = yield* connectDotsApi(input.server)
  const result = yield* request(Dots.RespondResult, `/api/dots/thread/${encodeURIComponent(input.thread)}/requests/${encodeURIComponent(input.request)}`, body)
  process.stdout.write(`Response: ${result.outcome}\n`)
  if (result.outcome === "unknown") return yield* Effect.fail(new Error("The response outcome is unknown; list the pending requests before answering again"))
  return undefined
}, Effect.catch(failCommand)))
