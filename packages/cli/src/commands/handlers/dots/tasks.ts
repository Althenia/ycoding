import { Effect, Option } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand, dotsTaskLine } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDotsApi, dotsPath, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.tasks, Effect.fn("cli.dots.tasks")(function* (input) {
  const request = yield* connectDotsApi(input.server)
  if (Option.isNone(input.task)) {
    const list = yield* request(Dots.ThreadList, "/api/dots/threads")
    for (const task of list.tasks) process.stdout.write(`${dotsTaskLine(task)}\n`)
    return
  }
  const page = yield* request(Dots.TaskUpdates, dotsPath(`/api/dots/tasks/${encodeURIComponent(input.task.value)}/updates`, {
    cursor: Option.getOrUndefined(input.cursor), limit: Option.getOrUndefined(input.limit),
  }))
  for (const update of page.updates) process.stdout.write(`${update.createdAt} ${update.text}\n`)
  if (page.nextCursor !== undefined) process.stdout.write(`More: --cursor ${page.nextCursor}\n`)
}, Effect.catch(failCommand)))
