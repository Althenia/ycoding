import { Plugin } from "@ycoding-ai/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "parent.failed-module",
  effect: () => Effect.die(new Error("synthetic configured module setup failure")),
})
