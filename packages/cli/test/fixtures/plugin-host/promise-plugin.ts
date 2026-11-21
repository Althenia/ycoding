import { Plugin } from "@ycoding-ai/plugin"
import { writeFile } from "node:fs/promises"

export default Plugin.define({
  id: "fixture.promise",
  setup: async (context) => {
    const marker = String(context.options.marker)
    await context.tool.transform((draft) => {
      draft.add({
        name: "promise_echo",
        description: "Echo authored input",
        jsonSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
        options: { codemode: false },
        execute: async (input) => {
          const text = typeof input === "object" && input !== null && "text" in input ? String(input.text) : ""
          return { structured: { text, label: context.options.label }, content: [{ type: "text", text }] }
        },
      })
    })
    return async () => {
      await writeFile(marker, "closed")
    }
  },
})
