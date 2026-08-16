import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { SkillTool } from "@ycoding-ai/core/tool/skill"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { Image } from "@ycoding-ai/core/image"
import { it } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { ProjectArtifactSource } from "@ycoding-ai/core/project-artifact/source"
import { toolIdentity, executeTool, registerToolPlugin, settleTool, toolDefinitions } from "./lib/tool"

const skillToolNode = makeLocationNode({
  name: "test/skill-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [
    ToolRegistry.toolsNode,
    FSUtil.node,
    SkillV2.node,
    PermissionV2.node,
    PluginRuntime.node,
    ProjectArtifactSource.node,
  ],
})

const sessionID = SessionV2.ID.make("ses_skill_tool_test")

describe("SkillTool", () => {
  it.live("lists available skills, authorizes the selected ID, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([fs.writeFile(location, "unused"), fs.writeFile(reference, "reference")]),
          )

          const info: SkillV2.Info = {
            id: SkillV2.ID.make("effect"),
            name: SkillV2.Name.make("Effect"),
            description: "Use Effect",
            conflicts: {
              skills: [SkillV2.ID.make("other")],
              instructions: [],
            },
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          let active = false
          const assertions: PermissionV2.AssertInput[] = []
          const sourceActivations: Parameters<ProjectArtifactSource.Interface["activate"]>[0][] = []
          let permissionFailure: "denied" | "corrected" | "cancelled" | undefined
          const authorize = (input: PermissionV2.AssertInput): Effect.Effect<void, PermissionV2.Error> => {
            if (permissionFailure === "denied")
              return Effect.fail(
                new PermissionV2.BlockedError({
                  rules: [],
                  permission: input.action,
                  resources: input.resources,
                }),
              )
            if (permissionFailure === "corrected")
              return Effect.fail(new PermissionV2.CorrectedError({ feedback: "Use another skill" }))
            if (permissionFailure === "cancelled") return Effect.interrupt
            return Effect.void
          }
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              evaluateEffective: () => Effect.die(new Error("unused PermissionV2.evaluateEffective")),
              assert: (input) =>
                Effect.sync(() => assertions.push(input)).pipe(Effect.asVoid, Effect.andThen(Effect.suspend(() => authorize(input)))),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          )
          const skills = Layer.succeed(
            SkillV2.Service,
            SkillV2.Service.of({
              transform: (_transform) => Effect.die("unused"),
              reload: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              list: () => Effect.succeed(current),
            }),
          )
          const source = Layer.mock(ProjectArtifactSource.Service, {
            refresh: () => Effect.void,
            provenance: () => Effect.succeed(undefined),
            activate: (input) =>
              Effect.sync(() => {
                if (input.id === "effect") sourceActivations.push(input)
              }),
          })
          const unavailable = () => Effect.die(new Error("unused PluginRuntime operation"))
          const runtime = Layer.succeed(
            PluginRuntime.Service,
            PluginRuntime.Service.of({
              session: {
                get: unavailable,
                create: unavailable,
                messages: () =>
                  Effect.succeed(
                    active
                      ? [
                          SessionMessage.Skill.make({
                            id: SessionMessage.ID.make("msg_active_skill"),
                            type: "skill",
                            skill: info.id,
                            name: info.name,
                            text: info.content,
                            conflicts: info.conflicts,
                            time: { created: DateTime.makeUnsafe(0) },
                          }),
                        ]
                      : [],
                  ),
                prompt: unavailable,
                generate: unavailable,
                command: unavailable,
                resume: unavailable,
                interrupt: unavailable,
                synthetic: unavailable,
              },
              job: {
                start: unavailable,
                wait: unavailable,
                block: unavailable,
                background: unavailable,
                cancel: unavailable,
              },
              orchestration: {
                managed: unavailable,
                get: unavailable,
                launch: unavailable,
                list: unavailable,
                send: unavailable,
                answer: unavailable,
                cancel: unavailable,
                resume: unavailable,
                progress: unavailable,
                question: unavailable,
                settle: unavailable,
                background: unavailable,
                teamView: unavailable,
                recover: unavailable(),
              },
              location: { agent: { list: unavailable } },
            }),
          )
          const skillToolLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, skillToolNode]),
            [
              [PermissionV2.node, permission],
              [SkillV2.node, skills],
              [PluginRuntime.node, runtime],
              [ProjectArtifactSource.node, source],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              [Image.node, imagePassthrough],
            ],
          )

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill",
              description: SkillTool.description,
            })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({
              type: "text",
              value: SkillTool.toModelOutput(info, [reference]),
            })
            expect(SkillTool.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(
              yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { id: "effect" } },
              }),
            ).toMatchObject({
              result: { type: "text", value: SkillTool.toModelOutput(info, [reference]) },
              output: {
                structured: {
                  name: "Effect",
                  conflicts: { skills: ["other"], instructions: [] },
                },
              },
            })
            expect(assertions).toMatchObject([
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
              { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
            ])
            active = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-active-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({ type: "text", value: "Skill Effect is already active for this session." })
            expect(assertions).toHaveLength(2)
            active = false
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { id: "missing" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill missing" })
            permissionFailure = "denied"
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill effect" })
            expect(sourceActivations).toHaveLength(2)
            permissionFailure = "corrected"
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-corrected-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill effect" })
            expect(sourceActivations).toHaveLength(2)
            permissionFailure = "cancelled"
            expect(
              (yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-cancelled-skill", name: "skill", input: { id: "effect" } },
              }).pipe(Effect.exit))._tag,
            ).toBe("Failure")
            expect(sourceActivations).toHaveLength(2)
            permissionFailure = undefined
            const flat = SkillV2.Info.make({
              id: SkillV2.ID.make("public"),
              name: SkillV2.Name.make("Public"),
              description: "Public guidance",
              location: AbsolutePath.make(path.join(tmp.path, "public.md")),
              content: "Public",
            })
            yield* Effect.promise(() =>
              Promise.all([
                fs.writeFile(flat.location, "public"),
                fs.writeFile(path.join(tmp.path, "secret.md"), "secret"),
              ]),
            )
            current = [flat]
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-flat-skill", name: "skill", input: { id: "public" } },
              }),
            ).toEqual({ type: "text", value: SkillTool.toModelOutput(flat, []) })
          }).pipe(Effect.provide(skillToolLayer))
        }),
      ),
    ),
  )
})
