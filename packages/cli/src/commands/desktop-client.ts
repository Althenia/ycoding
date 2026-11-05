import { Flag } from "effect/unstable/cli"
import { Spec } from "../framework/spec"

export const DesktopClientCommand = Spec.make("desktop-client", {
  hidden: true,
  params: { resources: Flag.string("resources"), preferences: Flag.string("preferences") },
})
