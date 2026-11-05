import { Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

export const DesktopHostCommand = Spec.make("desktop-host", {
  hidden: true,
  params: {
    backend: Flag.string("backend"),
    mode: Flag.choice("mode", ["own", "shared"]),
    server: Flag.string("server").pipe(Flag.optional),
  },
})
