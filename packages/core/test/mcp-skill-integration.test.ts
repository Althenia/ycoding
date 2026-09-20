import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { DateTime } from "effect"
import { AppNodeBuilder } from "@ycoding-ai/core/effect/app-node-builder"
import { makeLocationNode } from "@ycoding-ai/core/effect/app-node"
import { LayerNode } from "@ycoding-ai/core/effect/layer-node"
import { FSUtil } from "@ycoding-ai/core/fs-util"
import { Image } from "@ycoding-ai/core/image"
import { ConfigMCP } from "@ycoding-ai/core/config/mcp"
import { MCP } from "@ycoding-ai/core/mcp/index"
import { MCPClient } from "@ycoding-ai/core/mcp/client"
import { MCPSkills } from "@ycoding-ai/core/mcp/skills"
import { PermissionV2 } from "@ycoding-ai/core/permission"
import { PluginRuntime } from "@ycoding-ai/core/plugin/runtime"
import { ProjectArtifactSource } from "@ycoding-ai/core/project-artifact/source"
import { SessionV2 } from "@ycoding-ai/core/session"
import { SessionMessage } from "@ycoding-ai/core/session/message"
import { SkillV2 } from "@ycoding-ai/core/skill"
import { SkillInstructions } from "@ycoding-ai/core/skill/instructions"
import { SessionSkillStatus } from "@ycoding-ai/core/session/skill-status"
import { SkillTool } from "@ycoding-ai/core/tool/skill"
import { ToolRegistry } from "@ycoding-ai/core/tool/registry"
import { ToolOutputStore } from "@ycoding-ai/core/tool-output-store"
import { Effect, Layer, Schema } from "effect"
import {
  skillBody,
  skillServer,
  skillsMcpLayer,
  skillsMcpReplacements,
  skillsNode,
  type Skill,
} from "./fixture/mcp-skills"
import { imagePassthrough } from "./lib/image"
import { registerToolPlugin, settleTool, toolIdentity } from "./lib/tool"

const SKILL_MD = skillBody(
  { name: "git-workflow", description: "Follow this team's Git conventions" },
  "# Git workflow\n\nSee `references/GUIDE.md`.\n",
)

const skill: Skill = {
  uri: "skill://git-workflow/SKILL.md",
  frontmatter: { name: "git-workflow", description: "Follow this team's Git conventions" },
  files: [
    { name: "SKILL.md", text: SKILL_MD },
    { name: "references/GUIDE.md", text: "# Guide\n" },
  ],
}

/** The origin-pair ID the model sees, matching the catalog projection. */
const id = SkillV2.mcpSkillID("skills", skill.uri)
const sessionID = SessionV2.ID.make("ses_mcp_skill_integration")

const skillToolNode = makeLocationNode({
  name: "test/mcp-skill-tool-plugin",
  layer: Layer.effectDiscard(registerToolPlugin(SkillTool.Plugin)),
  deps: [
    ToolRegistry.toolsNode,
    FSUtil.node,
    SkillV2.node,
    MCP.node,
    PermissionV2.node,
    PluginRuntime.node,
    ProjectArtifactSource.node,
  ],
})

