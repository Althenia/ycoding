import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { DotsCommand } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { connectDots, dotsRequest, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.send, Effect.fn("cli.dots.send")(function* (input) {
  const dots = yield* connectDots(input.server)
  const clientMessageID = randomUUID()
  const result = yield* dotsRequest(() => dots.thread.send({ threadID: input.thread,
    text: input.text, clientMessageID, mode: input.queue ? "queue" : "send",
  }))
  process.stdout.write(`Message: ${result.admission}${result.turnID === undefined ? "" : ` · turn ${result.turnID}`}\n`)
  if (result.admission === "unknown")
    yield* Effect.fail(new Error("The message outcome is unknown; read the thread before sending it again"))
}, Effect.catch(failCommand)))
