import { Location } from "@ycoding-ai/core/location"
import { Project } from "@ycoding-ai/core/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

export const ProjectHandler = HttpApiBuilder.group(Api, "server.project", (handlers) =>
  handlers
    .handle("project.list", () => Project.Service.use((project) => project.list()))
    .handle("project.current", () =>
      Location.Service.use((location) =>
        Effect.succeed({ id: location.project.id, directory: location.project.directory }),
      ),
    )
    .handle("project.directories", (ctx) =>
      Project.Service.use((project) => project.directories({ projectID: ctx.params.projectID })),
    ),
)
