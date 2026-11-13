import { Effect } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDotsApi, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.interrupt, Effect.fn("cli.dots.interrupt")(function* (input) {
  const request = yield* connectDotsApi(input.server)
  const result = yield* request(Dots.InterruptResult, `/api/dots/thread/${encodeURIComponent(input.thread)}/interrupt`, { turnID: input.turn })
  process.stdout.write(`Interrupt: ${result.outcome}\n`)
  if (result.outcome === "unknown") yield* Effect.fail(new Error("The interrupt outcome is unknown; read the thread before trying again"))
}, Effect.catch(failCommand)))
