import { Effect } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand, dotsAttachConfirmed, dotsAttachWarning, dotsComputerLine } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { ask, connectDots, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.attach, Effect.fn("cli.dots.attach")(function* (input) {
  const request = yield* connectDots(input.server)
  const current = yield* request("/api/dots")
  process.stdout.write(`${dotsComputerLine(current)}\n`)
  if (current.computer?.state === "attached") return undefined
  if (current.computer?.state !== "detached") return yield* Effect.fail(new Error("This computer cannot be attached right now"))
  process.stdout.write(`${dotsAttachWarning}\n`)
  if (!input.yes) {
    const answer = yield* Effect.promise(() => ask("Attach this computer? [y/N] "))
    if (answer === undefined) return yield* Effect.fail(new Error("Confirmation requires an interactive terminal; rerun with --yes"))
    if (!dotsAttachConfirmed(answer)) return yield* Effect.fail(new Error("Attach cancelled"))
  }
  const expectedTarget: Dots.ComputerTarget | undefined = current.computer.target
  const after = yield* request("/api/dots/computer", { replaceOthers: false, ...(expectedTarget === undefined ? {} : { expectedTarget }) })
  process.stdout.write(`${dotsComputerLine(after)}\n`)
  if (after.computer?.state !== "attached") return yield* Effect.fail(new Error("This computer is not attached to your Dot"))
  return undefined
}, Effect.catch(failCommand)))
