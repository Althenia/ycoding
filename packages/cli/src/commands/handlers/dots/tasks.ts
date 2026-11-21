import { Effect, Option } from "effect"
import { DotsCommand, dotsTaskLine } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDots, dotsRequest, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.tasks, Effect.fn("cli.dots.tasks")(function* (input) {
  const dots = yield* connectDots(input.server)
  if (Option.isNone(input.task)) {
    const list = yield* dotsRequest(() => dots.threads())
    for (const task of list.tasks) process.stdout.write(`${dotsTaskLine(task)}\n`)
    return
  }
  const taskID = input.task.value
  const page = yield* dotsRequest(() => dots.task.updates({ taskID,
    cursor: Option.getOrUndefined(input.cursor), limit: Option.getOrUndefined(input.limit),
  }))
  for (const update of page.updates) process.stdout.write(`${update.createdAt} ${update.text}\n`)
  if (page.nextCursor !== undefined) process.stdout.write(`More: --cursor ${page.nextCursor}\n`)
}, Effect.catch(failCommand)))
