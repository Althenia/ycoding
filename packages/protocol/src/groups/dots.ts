import { Dots } from "@ycoding-ai/schema/dots"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, InvalidRequestError } from "../errors.js"

export const DotsGroup = HttpApiGroup.make("server.dots")
  .add(HttpApiEndpoint.get("dots.get", "/api/dots", {
    success: Schema.Struct({ data: Dots.NativeStatus }), error: [InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.get", summary: "Read global Dots access, prerequisites and connection" })))
  .add(HttpApiEndpoint.put("dots.set", "/api/dots", {
    payload: Dots.AccessSet, success: Schema.Struct({ data: Dots.NativeStatus }),
    error: [ConflictError, InvalidRequestError],
  }).annotateMerge(OpenApi.annotations({ identifier: "dots.set", summary: "Change Dots access to every existing and future eligible Session at an exact revision" })))
