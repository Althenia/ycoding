import { Remote } from "@ycoding-ai/schema/remote"
export { Remote } from "@ycoding-ai/schema/remote"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

export const RemoteGroup = HttpApiGroup.make("server.remote")
  .add(
    HttpApiEndpoint.get("remote.get", "/api/remote", {
      success: Schema.Struct({ data: Remote.Status }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "v2.remote.get",
      summary: "Get machine remote connection",
      description: "Read the server-hosted remote connector state for this machine.",
    })),
  )
  .add(
    HttpApiEndpoint.put("remote.set", "/api/remote", {
      payload: Schema.Struct({ enabled: Schema.Boolean }),
      success: Schema.Struct({ data: Remote.Status }),
    }).annotateMerge(OpenApi.annotations({
      identifier: "v2.remote.set",
      summary: "Set machine remote connection",
      description: "Persist the machine remote switch and start or stop this server's connector.",
    })),
  )
  .annotateMerge(OpenApi.annotations({ title: "remote" }))
