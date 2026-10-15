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
      description: "Read effective idle/lid keep-awake, manual preference when sleep-held, and sleeping-family hold status on this machine.",
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
        "Set the process-local manual keep-awake preference. Sleeping Session families retain their holds independently; macOS controls idle and lid sleep and reports each part.",
    })),
  )
  .annotateMerge(OpenApi.annotations({ title: "keep-awake" }))
