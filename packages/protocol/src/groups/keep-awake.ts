import { KeepAwake } from "@ycoding-ai/schema/keep-awake"
export { KeepAwake } from "@ycoding-ai/schema/keep-awake"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const KeepAwakeGroup = HttpApiGroup.make("server.keepAwake")
  .add(
    HttpApiEndpoint.get("keepAwake.get", "/api/keep-awake", {
      success: Schema.Struct({ data: KeepAwake.Status }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "keepAwake.get",
      summary: "Get keep machine awake",
      description: "Read idle/display inhibitors, renewed user-activity assertions, lid/system sleep control, and sleeping-family holds. Activity reports assertion success, not an unlocked screen.",
    })),
  )
  .add(
    HttpApiEndpoint.put("keepAwake.set", "/api/keep-awake", {
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: Schema.Struct({ data: KeepAwake.Status }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "keepAwake.set",
      summary: "Set keep machine awake",
      description:
        "Set the process-local manual preference. Sleeping families retain their holds. macOS holds idle/display sleep and renews user activity; deliberate locks and managed policy apply. Each part reports its own status.",
    })),
  )
  .annotateMerge(OpenApi.annotations({ title: "keep-awake" }))
