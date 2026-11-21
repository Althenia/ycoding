import { Effect } from "effect"
import { DotsCommand, dotsThreadLine, dotsTaskLine } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDots, dotsRequest, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.threads, Effect.fn("cli.dots.threads")(function* (input) {
  const dots = yield* connectDots(input.server)
  const list = yield* dotsRequest(() => dots.threads())
  process.stdout.write(`Dot: ${list.dotID}\n`)
  for (const thread of list.threads) process.stdout.write(`${dotsThreadLine(thread)}\n`)
  for (const task of list.tasks) process.stdout.write(`${dotsTaskLine(task)}\n`)
}, Effect.catch(failCommand)))
