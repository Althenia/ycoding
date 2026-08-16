export * as ProjectArtifactTool from "./project-artifact"

import { ToolFailure } from "@ycoding-ai/ai"
import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { ProjectArtifact } from "@ycoding-ai/schema/project-artifact"
import { Project } from "@ycoding-ai/schema/project"
import { Effect, Schema } from "effect"
import { Location } from "../location"
import { PermissionV2 } from "../permission"
import { ProjectArtifactStore } from "../project-artifact"
import { ProjectArtifactSource } from "../project-artifact/source"
import { SessionGuardrail } from "../session/guardrail"
import { Tool } from "./tool"

export const name = "project_artifact"

const Common = {
  id: ProjectArtifact.ID,
  insight_key: Schema.String.check(Schema.isNonEmpty()),
  base_version_id: ProjectArtifact.VersionID.pipe(Schema.optional),
  scope: Schema.Never.pipe(Schema.optional),
  projectID: Schema.Never.pipe(Schema.optional),
  sessionID: Schema.Never.pipe(Schema.optional),
  agentID: Schema.Never.pipe(Schema.optional),
  now: Schema.Never.pipe(Schema.optional),
  global: Schema.Never.pipe(Schema.optional),
  promote: Schema.Never.pipe(Schema.optional),
  delete: Schema.Never.pipe(Schema.optional),
  disable: Schema.Never.pipe(Schema.optional),
  enable: Schema.Never.pipe(Schema.optional),
  revert: Schema.Never.pipe(Schema.optional),
  permissions: Schema.Never.pipe(Schema.optional),
  mode: Schema.Never.pipe(Schema.optional),
  subtask: Schema.Never.pipe(Schema.optional),
  model: Schema.Never.pipe(Schema.optional),
  agent: Schema.Never.pipe(Schema.optional),
}

export const Input = Schema.Union([
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("skill"),
    name: ProjectArtifact.DisplayName,
    description: ProjectArtifact.Description,
    content: ProjectArtifact.SkillContent,
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("command"),
    name: ProjectArtifact.DisplayName,
    description: ProjectArtifact.Description,
    template: ProjectArtifact.CommandTemplate,
  }),
  Schema.Struct({
    ...Common,
    kind: Schema.Literal("agent"),
    name: ProjectArtifact.DisplayName,
    description: ProjectArtifact.Description,
    system: ProjectArtifact.AgentSystem,
    permissions: ProjectArtifact.AgentDefinition.fields.permissions.pipe(Schema.optional),
  }),
]).pipe(Schema.toTaggedUnion("kind"))

export const Output = Schema.Struct({
  result: ProjectArtifact.AutomaticWriteResult,
  kind: ProjectArtifact.Kind,
  id: ProjectArtifact.ID,
  versionID: ProjectArtifact.VersionID,
  contentDigest: ProjectArtifact.Digest,
  stage: Schema.Literal("trial"),
  remaining: Schema.Struct({
    session: Schema.Number,
    projectDaily: Schema.Number,
    projectArtifacts: Schema.Number,
    versions: Schema.Number,
    bytes: Schema.Number,
  }),
})

export const description =
  "At a safe boundary after the primary task is complete and validated, record at most one repeated durable repository-specific insight for future work. Never record transient state, preferences, prompts, logs, secrets, credentials, private paths/URLs, customer data, or speculation. Search and update an owned artifact instead of duplicating it; prefer a skill, use an instruction-only command or least-privilege agent only when necessary, and never create a plugin."

export const Plugin = {
  id: "ycoding.tool.project-artifact",
  effect: Effect.fn("ProjectArtifactTool.Plugin")(function* (ctx: PluginContext) {
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const guardrail = yield* SessionGuardrail.Service
    const store = yield* ProjectArtifactStore.Service
    const source = yield* ProjectArtifactSource.Service
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: `${output.result}: ${output.kind}/${output.id} (${output.stage}); remaining session ${output.remaining.session}, project ${output.remaining.projectArtifacts}`,
              },
            ],
            execute: (input, context) =>
              Effect.gen(function* () {
                if (location.project.id === Project.ID.global)
                  return yield* new ToolFailure({ message: "Project artifact requires a stable project identity" })
                const decision = yield* permission.evaluateEffective({
                  sessionID: context.sessionID,
                  agent: context.agent,
                  action: name,
                  resource: input.id,
                }).pipe(Effect.mapError(() => new ToolFailure({ message: "Project artifact permission could not be evaluated" })))
                if (decision === "deny") return yield* new ToolFailure({ message: "Project artifact is denied" })
                const definition =
                  input.kind === "skill"
                    ? { kind: "skill" as const, name: input.name, description: input.description, content: input.content }
                    : input.kind === "command"
                      ? { kind: "command" as const, name: input.name, description: input.description, template: input.template, subtask: false as const }
                      : {
                          kind: "agent" as const,
                          name: input.name,
                          description: input.description,
                          system: input.system,
                          mode: "subagent" as const,
                          permissions: input.permissions ?? [],
                        }
                const reservation = yield* guardrail
                  .assert({
                    sessionID: context.sessionID,
                    action: "project_artifact_mutation",
                    resources: [`${input.kind}/${input.id}`],
                    metadata: { operation: "automatic_write" },
                  })
                  .pipe(
                    Effect.mapError(
                      (error) => new ToolFailure({ message: "Session guardrail rejected project artifact mutation", error }),
                    ),
                  )
                const result = yield* store
                  .writeAutomatic({
                    projectID: location.project.id,
                    sessionID: context.sessionID,
                    agentID: context.agent,
                    insightKey: input.insight_key,
                    id: input.id,
                    definition,
                    baseVersionID: input.base_version_id,
                  })
                  .pipe(
                    Effect.mapError(() => new ToolFailure({ message: "Project artifact write was rejected" })),
                    Effect.ensuring(reservation.release),
                  )
                yield* source.refresh()
                return {
                  result: result.result,
                  kind: result.kind,
                  id: result.id,
                  versionID: result.versionID,
                  contentDigest: result.contentDigest,
                  stage: result.stage,
                  remaining: result.remaining,
                }
              }),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}
