import { Effect } from "effect"
import { DotsCommand } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDots, dotsRequest, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.resume, Effect.fn("cli.dots.resume")(function* (input) {
  const dots = yield* connectDots(input.server)
  const result = yield* dotsRequest(() => dots.resume())
  process.stdout.write(`Resume: ${result.outcome}${result.threadID === undefined ? "" : ` · thread ${result.threadID}`}${result.rootChanged ? " (new root thread)" : ""}\n`)
  if (result.outcome !== "resumed") yield* Effect.fail(new Error("The Dot runtime resume was not confirmed; check threads before trying again"))
}, Effect.catch(failCommand)))
