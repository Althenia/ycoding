import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { ProjectInventory } from "@ycoding-ai/core/project/inventory"
import { InvalidCursorError } from "@ycoding-ai/protocol/errors"
import { ProjectInventoryCursor } from "@ycoding-ai/protocol/groups/project"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  handlers
    .handle("project.list", () => Project.Service.use((project) => project.list()))
    .handle("project.inventory", (ctx) =>
      Effect.gen(function* () {
        const inventory = yield* ProjectInventory.Service
        const cursor = ctx.query.cursor
          ? yield* ProjectInventoryCursor.parse(ctx.query.cursor).pipe(
              Effect.mapError((message) => new InvalidCursorError({ message })),
            )
          : undefined
        const search = cursor ? cursor.search : ctx.query.search
        const page = yield* inventory.list({ limit: ctx.query.limit ?? 50, search, after: cursor?.anchor })
        return {
          data: page.data,
          cursor: page.next ? { next: ProjectInventoryCursor.make({ search, anchor: page.next }) } : {},
        }
      }),
    )
    .handle("project.current", () =>
      Location.Service.use((location) =>
        Effect.succeed({ id: location.project.id, directory: location.project.directory }),
      ),
    )
    .handle("project.directories", (ctx) =>
      Project.Service.use((project) => project.directories({ projectID: ctx.params.projectID })),
    )
    .handle("project.forget", (ctx) =>
      ProjectInventory.Service.use((inventory) =>
        inventory
          .forget({ projectID: ctx.params.projectID, directory: ctx.payload.directory })
          .pipe(Effect.as(HttpApiSchema.NoContent.make())),
      ),
    ),
)
