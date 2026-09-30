import { KeepAwake } from "@ycoding-ai/schema/keep-awake"
export { KeepAwake } from "@ycoding-ai/schema/keep-awake"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const KeepAwakeGroup = HttpApiGroup.make("server.keepAwake")
  .add(
    HttpApiEndpoint.get("keepAwake.get", "/api/keep-awake", {
      success: Schema.Struct({ data: KeepAwake.Status }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "v2.keepAwake.get",
      summary: "Get keep machine awake",
      description: "Read whether this server is preventing idle system sleep on its machine.",
    })),
  )
  .add(
    HttpApiEndpoint.put("keepAwake.set", "/api/keep-awake", {
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: Schema.Struct({ data: KeepAwake.Status }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "v2.keepAwake.set",
      summary: "Set keep machine awake",
      description:
        "Start or stop preventing idle system sleep for the lifetime of this server process. The choice is not persisted.",
    })),
  )
  .annotateMerge(OpenApi.annotations({ title: "keep-awake" }))
