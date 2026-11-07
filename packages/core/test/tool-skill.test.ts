import fs from "fs/promises"
import path from "path"
import { pathToFileURL } from "url"
import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { Config } from "@ycoding-ai/core/config"
import { ConfigCapabilities } from "@ycoding-ai/core/config/capabilities"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { Location } from "@ycoding-ai/core/location"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { Permission } from "@ycoding-ai/core/permission"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { AbsolutePath } from "@ycoding-ai/core/schema"
import { Session } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { Agent } from "@ycoding-ai/core/agent"
import { CatalogModel } from "@ycoding-ai/core/model"
import { Provider } from "@ycoding-ai/core/provider"
import { Skill } from "@ycoding-ai/core/skill"
import { SkillDiscovery } from "@ycoding-ai/core/skill/discovery"
import { SkillTool } from "@ycoding-ai/core/tool/skill"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { location as testLocation } from "./fixture/location"
import { Image } from "@ycoding-ai/core/image"
import { it } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { ProjectArtifactSource } from "@ycoding-ai/core/project-artifact/source"
import { LocationMutation } from "@ycoding-ai/core/location-mutation"
import { ReadToolFileSystem } from "@ycoding-ai/core/tool/read-filesystem"
import { toolIdentity, executeTool, registerToolPlugin, settleTool, toolDefinitions } from "./lib/tool"

const skillToolNode = makeLocationNode({
  name: "test/skill-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [
    ToolRegistry.toolsNode,
    Config.node,
    FSUtil.node,
    Skill.node,
    MCP.node,
    Permission.node,
    PluginRuntime.node,
    ProjectArtifactSource.node,
    LocationMutation.node,
    ReadToolFileSystem.node,
  ],
})

const sessionID = Session.ID.make("ses_skill_tool_test")

