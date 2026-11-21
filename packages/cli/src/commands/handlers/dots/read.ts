import { Effect, Option } from "effect"
import { DotsCommand, dotsThreadLine, dotsTranscriptLines } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDots, dotsRequest, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.read, Effect.fn("cli.dots.read")(function* (input) {
  const dots = yield* connectDots(input.server)
  const transcript = yield* dotsRequest(() => dots.thread.read({ threadID: input.thread,
    cursor: Option.getOrUndefined(input.cursor), limit: Option.getOrUndefined(input.limit),
  }))
  process.stdout.write(`${dotsThreadLine(transcript.thread)}\n`)
  for (const line of dotsTranscriptLines(transcript)) process.stdout.write(`${line}\n`)
}, Effect.catch(failCommand)))
