import { Plugin } from "@ycoding-ai/plugin/effect"
import { Tool } from "@ycoding-ai/plugin/tool"
import { Effect, Schema } from "effect"
import { writeFile } from "node:fs/promises"

export default Plugin.define({
  id: "fixture.effect",
  effect: (context) =>
    Effect.gen(function* () {
      const marker = String(context.options.marker)
      yield* context.tool.transform((draft) =>
        draft.add(
          "effect_echo",
          Tool.make({
            description: "Echo authored input",
            input: Schema.Struct({ text: Schema.String }),
            output: Schema.String,
            execute: (input) => Effect.succeed(`effect ${input.text}`),
          }),
          { codemode: false },
        ),
      )
      yield* Effect.addFinalizer(() => Effect.promise(() => writeFile(marker, "closed")))
    }),
})