describe("SkillTool", () => {
  it.live("lists available skills, authorizes the selected ID, and loads model-facing content", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const external = yield* Effect.acquireRelease(
            Effect.promise(() => tmpdir()),
            (dir) => Effect.promise(() => dir[Symbol.asyncDispose]()),
          )
          const directory = path.join(tmp.path, "effect")
          const location = path.join(directory, "SKILL.md")
          const reference = path.join(directory, "reference.md")
          const outside = path.join(tmp.path, "outside.md")
          const link = path.join(directory, "link.md")
          const large = path.join(directory, "large.txt")
          const externalSkillFile = path.join(external.path, "SKILL.md")
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(location, "unused"),
              fs.writeFile(reference, "reference"),
              fs.writeFile(outside, "outside secret"),
              fs.symlink(outside, link),
              fs.writeFile(large, "x".repeat(51 * 1024)),
              fs.writeFile(externalSkillFile, "external skill file"),
              fs.writeFile(path.join(external.path, "reference.md"), "external reference"),
            ]),
          )

          const info: Skill.Info = {
            id: Skill.ID.make("effect"),
            name: Skill.Name.make("Effect"),
            description: "Use Effect",
            conflicts: {
              skills: [Skill.ID.make("other")],
              instructions: [],
            },
            location: AbsolutePath.make(location),
            content: "# Effect\n\nGuidance",
          }
          let current = [info]
          let active = false
          let compacted = false
          let activations: SessionMessage.Info[] | undefined
          let capabilities: ConfigCapabilities.Info | undefined
          const config = Layer.mock(Config.Service, {
            entries: () =>
              Effect.sync(() => [new Config.Document({ type: "document", info: new Config.Info({ capabilities }) })]),
          })
          const assertions: Permission.AssertInput[] = []
          const sourceActivations: Parameters<ProjectArtifactSource.Interface["activate"]>[0][] = []
          let permissionFailure: "denied" | "corrected" | "cancelled" | undefined
          let deniedAction: string | undefined
          const authorize = (input: Permission.AssertInput): Effect.Effect<void, Permission.Error> => {
            if (permissionFailure === "denied" && (deniedAction === undefined || deniedAction === input.action))
              return Effect.fail(
                new Permission.BlockedError({
                  rules: [],
                  permission: input.action,
                  resources: input.resources,
                }),
              )
            if (permissionFailure === "corrected")
              return Effect.fail(new Permission.CorrectedError({ feedback: "Use another skill" }))
            if (permissionFailure === "cancelled") return Effect.interrupt
            return Effect.void
          }
          const permission = Layer.succeed(
            Permission.Service,
            Permission.Service.of({
              deferPending: () => Effect.void,
              evaluateEffective: () => Effect.die(new Error("unused Permission.evaluateEffective")),
              assert: (input) =>
                Effect.sync(() => {
                  expect(input.metadata?.operationDigest).toMatch(/^[a-f0-9]{64}$/)
                  assertions.push(input)
                }).pipe(Effect.asVoid, Effect.andThen(Effect.suspend(() => authorize(input)))),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              replyDelegated: () => Effect.die("unused"),
              delegatedEligible: () => Effect.die("unused"),
              snapshot: () => Effect.die("unused"),
              snapshots: () => Effect.die("unused"),
              reconsider: () => Effect.die("unused"),
              escalate: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          )
          const skills = Layer.succeed(
            Skill.Service,
            Skill.Service.of({
              transform: (_transform) => Effect.die("unused"),
              reload: () => Effect.die("unused"),
              sources: () => Effect.die("unused"),
              list: () => Effect.succeed(current),
              mcp: () => Effect.succeed([]),
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
                messages: (input) => {
                  const chronological = active
                    ? [
                        SessionMessage.Compaction.make({
                          id: SessionMessage.ID.make("msg_compaction_before_skill"),
                          type: "compaction",
                          status: "completed",
                          reason: "auto",
                          summary: "Earlier work",
                          recent: "Recent work",
                          time: { created: DateTime.makeUnsafe(0) },
                        }),
                        ...(activations ??
                          current.map((skill) =>
                            SessionMessage.Skill.make({
                              id: SessionMessage.ID.make(`msg_active_${skill.id}`),
                              type: "skill",
                              skill: skill.id,
                              name: skill.name,
                              text: skill.content,
                              directory: path.dirname(skill.location),
                              conflicts: skill.conflicts,
                              time: { created: DateTime.makeUnsafe(0) },
                            }),
                          )),
                        ...(compacted
                          ? [
                              SessionMessage.Compaction.make({
                                id: SessionMessage.ID.make("msg_compaction_after_skill"),
                                type: "compaction",
                                status: "completed",
                                reason: "auto",
                                summary: "Compacted skills",
                                recent: "Recent work",
                                time: { created: DateTime.makeUnsafe(1) },
                              }),
                            ]
                          : []),
                      ]
                    : []
                  return Effect.succeed(input.order === "asc" ? chronological : chronological.toReversed())
                },
                prompt: unavailable,
                generate: unavailable,
                command: unavailable,
                resume: unavailable,
                interrupt: unavailable,
                synthetic: unavailable,
                compact: unavailable,
              },
              job: {
                start: unavailable,
                wait: unavailable,
                block: unavailable,
                background: unavailable,
                noticeAdmitted: unavailable,
                cancel: unavailable,
              },
              orchestration: {
                managed: unavailable,
                get: unavailable,
                launch: unavailable,
                switchModel: unavailable,
                list: unavailable,
                questionSnapshots: unavailable,
                reconsiderQuestion: unavailable,
                page: () =>
                  Effect.succeed({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} }),
                send: unavailable,
                answer: unavailable,
                cancel: unavailable,
                resume: unavailable,
                progress: unavailable,
                question: unavailable,
                settle: unavailable,
                background: unavailable,
                teamView: unavailable,
                notice: unavailable,
                recover: unavailable(),
                resolveRecovery: unavailable,
              },
              location: { agent: { list: unavailable } },
            }),
          )
          const skillToolLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, skillToolNode, FSUtil.node]),
            [
              [Permission.node, permission],
              [Config.node, config],
              [Skill.node, skills],
              [MCP.node, Layer.mock(MCP.Service, {})],
              [
                Location.node,
                Layer.succeed(
                  Location.Service,
                  Location.Service.of(testLocation({ directory: AbsolutePath.make(tmp.path) })),
                ),
              ],
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
              value: SkillTool.toModelOutput(info, [large, link, reference]),
            })
            expect(SkillTool.toModelOutput(info, [reference])).toContain(`Base directory for this skill: ${directory}`)
            expect(SkillTool.toModelOutput(info, [reference])).toContain(
              "Read supporting files with the skill tool's resource input",
            )
            expect(
              yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-skill-overflow", name: "skill", input: { id: "effect" } },
              }),
            ).toMatchObject({
              result: { type: "text", value: SkillTool.toModelOutput(info, [large, link, reference]) },
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
            capabilities = new ConfigCapabilities.Info({ skills: { deny: ["effect"] } })
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({ type: "error", value: "Unable to load skill effect" })
            expect(assertions).toHaveLength(2)
            capabilities = undefined
            active = true
            expect(
              yield* executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: "call-active-skill", name: "skill", input: { id: "effect" } },
              }),
            ).toEqual({ type: "text", value: "Skill Effect is already active for this session." })
            const resourceCall = (resource: string, id = "effect") =>
              executeTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: `call-resource-${resource}`, name: "skill", input: { id, resource } },
              })
            expect(yield* resourceCall("reference.md")).toEqual({
              type: "text",
              value: `<skill_resource uri="${pathToFileURL(reference).href}" mime_type="text/markdown">\nreference\n</skill_resource>`,
            })
            expect(yield* resourceCall(reference)).toEqual({
              type: "text",
              value: `<skill_resource uri="${pathToFileURL(reference).href}" mime_type="text/markdown">\nreference\n</skill_resource>`,
            })
            for (const resource of ["../outside.md", link]) {
              expect(yield* resourceCall(resource)).toEqual({
                type: "error",
                value: `Unable to read ${resource} for skill effect`,
              })
            }
            expect(assertions.filter((item) => item.action === "read")).toHaveLength(2)
            expect(yield* resourceCall(".")).toEqual({ type: "error", value: "Unable to read . for skill effect" })
            expect(yield* resourceCall("large.txt")).toMatchObject({
              type: "text",
              value: expect.stringContaining("... (line truncated to 2000 chars)"),
            })
            permissionFailure = "denied"
            expect(yield* resourceCall("reference.md")).toEqual({
              type: "error",
              value: "Unable to read reference.md for skill effect",
            })
            permissionFailure = undefined
            expect(assertions.at(-1)).toMatchObject({ action: "read", resources: ["effect/reference.md"] })
            const externalInfo: Skill.Info = {
              ...info,
              id: Skill.ID.make("external"),
              name: Skill.Name.make("External"),
              location: AbsolutePath.make(externalSkillFile),
            }
            current = [info, externalInfo]
            permissionFailure = "denied"
            expect(yield* resourceCall("reference.md", "external")).toEqual({
              type: "error",
              value: "Unable to read reference.md for skill external",
            })
            expect(assertions.at(-1)).toMatchObject({ action: "external_directory" })
            permissionFailure = undefined
            expect(yield* resourceCall("reference.md", "external")).toEqual({
              type: "text",
              value: `<skill_resource uri="${pathToFileURL(path.join(external.path, "reference.md")).href}" mime_type="text/markdown">\nexternal reference\n</skill_resource>`,
            })
            expect(assertions.slice(-2)).toMatchObject([
              {
                action: "external_directory",
                resources: [path.join(external.path, "*")],
                save: [path.join(external.path, "*")],
              },
              { action: "read", resources: [path.join(external.path, "reference.md")], save: ["*"] },
            ])
            const resources = [
              { id: "keeper-vault-retrieval", resource: "references/session-discovery.md" },
              { id: "go-developer", resource: "references/go-project-patterns.md" },
            ]
            const homeRoot = path.join(external.path, "home", ".agents", "skills")
            const workspaceRoot = path.join(tmp.path, "workspace", ".agents", "skills")
            yield* Effect.promise(async () => {
              await fs.mkdir(homeRoot, { recursive: true })
              for (const fixture of resources) {
                const physical = path.join(external.path, ".dots", "skills", fixture.id)
                const shadow = path.join(workspaceRoot, fixture.id)
                await fs.mkdir(path.join(physical, "references"), { recursive: true })
                await fs.mkdir(shadow, { recursive: true })
                await fs.writeFile(
                  path.join(physical, "SKILL.md"),
                  `---\nname: ${fixture.id}\ndescription: Synthetic home skill\n---\nHome guidance`,
                )
                await fs.writeFile(path.join(physical, fixture.resource), `Synthetic ${fixture.id} reference`)
                await fs.writeFile(
                  path.join(shadow, "SKILL.md"),
                  `---\nname: ${fixture.id}\ndescription: Synthetic workspace skill\n---\nWorkspace guidance`,
                )
                await fs.symlink(physical, path.join(homeRoot, fixture.id), "dir")
                await fs.symlink(
                  path.join(physical, fixture.resource),
                  path.join(physical, "references", "contained.md"),
                )
                await fs.symlink(outside, path.join(physical, "references", "escape.md"))
              }
            })
            const catalogs = yield* Effect.gen(function* () {
              const resolver = yield* Skill.Service
              yield* resolver.transform((draft) =>
                draft.source({ type: "directory", path: AbsolutePath.make(homeRoot) }),
              )
              const home = yield* resolver.list()
              yield* resolver.transform((draft) =>
                draft.source({ type: "directory", path: AbsolutePath.make(workspaceRoot) }),
              )
              return { home, workspace: yield* resolver.list() }
            }).pipe(
              Effect.provide(
                AppNodeBuilder.build(Skill.node, [
                  [Config.node, config],
                  [MCP.node, Layer.mock(MCP.Service, {})],
                  [SkillDiscovery.node, Layer.mock(SkillDiscovery.Service, {})],
                ]),
              ),
            )
            expect(catalogs.home).toHaveLength(2)
            expect(catalogs.workspace).toHaveLength(2)
            const filesystem = yield* FSUtil.Service
            current = catalogs.home
            for (const fixture of resources) {
              const base = path.join(homeRoot, fixture.id)
              const physical = path.join(external.path, ".dots", "skills", fixture.id, fixture.resource)
              const selected = current.find((skill) => skill.id === fixture.id)!
              expect(selected.location).toBe(AbsolutePath.make(path.join(base, "SKILL.md")))
              expect(selected.content).toBe("Home guidance")
              expect(yield* SkillTool.instructions(filesystem, selected)).toContain(
                `Base directory for this skill: ${base}`,
              )
              for (const resource of [fixture.resource, path.join(base, fixture.resource), "references/contained.md"]) {
                const count = assertions.length
                const result = yield* settleTool(registry, {
                  sessionID,
                  ...toolIdentity,
                  call: {
                    type: "tool-call",
                    id: `call-home-${fixture.id}-${resource}`,
                    name: "skill",
                    input: { id: fixture.id, resource },
                  },
                })
                expect(result).toMatchObject({
                  result: {
                    type: "text",
                    value: `<skill_resource uri="${pathToFileURL(physical).href}" mime_type="text/markdown">\nSynthetic ${fixture.id} reference\n</skill_resource>`,
                  },
                  output: { structured: { alreadyActive: true } },
                })
                expect(assertions.slice(count)).toMatchObject([
                  { action: "external_directory", resources: [path.join(path.dirname(physical), "*")] },
                  { action: "read", resources: [physical], sessionID, agent: toolIdentity.agent },
                ])
              }
              for (const resource of [
                `${fixture.id}/${fixture.resource}`,
                "references/missing.md",
                "../outside.md",
                path.join(base, "..", `${fixture.id}-sibling`, "reference.md"),
                physical,
                "references/escape.md",
              ]) {
                const count = assertions.length
                expect(yield* resourceCall(resource, fixture.id)).toEqual({
                  type: "error",
                  value: `Unable to read ${resource} for skill ${fixture.id}`,
                })
                expect(assertions).toHaveLength(count)
              }
              const malformed = `${fixture.id}/${fixture.resource}`
              const count = assertions.length
              expect(yield* resourceCall(fixture.resource, malformed)).toEqual({
                type: "error",
                value: `Unable to load skill ${malformed}`,
              })
              expect(assertions).toHaveLength(count)
              for (const action of ["external_directory", "read"]) {
                deniedAction = action
                permissionFailure = "denied"
                const count = assertions.length
                expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual({
                  type: "error",
                  value: `Unable to read ${fixture.resource} for skill ${fixture.id}`,
                })
                expect(assertions.slice(count).map((item) => item.action)).toEqual(
                  action === "external_directory" ? ["external_directory"] : ["external_directory", "read"],
                )
              }
              deniedAction = undefined
              permissionFailure = undefined
              compacted = true
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual({
                type: "error",
                value: `Unable to load skill ${fixture.id}`,
              })
              compacted = false
              active = false
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual({
                type: "error",
                value: `Unable to load skill ${fixture.id}`,
              })
              active = true
            }
            current = catalogs.workspace
            for (const fixture of resources) {
              const selected = current.find((skill) => skill.id === fixture.id)!
              expect(selected.location).toBe(AbsolutePath.make(path.join(workspaceRoot, fixture.id, "SKILL.md")))
              expect(selected.content).toBe("Workspace guidance")
              expect(yield* SkillTool.instructions(filesystem, selected)).toContain(
                `Base directory for this skill: ${path.dirname(selected.location)}`,
              )
              const count = assertions.length
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual({
                type: "error",
                value: `Unable to read ${fixture.resource} for skill ${fixture.id}`,
              })
              expect(assertions).toHaveLength(count)
            }
            for (const fixture of resources) {
              const loaded = catalogs.home.find((skill) => skill.id === fixture.id)!
              const base = path.dirname(loaded.location)
              const physical = path.join(external.path, ".dots", "skills", fixture.id, fixture.resource)
              yield* Effect.promise(async () => {
                await fs.mkdir(path.join(workspaceRoot, fixture.id, "references"), { recursive: true })
                await fs.writeFile(path.join(workspaceRoot, fixture.id, fixture.resource), "Replacement source content")
              })
              const expected = {
                type: "text" as const,
                value: `<skill_resource uri="${pathToFileURL(physical).href}" mime_type="text/markdown">\nSynthetic ${fixture.id} reference\n</skill_resource>`,
              }
              current = catalogs.home
              active = false
              const activation = yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: `call-bind-${fixture.id}`, name: "skill", input: { id: fixture.id } },
              })
              expect(activation.output?.structured).toMatchObject({ directory: base })
              const loadedOutput = Schema.decodeUnknownSync(SkillTool.Output)(activation.output?.structured)
              const toolMessage = SessionMessage.Assistant.make({
                id: SessionMessage.ID.make(`msg_loaded_${fixture.id}`),
                type: "assistant",
                agent: Agent.defaultID,
                model: CatalogModel.Ref.make({
                  id: CatalogModel.ID.make("synthetic"),
                  providerID: Provider.ID.make("synthetic"),
                }),
                time: { created: DateTime.makeUnsafe(0) },
                content: [
                  SessionMessage.AssistantTool.make({
                    id: `call-bind-${fixture.id}`,
                    name: "skill",
                    type: "tool",
                    time: { created: DateTime.makeUnsafe(0) },
                    state: SessionMessage.ToolStateCompleted.make({
                      input: { id: fixture.id },
                      content: [],
                      structured: { ...loadedOutput },
                    }),
                  }),
                ],
              })
              active = true
              activations = [toolMessage]
              current = catalogs.workspace
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual(expected)
              current = []
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual(expected)
              capabilities = new ConfigCapabilities.Info({ skills: { deny: [fixture.id] } })
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual({
                type: "error",
                value: `Unable to load skill ${fixture.id}`,
              })
              capabilities = undefined
              activations = [
                SessionMessage.Skill.make({
                  id: SessionMessage.ID.make(`msg_explicit_${fixture.id}`),
                  skill: loaded.id,
                  name: loaded.name,
                  text: SkillTool.toModelOutput(loaded, []),
                  directory: base,
                  time: { created: DateTime.makeUnsafe(0) },
                }),
              ]
              current = catalogs.workspace
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual(expected)
              for (const directory of [undefined, "", "relative/skill", "\0invalid"]) {
                activations = [
                  SessionMessage.Skill.make({
                    id: SessionMessage.ID.make(`msg_unproven_${fixture.id}`),
                    skill: loaded.id,
                    name: loaded.name,
                    text: SkillTool.toModelOutput(loaded, []),
                    ...(directory === undefined ? {} : { directory }),
                    time: { created: DateTime.makeUnsafe(0) },
                  }),
                ]
                const count = assertions.length
                expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual({
                  type: "error",
                  value: `Unable to read ${fixture.resource} for skill ${fixture.id}: the active skill has no usable source directory. Complete compaction or switch agents, then load the skill again.`,
                })
                expect(assertions).toHaveLength(count)
              }
              expect(
                yield* executeTool(registry, {
                  sessionID,
                  ...toolIdentity,
                  call: {
                    type: "tool-call",
                    id: `call-duplicate-${fixture.id}`,
                    name: "skill",
                    input: { id: fixture.id },
                  },
                }),
              ).toEqual({ type: "text", value: `Skill ${fixture.id} is already active for this session.` })
              activations = [toolMessage]
              compacted = true
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual({
                type: "error",
                value: `Unable to load skill ${fixture.id}`,
              })
              current = catalogs.home
              const reload = yield* settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id: `call-reload-${fixture.id}`, name: "skill", input: { id: fixture.id } },
              })
              expect(reload.output?.structured).toMatchObject({ directory: base })
              expect(reload.output?.structured).not.toHaveProperty("alreadyActive")
              compacted = false
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual(expected)
              activations = [
                {
                  ...SessionMessage.Skill.make({
                    id: SessionMessage.ID.make(`msg_missing_source_${fixture.id}`),
                    skill: loaded.id,
                    name: loaded.name,
                    text: loaded.content,
                    time: { created: DateTime.makeUnsafe(0) },
                  }),
                  directory: path.join(external.path, "missing-root", fixture.id),
                },
              ]
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual({
                type: "error",
                value: `Unable to read ${fixture.resource} for skill ${fixture.id}`,
              })
              activations = [toolMessage]
              const retargeted = path.join(external.path, ".dots", "retargeted", fixture.id)
              yield* Effect.promise(async () => {
                await fs.mkdir(path.join(retargeted, "references"), { recursive: true })
                await fs.writeFile(path.join(retargeted, fixture.resource), "Retargeted source content")
                await fs.symlink(outside, path.join(retargeted, "references", "escape.md"))
                await fs.rename(base, `${base}-original`)
                await fs.symlink(retargeted, base, "dir")
              })
              expect(yield* resourceCall(fixture.resource, fixture.id)).toEqual({
                type: "text",
                value: `<skill_resource uri="${pathToFileURL(path.join(retargeted, fixture.resource)).href}" mime_type="text/markdown">\nRetargeted source content\n</skill_resource>`,
              })
              expect(assertions.at(-1)).toMatchObject({
                action: "read",
                resources: [path.join(retargeted, fixture.resource)],
              })
              expect(yield* resourceCall("references/escape.md", fixture.id)).toEqual({
                type: "error",
                value: `Unable to read references/escape.md for skill ${fixture.id}`,
              })
            }
            activations = undefined
            current = [info, externalInfo]
            active = false
            expect(yield* resourceCall("reference.md")).toEqual({ type: "error", value: "Unable to load skill effect" })
            expect(yield* resourceCall("reference.md", "missing")).toEqual({
              type: "error",
              value: "Unable to load skill missing",
            })
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
            const flat = Skill.Info.make({
              id: Skill.ID.make("public"),
              name: Skill.Name.make("Public"),
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
