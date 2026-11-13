import { Effect } from "effect"
import { Dots } from "@ycoding-ai/schema/dots"
import { DotsCommand, dotsAttachConfirmed, dotsComputerLine, dotsRemoveWarning } from "../../dots"
import { Runtime } from "../../../framework/runtime"
import { ask, connectDots, failCommand } from "./request"

export default Runtime.handler(DotsCommand.commands.remove, Effect.fn("cli.dots.remove")(function* (input) {
  const request = yield* connectDots(input.server)
  const current = yield* request("/api/dots")
  process.stdout.write(`${dotsComputerLine(current)}\n`)
  if (current.computer?.state !== "attached" && current.computer?.state !== "detached") return yield* Effect.fail(new Error("This computer cannot be removed right now"))
  process.stdout.write(`${dotsRemoveWarning}\n`)
  if (!input.yes) {
    const answer = yield* Effect.promise(() => ask("Remove this computer? [y/N] "))
    if (answer === undefined) return yield* Effect.fail(new Error("Confirmation requires an interactive terminal; rerun with --yes"))
    if (!dotsAttachConfirmed(answer)) return yield* Effect.fail(new Error("Remove cancelled"))
  }
  const expectedTarget: Dots.ComputerTarget | undefined = current.computer.target
  const after = yield* request("/api/dots/computer/remove", expectedTarget === undefined ? {} : { expectedTarget })
  process.stdout.write(`${dotsComputerLine(after)}\n`)
  if (after.computer?.state !== "removed") return yield* Effect.fail(new Error("The removal of this computer was not confirmed"))
  return undefined
}, Effect.catch(failCommand)))
