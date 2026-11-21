import { Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

export const DesktopBridgeCommand = Spec.make("desktop-bridge", {
  description: "Desktop stdio transport (authenticated caller binding unavailable)",
  params: {
    stdio: Flag.boolean("stdio").pipe(Flag.withDefault(false)),
    server: Flag.string("server").pipe(Flag.optional),
    standalone: Flag.boolean("standalone").pipe(Flag.withDefault(false)),
  },
})
