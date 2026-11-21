import { Effect } from "effect"
import { DotsCommand } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDots, dotsRequest, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.interrupt, Effect.fn("cli.dots.interrupt")(function* (input) {
  const dots = yield* connectDots(input.server)
  const result = yield* dotsRequest(() => dots.thread.interrupt({ threadID: input.thread, turnID: input.turn }))
  process.stdout.write(`Interrupt: ${result.outcome}\n`)
  if (result.outcome === "unknown") yield* Effect.fail(new Error("The interrupt outcome is unknown; read the thread before trying again"))
}, Effect.catch(failCommand)))
