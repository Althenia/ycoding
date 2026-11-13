import { Effect } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand, dotsRequestLines } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDotsApi, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.requests, Effect.fn("cli.dots.requests")(function* (input) {
  const request = yield* connectDotsApi(input.server)
  const pending = yield* request(Dots.PendingRequests, `/api/dots/thread/${encodeURIComponent(input.thread)}/requests`)
  if (!pending.requests.length) process.stdout.write("No pending requests\n")
  for (const item of pending.requests) for (const line of dotsRequestLines(item)) process.stdout.write(`${line}\n`)
}, Effect.catch(failCommand)))
