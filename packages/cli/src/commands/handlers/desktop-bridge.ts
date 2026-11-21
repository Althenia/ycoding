import { Effect } from "effect"
import { DesktopBridgeCommand } from "../desktop-bridge"
import { Runtime } from "../../framework/runtime"

export default Runtime.handler(
  DesktopBridgeCommand,
  Effect.fn("cli.desktop-bridge")(function* (input) {
    if (!input.stdio) yield* Effect.fail(new Error("desktop-bridge requires --stdio"))
    return yield* Effect.fail(new Error("Desktop bridge is unavailable: authenticated caller binding is not supported"))
  }),
)
