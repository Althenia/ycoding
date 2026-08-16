import { Effect } from "effect"
import { define } from "@ycoding-ai/plugin/effect/plugin"

export const AlibabaPlugin = define({
  id: "ycoding.provider.alibaba",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.aisdk.hook(
      "sdk",
      Effect.fn(function* (evt) {
        if (evt.package !== "@ai-sdk/alibaba") return
        const mod = yield* Effect.promise(() => import("@ai-sdk/alibaba"))
        evt.sdk = mod.createAlibaba(evt.options)
      }),
    )
  }),
})