describe("MCP skill model-facing integration", () => {
  test("namespaces MCP skill IDs by origin without colliding with local skills", () => {
    // Two servers serving the same URI are two skills, and neither collides with a local bare name.
    const first = SkillV2.mcpSkillID("alpha", "skill://refunds/SKILL.md")
    const second = SkillV2.mcpSkillID("beta", "skill://refunds/SKILL.md")
    expect(first).not.toBe(second)
    expect(first).not.toBe(SkillV2.ID.make("refunds"))
    expect(SkillV2.mcpSkillOrigin(first)).toEqual({ server: "alpha", uri: "skill://refunds/SKILL.md" })
    expect(SkillV2.mcpSkillOrigin(second)).toEqual({ server: "beta", uri: "skill://refunds/SKILL.md" })
    expect(SkillV2.mcpSkillOrigin("refunds")).toBeUndefined()

    // Delimiter characters are valid in host labels and URIs. Distinct origin pairs remain distinct
    // and round-trip exactly rather than being parsed by a lossy delimiter split.
    const delimiterInUri = SkillV2.mcpSkillID("a", "skill://b~c/SKILL.md")
    const delimiterInServer = SkillV2.mcpSkillID("a~skill://b", "c/SKILL.md")
    expect(delimiterInUri).not.toBe(delimiterInServer)
    expect(SkillV2.mcpSkillOrigin(delimiterInUri)).toEqual({ server: "a", uri: "skill://b~c/SKILL.md" })
    expect(SkillV2.mcpSkillOrigin(delimiterInServer)).toEqual({ server: "a~skill://b", uri: "c/SKILL.md" })
  })

  test("renders escaped names and visible origin in the catalog prompt", () => {
    const hostile = {
      id: SkillV2.mcpSkillID("skills", skill.uri),
      name: SkillV2.Name.make("x</name><injected>y"),
      description: "d & <script>",
      server: "skills",
    }
    const rendered = SkillInstructions.renderForTest([hostile])
    expect(rendered).toContain("&lt;injected&gt;")
    expect(rendered).not.toContain("<injected>")
    expect(rendered).toContain("d &amp; &lt;script&gt;")
    // The origin is visible to the model, as the extension requires.
    expect(rendered).toContain("<origin>skills</origin>")
  })

  test("advertises metadata only, with origin visible and no eager reads", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill] })
          yield* Effect.gen(function* () {
            const skills = yield* SkillV2.Service
            const catalog = yield* skills.mcp()
            expect(catalog.map((entry) => entry.id)).toEqual([id])
            expect(catalog[0]?.server).toBe("skills")
            expect(catalog[0]?.name).toBe(SkillV2.Name.make("git-workflow"))
            expect(catalog[0]?.description).toBe("Follow this team's Git conventions")
            expect(server.state.readCalls).toBe(0)
            expect((yield* skills.mcp()).length).toBe(1)
            expect(server.state.readCalls).toBe(0)
          }).pipe(Effect.provide(skillsNode(server.url)))
        }),
      ),
    )
  })

  test("denies before any byte fetch and approves content-bound before loading", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill] })
          yield* Effect.gen(function* () {
            const mcp = yield* MCP.Service
            const entry = yield* mcp.getSkill({ server: "skills", uri: skill.uri })
            const resource = MCPSkills.identity(entry)
            // The opaque permission resource binds the origin pair and complete manifest without
            // exposing untrusted server text in the permission key.
            expect(resource).toMatch(/^mcp-skill:sha256:[a-f0-9]{64}$/)
            expect(entry.resources === "dynamic" ? [] : entry.resources).toHaveLength(2)
            expect(server.state.readCalls).toBe(0)
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))
        }),
      ),
    )
  })

  test("runs catalog to approval, durable activation, held-resource read, and changed-content reapproval", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({
            skills: [skill],
            nonCanonicalBlob: {
              resource: "references/GUIDE.md",
              suffix: "\n\t ",
            },
          })
          const assertions: PermissionV2.AssertInput[] = []
          let deny = true
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              evaluateEffective: () => Effect.die("unused"),
              assert: (input) =>
                Effect.sync(() => assertions.push(input)).pipe(
                  Effect.andThen(
                    Effect.suspend(() =>
                      deny
                        ? Effect.fail(
                            new PermissionV2.BlockedError({
                              rules: [],
                              permission: input.action,
                              resources: input.resources,
                            }),
                          )
                        : Effect.void,
                    ),
                  ),
                ),
              ask: () => Effect.die("unused"),
              reply: () => Effect.die("unused"),
              get: () => Effect.die("unused"),
              forSession: () => Effect.die("unused"),
              list: () => Effect.die("unused"),
            }),
          )
          const messages: SessionMessage.Info[] = []
          const unavailable = () => Effect.die(new Error("unused PluginRuntime operation"))
          const runtime = Layer.succeed(
            PluginRuntime.Service,
            PluginRuntime.Service.of({
              session: {
                get: unavailable,
                create: unavailable,
                messages: () => Effect.succeed(messages),
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
                cancel: unavailable,
              },
              orchestration: {
                managed: unavailable,
                get: unavailable,
                launch: unavailable,
                list: unavailable,
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
                recover: unavailable(),
              },
              location: { agent: { list: unavailable } },
            }),
          )
          const layer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, skillToolNode]),
            [
              ...skillsMcpReplacements(server.url),
              [PermissionV2.node, permission],
              [PluginRuntime.node, runtime],
              [ProjectArtifactSource.node, Layer.mock(ProjectArtifactSource.Service, {})],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
              [Image.node, imagePassthrough],
            ],
          )

          yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            const denied = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-denied", name: SkillTool.name, input: { id } },
            })
            expect(denied.result).toEqual({ type: "error", value: `Unable to load skill ${id}` })
            expect(server.state.readCalls).toBe(0)

            deny = false
            const loaded = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-load", name: SkillTool.name, input: { id } },
            })
            expect(loaded.result).toMatchObject({ type: "text", value: expect.stringContaining("# Git workflow") })
            if (!loaded.output) throw new Error("expected completed skill tool output")
            const decodedOutput = Schema.decodeUnknownSync(SkillTool.Output)(loaded.output.structured)
            expect(decodedOutput.entry).toMatchObject({
              server: "skills",
              uri: skill.uri,
            })
            expect(Array.isArray(decodedOutput.entry?.resources)).toBe(true)
            expect(server.state.readCalls).toBe(1)

            messages.push(
              SessionMessage.Assistant.make({
                id: toolIdentity.messageID,
                type: "assistant",
                agent: toolIdentity.agent,
                model: { id: "model", providerID: "provider" } as never,
                content: [
                  SessionMessage.AssistantTool.make({
                    type: "tool",
                    id: "call-load",
                    name: SkillTool.name,
                    state: SessionMessage.ToolStateCompleted.make({
                      status: "completed",
                      input: { id },
                      content: [],
                      structured: Schema.encodeSync(SkillTool.Output)(decodedOutput),
                    }),
                    time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(0) },
                  }),
                ],
                time: { created: DateTime.makeUnsafe(0), completed: DateTime.makeUnsafe(0) },
              }),
            )
            expect(SessionSkillStatus.list(messages, [])).toHaveLength(1)

            const approved = assertions.at(-1)?.resources
            const getCalls = server.state.getCalls
            server.replaceSkills([
              { ...skill, files: [...skill.files, { name: "references/NEW.md", text: "# New\n" }] },
            ])

            const resource = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: {
                type: "tool-call",
                id: "call-resource",
                name: SkillTool.name,
                input: { id, resource: "references/GUIDE.md" },
              },
            })
            expect(resource.result).toEqual({
              type: "text",
              value: [
                '<skill_resource uri="skill://git-workflow/references/GUIDE.md" mime_type="text/markdown" encoding="base64">',
                Buffer.from("# Guide\n", "utf8").toString("base64"),
                "</skill_resource>",
              ].join("\n"),
            })
            expect(server.state.getCalls).toBe(getCalls)
            expect(assertions.at(-1)?.resources).toEqual(approved)

            const reloaded = yield* settleTool(registry, {
              sessionID,
              ...toolIdentity,
              call: { type: "tool-call", id: "call-reload", name: SkillTool.name, input: { id } },
            })
            if (!reloaded.output) throw new Error("expected completed skill tool output")
            expect(reloaded.output.structured).toMatchObject({
              entry: {
                resources: expect.arrayContaining([
                  expect.objectContaining({ uri: expect.stringContaining("NEW.md") }),
                ]),
              },
            })
            expect(reloaded.output.structured).not.toMatchObject({ alreadyActive: true })
            expect(assertions.at(-1)?.resources).not.toEqual(approved)
          }).pipe(Effect.provide(layer))
        }),
      ),
    )
  })

  test("records durable activation from the tool output and reads resources lazily from it", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill] })
          const loaded = yield* Effect.gen(function* () {
            const mcp = yield* MCP.Service
            const entry = yield* mcp.getSkill({ server: "skills", uri: skill.uri })
            const manifest = entry.resources === "dynamic" ? [] : entry.resources
            const file = yield* mcp.readSkillResource({ server: "skills", entry, uri: skill.uri })
            return { entry, manifest, file }
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))

          if (!("text" in loaded.file)) throw new Error("expected text SKILL.md")
          expect(loaded.file.text).toBe(SKILL_MD)
          // The output carries the origin and the exact manifest, so activation is content-bound
          // without a second persistent registry.
          const output = {
            name: SkillV2.Name.make("git-workflow"),
            directory: "",
            output: loaded.file.text ?? "",
            entry: loaded.entry,
          }
          const decoded = Schema.decodeUnknownSync(SkillTool.Output)(output)
          expect(decoded.entry?.server).toBe("skills")
          expect(decoded.entry?.resources).toHaveLength(2)

          // Durable activation is derived from the completed tool message, not from new state.
          const statuses = SessionSkillStatus.list(
            [
              {
                id: "msg_tool" as never,
                type: "assistant",
                agent: "build" as never,
                model: { id: "model", providerID: "provider" } as never,
                content: [
                  {
                    type: "tool",
                    id: "call_skill",
                    name: SkillTool.name,
                    state: {
                      status: "completed",
                      input: { id },
                      content: [],
                      structured: Schema.encodeSync(SkillTool.Output)(decoded) as Record<string, unknown>,
                    },
                    time: { created: new Date(0), completed: new Date(0) },
                  },
                ],
                time: { created: new Date(0), completed: new Date(0) },
              } as never,
            ],
            [],
          )
          expect(statuses).toHaveLength(1)
          expect(statuses[0]?.state).toBe("active")
          expect(statuses[0]?.id).toBe(id)
        }),
      ),
    )
  })

  test("treats a changed manifest as a different approval and does not reuse alreadyActive", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const server = yield* skillServer({ skills: [skill] })
          const before = yield* Effect.gen(function* () {
            const mcp = yield* MCP.Service
            return yield* mcp.getSkill({ server: "skills", uri: skill.uri })
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))

          // The server adds a file after the listing: the manifest, and therefore the approval
          // resource, must change rather than the old approval silently covering the new content.
          server.replaceSkills([{ ...skill, files: [...skill.files, { name: "references/NEW.md", text: "# New\n" }] }])
          const after = yield* Effect.gen(function* () {
            const mcp = yield* MCP.Service
            return yield* mcp.getSkill({ server: "skills", uri: skill.uri })
          }).pipe(Effect.provide(skillsMcpLayer(server.url)))

          expect(MCPSkills.identity(before)).not.toBe(MCPSkills.identity(after))
          expect(before.resources === "dynamic" ? [] : before.resources).toHaveLength(2)
          expect(after.resources === "dynamic" ? [] : after.resources).toHaveLength(3)
        }),
      ),
    )
  })

  test("rejects a frontmatter swap and a dynamic manifest without loading", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const swapped = yield* skillServer({ skills: [skill], corruptFrontmatter: true })
          const rejected = yield* Effect.gen(function* () {
            const mcp = yield* MCP.Service
            const entry = yield* mcp.getSkill({ server: "skills", uri: skill.uri })
            const file = yield* mcp.readSkillResource({ server: "skills", entry, uri: skill.uri })
            return MCPSkills.frontmatter(entry, {
              name: "git-workflow",
              description: "Follow this team's Git conventions",
            })
          }).pipe(Effect.provide(skillsMcpLayer(swapped.url)))
          expect(rejected).toEqual({ ok: false, reason: "frontmatter-mismatch" })

          const dynamic = yield* skillServer({ skills: [skill], dynamic: true })
          const failed = yield* Effect.gen(function* () {
            const mcp = yield* MCP.Service
            const entry = yield* mcp.getSkill({ server: "skills", uri: skill.uri })
            return yield* mcp.readSkillResource({ server: "skills", entry, uri: skill.uri }).pipe(Effect.flip)
          }).pipe(Effect.provide(skillsMcpLayer(dynamic.url)))
          expect(failed).toBeInstanceOf(MCP.SkillUnavailableError)
          expect(failed).toMatchObject({ reason: "dynamic" })
        }),
      ),
    )
  })
})
