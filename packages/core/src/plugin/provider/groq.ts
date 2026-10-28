import { Effect } from "effect"
import { define } from "../catalog-host"

export const GroqPlugin = define({
  id: "ycoding.provider.groq",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/groq") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/groq"))
        evt.sdk = mod.createGroq(evt.options)
      }),
    )
  }),
})
