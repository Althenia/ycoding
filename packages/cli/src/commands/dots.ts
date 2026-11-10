import { Flag } from "effect/unstable/cli"
import type { Dots } from "@ycoding-ai/schema/dots"
import { Spec } from "../framework/spec"

export const DotsCommand = Spec.make("dots", {
  description: "Manage this computer's Dots connection",
  commands: [
    Spec.make("attach", {
      description: "Attach this computer to your Dot",
      params: {
        server: Flag.string("server").pipe(
          Flag.withDescription("Connect to a server URL instead of the background service"),
          Flag.optional,
        ),
        yes: Flag.boolean("yes").pipe(
          Flag.withAlias("y"),
          Flag.withDescription("Confirm attaching this computer to the Dot without asking"),
          Flag.withDefault(false),
        ),
      },
    }),
  ],
})

export const dotsAttachWarning =
  "This keeps your other computers connected. Choose which computer runs a Dots task in ChatGPT."

export function dotsComputerLine(status: Dots.NativeStatus) {
  const computer = status.computer ?? { state: "unavailable" as const }
  return `Computer: ${computer.state}${status.computer?.name === undefined ? "" : ` · ${status.computer.name}`}${computer.message === undefined ? "" : ` (${computer.message})`}`
}

export function dotsAttachConfirmed(answer: string | undefined) {
  return answer !== undefined && /^\s*y(es)?\s*$/i.test(answer)
}
