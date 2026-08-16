import { Plugin } from "@ycoding-ai/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "failing-plugin",
  effect: () => Effect.die("plugin failed"),
})
