import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDotsApi, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.send, Effect.fn("cli.dots.send")(function* (input) {
  const request = yield* connectDotsApi(input.server)
  const result = yield* request(Dots.SendResult, `/api/dots/thread/${encodeURIComponent(input.thread)}/message`, {
    text: input.text, clientMessageID: randomUUID(), mode: input.queue ? "queue" : "send",
  })
  process.stdout.write(`Message: ${result.admission}${result.turnID === undefined ? "" : ` · turn ${result.turnID}`}\n`)
  if (result.admission === "unknown")
    yield* Effect.fail(new Error("The message outcome is unknown; read the thread before sending it again"))
}, Effect.catch(failCommand)))
