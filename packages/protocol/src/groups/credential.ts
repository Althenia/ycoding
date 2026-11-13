import { Credential } from "@ycoding-ai/schema/credential"
import { Integration } from "@ycoding-ai/schema/integration"
import { Location } from "@ycoding-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

export const CredentialGroup = HttpApiGroup.make("server.credential")
  .add(
    HttpApiEndpoint.patch("credential.update", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      query: LocationQuery,
      payload: Schema.Struct({ label: Schema.String }),
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.update",
          summary: "Update credential",
          description: "Update a stored credential label.",
        }),
      ),
  )
  .annotateMerge(OpenApi.annotations({ title: "credential" }))
  .add(
    HttpApiEndpoint.post("credential.activate", "/api/credential/:credentialID/activate", {
      params: { credentialID: Credential.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.activate",
          summary: "Activate credential",
          description: "Make a stored credential the active provider profile.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("credential.refresh", "/api/credential/:credentialID/refresh", {
      params: { credentialID: Credential.ID },
      query: LocationQuery,
      success: Location.response(Integration.RefreshResult),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.refresh",
          summary: "Refresh credential",
          description:
            "Refresh a stored OAuth credential with its refresh token and report the new expiry or the exact failure.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("credential.remove", "/api/credential/:credentialID", {
      params: { credentialID: Credential.ID },
      query: LocationQuery,
      success: HttpApiSchema.NoContent,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "credential.remove",
          summary: "Remove credential",
          description: "Remove a stored integration credential.",
        }),
      ),
  )
