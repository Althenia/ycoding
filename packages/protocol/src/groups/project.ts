import { Project } from "@ycoding-ai/schema/project"
import { AbsolutePath, PositiveInt, statics } from "@ycoding-ai/schema/schema"
import { Effect, Encoding, Result, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidCursorError } from "../errors.js"
import { LocationQuery, locationQueryOpenApi } from "./location.js"

const root = "/api/project"

const InventoryCursorInput = Schema.Struct({
  search: Schema.String.pipe(Schema.optional),
  anchor: Project.InventoryAnchor,
})
const InventoryCursorJson = Schema.fromJsonString(InventoryCursorInput)
const encodeInventoryCursor = Schema.encodeSync(InventoryCursorJson)
const decodeInventoryCursor = Schema.decodeUnknownEffect(InventoryCursorJson)
const invalidCursor = "Invalid cursor" as const

export const ProjectInventoryCursor = Schema.String.pipe(
  Schema.brand("ProjectInventoryCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof InventoryCursorInput.Type) => make(Encoding.encodeBase64Url(encodeInventoryCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeInventoryCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type ProjectInventoryCursor = typeof ProjectInventoryCursor.Type

export const ProjectInventoryQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(
    Schema.decodeTo(PositiveInt.check(Schema.isLessThanOrEqualTo(200))),
    Schema.optional,
  ).annotate({ description: "Maximum number of directories to return. Defaults to 50." }),
  search: Schema.String.pipe(Schema.optional).annotate({
    description: "Case-insensitive match against the directory path or project name. Ignored when cursor is set.",
  }),
  cursor: ProjectInventoryCursor.annotate({
    description: "Opaque pagination cursor returned as cursor.next in the previous response.",
  }).pipe(Schema.optional),
}).annotate({ identifier: "ProjectInventoryQuery" })

export const ProjectGroup = HttpApiGroup.make("server.project")
  .add(
    HttpApiEndpoint.get("project.list", root, {
      success: Schema.Array(Project.Info),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.project.list",
        summary: "List projects",
        description: "List known projects.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("project.inventory", `${root}/inventory`, {
      query: ProjectInventoryQuery,
      success: Schema.Struct({
        data: Schema.Array(Project.InventoryEntry),
        cursor: Schema.Struct({ next: ProjectInventoryCursor.pipe(Schema.optional) }),
      }).annotate({ identifier: "ProjectInventoryResponse" }),
      error: InvalidCursorError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.project.inventory",
        summary: "List known directories",
        description:
          "List every recorded project directory and every Session directory across projects, ordered by project worktree, project ID, and directory. Use cursor.next to load the following page.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("project.current", `${root}/current`, {
      query: LocationQuery,
      success: Project.Current,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.project.current",
          summary: "Get current project",
          description: "Resolve the project for the requested location.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("project.directories", `${root}/:projectID/directories`, {
      params: { projectID: Project.ID },
      query: LocationQuery,
      success: Project.Directories,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.project.directories",
          summary: "List project directories",
          description: "List known local absolute directories for a project.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.delete("project.forget", `${root}/:projectID/directories`, {
      params: { projectID: Project.ID },
      payload: Schema.Struct({ directory: AbsolutePath }),
      success: HttpApiSchema.NoContent,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.project.forget",
        summary: "Forget project directory",
        description:
          "Delete every Session of the project in the directory, including their child Sessions, then remove the directory record. Files on disk are not touched.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "project",
      description: "Location-scoped project routes.",
    }),
  )
