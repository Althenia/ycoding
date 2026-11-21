import { Effect } from "effect"
import { DotsCommand, dotsRequestLines } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDots, dotsRequest, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.requests, Effect.fn("cli.dots.requests")(function* (input) {
  const dots = yield* connectDots(input.server)
  const pending = yield* dotsRequest(() => dots.thread.requests({ threadID: input.thread }))
  if (!pending.requests.length) process.stdout.write("No pending requests\n")
  for (const item of pending.requests) for (const line of dotsRequestLines(item)) process.stdout.write(`${line}\n`)
}, Effect.catch(failCommand)))
