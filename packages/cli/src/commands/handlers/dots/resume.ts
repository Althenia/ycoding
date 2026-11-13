import { Effect } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDotsApi, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.resume, Effect.fn("cli.dots.resume")(function* (input) {
  const request = yield* connectDotsApi(input.server)
  const result = yield* request(Dots.ResumeResult, "/api/dots/resume", {})
  process.stdout.write(`Resume: ${result.outcome}${result.threadID === undefined ? "" : ` · thread ${result.threadID}`}${result.rootChanged ? " (new root thread)" : ""}\n`)
  if (result.outcome !== "resumed") yield* Effect.fail(new Error("The Dot runtime resume was not confirmed; check threads before trying again"))
}, Effect.catch(failCommand)))
