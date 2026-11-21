import { Plugin } from "@ycoding-ai/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "parent.module-path",
  effect: (ctx) => Effect.gen(function* () {
    yield* ctx.tool.transform((draft) => draft.add("module_counter", {
    description: "A genuine configured module",
    jsonSchema: { type: "object", properties: {}, additionalProperties: false },
    execute: () => Effect.succeed({ structured: { module: true, pid: process.pid }, content: [] }),
    }, { codemode: false }))
    yield* ctx.session.hook("context", (event) => Effect.sync(() => {
      event.system.push({ type: "text", text: "genuine-module-context" })
    }))
  }),
})
