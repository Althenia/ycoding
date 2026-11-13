import { Effect, Option } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand, dotsThreadLine, dotsTranscriptLines } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDotsApi, dotsPath, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.read, Effect.fn("cli.dots.read")(function* (input) {
  const request = yield* connectDotsApi(input.server)
  const transcript = yield* request(Dots.Transcript, dotsPath(`/api/dots/thread/${encodeURIComponent(input.thread)}`, {
    cursor: Option.getOrUndefined(input.cursor), limit: Option.getOrUndefined(input.limit),
  }))
  process.stdout.write(`${dotsThreadLine(transcript.thread)}\n`)
  for (const line of dotsTranscriptLines(transcript)) process.stdout.write(`${line}\n`)
}, Effect.catch(failCommand)))
