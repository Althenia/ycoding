import { AutonomyDefaults } from "@ycoding-ai/schema/autonomy-defaults"
export { AutonomyDefaults } from "@ycoding-ai/schema/autonomy-defaults"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const AutonomyDefaultsGroup = HttpApiGroup.make("server.autonomyDefaults")
  .add(
    HttpApiEndpoint.get("autonomyDefaults.get", "/api/autonomy-defaults", {
      success: Schema.Struct({ data: AutonomyDefaults.Info }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "autonomyDefaults.get",
      summary: "Get autonomy defaults",
      description:
        "Read the saved default mode of each autonomy category. New root Sessions start in these modes. A YOLO default without a recorded risk acceptance reads as Manual.",
    })),
  )
  .add(
    HttpApiEndpoint.put("autonomyDefaults.set", "/api/autonomy-defaults", {
      payload: AutonomyDefaults.Change,
      success: Schema.Struct({ data: AutonomyDefaults.Info }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "autonomyDefaults.set",
      summary: "Set autonomy defaults",
      description:
        "Change the saved default mode of one or more autonomy categories in the global configuration. Saving a YOLO default requires acceptYolo true and records the acceptance time; Manual and Auto drop it. Existing Sessions are unchanged.",
    })),
  )
  .annotateMerge(OpenApi.annotations({ title: "autonomy-defaults" }))
