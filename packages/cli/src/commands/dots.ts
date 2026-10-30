import { Flag } from "effect/unstable/cli"
import type { Dots } from "@ycoding-ai/schema/dots"
import { Spec } from "../framework/spec"

export const DotsCommand = Spec.make("dots", {
  description: "Manage this computer's Dots connection",
  commands: [
    Spec.make("attach", {
      description: "Attach this computer to your Dot, replacing your other attached computers",
      params: {
        server: Flag.string("server").pipe(
          Flag.withDescription("Connect to a server URL instead of the background service"),
          Flag.optional,
        ),
        yes: Flag.boolean("yes").pipe(
          Flag.withAlias("y"),
          Flag.withDescription("Confirm detaching your other computers from the Dot without asking"),
          Flag.withDefault(false),
        ),
      },
    }),
  ],
})

export const dotsAttachWarning =
  "Attaching this computer detaches your other computers from your Dot. Your Dot's cloud computer stays attached."

export function dotsComputerLine(status: Dots.NativeStatus) {
  const computer = status.computer ?? { state: "unavailable" as const }
  return `Computer: ${computer.state}${status.computer?.name === undefined ? "" : ` · ${status.computer.name}`}${computer.message === undefined ? "" : ` (${computer.message})`}`
}

export function dotsAttachConfirmed(answer: string | undefined) {
  return answer !== undefined && /^\s*y(es)?\s*$/i.test(answer)
}
