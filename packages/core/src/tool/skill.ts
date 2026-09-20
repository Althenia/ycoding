export * as SkillTool from "./skill"

import type { Context as PluginContext } from "@ycoding-ai/plugin/effect/plugin"
import { Buffer } from "node:buffer"
import path from "path"
import { ToolFailure } from "@ycoding-ai/ai"
import { McpSkill } from "@ycoding-ai/schema/mcp-skill"
import { Effect, Option, Schema } from "effect"
import { ConfigMarkdown } from "../config/markdown"
import { FSUtil } from "../fs-util"
import { MCP } from "../mcp"
import { MCPSkills } from "../mcp/skills"
import { SkillV2 } from "../skill"
import { PermissionV2 } from "../permission"
import { SessionMessage } from "../session/message"
import { ProjectArtifactSource } from "../project-artifact/source"
import { Tool } from "./tool"

export const name = "skill"
const FILE_LIMIT = 10

export const Input = Schema.Struct({
  id: SkillV2.ID.annotate({ description: "The ID of the skill from the available skills list" }),
  /**
   * Optional supporting-file selector. Relative references resolve against the skill's root, exactly as
   * on a filesystem. Only ever read from the held, digest-verified manifest for the skill's current
   * content-bound approval.
   */
  resource: Schema.String.pipe(
    Schema.optional,
    Schema.annotate({ description: "Optional supporting file path relative to the skill's root" }),
  ),
})

export const Output = Schema.Struct({
  name: SkillV2.Name,
  directory: Schema.String,
  output: Schema.String,
  alreadyActive: Schema.Boolean.pipe(Schema.optional),
  conflicts: SkillV2.Conflicts.pipe(Schema.optional),
  /**
   * The exact MCP entry held for a loaded skill. Durable activation derives this snapshot from the
   * completed tool message; it is not a second registry.
   */
  entry: McpSkill.Entry.pipe(Schema.optional),
})

export const description = [
  "Load a specialized skill when the task at hand matches one of the available skills in the instructions.",
  "",
  "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.",
  "",
  "The skill ID must match one of the available skills in the instructions.",
].join("\n")

export const toModelOutput = (skill: SkillV2.Info, files: ReadonlyArray<string>) => {
  const directory = path.dirname(skill.location)
  return [
    `<skill_content name="${escapeXML(skill.name)}">`,
    `# Skill: ${escapeXML(skill.name)}`,
    "",
    skill.content.trim(),
    "",
    `Base directory for this skill: ${escapeXML(directory)}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${escapeXML(file)}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

const resourceFailure = (name: string, resource: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to read ${resource} for skill ${name}`, error })

/** Renders a loaded MCP skill, tagging the origin so the model can attribute the instructions. */
const toMcpModelOutput = (entry: McpSkill.Entry, body: string, files: ReadonlyArray<string>) =>
  [
    `<skill_content name="${escapeXML(entry.frontmatter.name)}" origin="${escapeXML(entry.server)}">`,
    `# Skill: ${escapeXML(entry.frontmatter.name)}`,
    "",
    body.trim(),
    "",
    `Base directory for this skill: ${escapeXML(entry.uri.replace(/\/SKILL\.md$/, ""))}`,
    `This skill is served over MCP by "${escapeXML(entry.server)}". Relative paths in this skill (e.g., scripts/, reference/) are relative to the base directory above and are read with the skill tool's resource input.`,
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${escapeXML(file)}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")

const escapeXML = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

/**
 * Loads an MCP-served skill. The approval is content-bound to the entry's manifest and is asserted
 * before any byte is fetched; the loaded `SKILL.md` is then verified against that manifest and its
 * parsed frontmatter compared against the held entry before anything reaches the model.
 */
const loadMcpSkill = (
  services: {
    readonly mcp: MCP.Interface
    readonly permission: PermissionV2.Interface
  },
  id: SkillV2.ID,
  entry: McpSkill.Entry,
  context: {
    readonly sessionID: Parameters<PermissionV2.Interface["assert"]>[0]["sessionID"]
    readonly agent: Parameters<PermissionV2.Interface["assert"]>[0]["agent"]
    readonly messageID: string
    readonly callID: string
  },
) =>
  Effect.gen(function* () {
    if (entry.resources === "dynamic") return yield* unableToLoad(id, new Error("dynamic MCP skill"))
    // Content-bound approval: the resource is the digest-derived identity of the manifest the user is
    // approving. A changed manifest yields a different resource and therefore a fresh decision.
    const resource = MCPSkills.identity(entry)
    yield* services.permission
      .assert({
        action: name,
        resources: [id, resource],
        save: [id, resource],
        metadata: { server: entry.server, uri: entry.uri, manifest: entry.resources },
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, callID: context.callID },
      })
      .pipe(Effect.mapError((error) => unableToLoad(id, error)))
    // Bytes are fetched only after approval, and only from the held manifest.
    const file = yield* services.mcp
      .readSkillResource({ server: entry.server, entry, uri: entry.uri })
      .pipe(Effect.mapError((error) => unableToLoad(id, error)))
    const text = "text" in file ? file.text : decodeText(file.blob)
    if (text === undefined) return yield* unableToLoad(id, new Error("SKILL.md is not UTF-8 text"))
    const parsed = ConfigMarkdown.parseOption(text)
    const verified = MCPSkills.frontmatter(entry, parsed?.data)
    if (!verified.ok) return yield* unableToLoad(id, new Error(`skill frontmatter ${verified.reason}`))
    const files = entry.resources
      .filter((item) => item.uri !== entry.uri)
      .map((item) => item.uri.slice(entry.uri.replace(/\/SKILL\.md$/, "").length + 1))
      .toSorted()
      .slice(0, FILE_LIMIT)
    return {
      name: SkillV2.Name.make(entry.frontmatter.name),
      directory: "",
      output: toMcpModelOutput(entry, parsed?.content ?? "", files),
      entry,
    }
  })

/**
 * Reads one supporting file of an already-active MCP skill. The manifest comes from the durable
 * activation record, so the read stays bound to the manifest the user approved, and it is verified
 * against that manifest's digest and size. Nothing is downloaded to disk and nothing is executed.
 */
const readMcpResource = (
  services: {
    readonly mcp: MCP.Interface
    readonly permission: PermissionV2.Interface
  },
  id: SkillV2.ID,
  reference: string,
  messages: ReadonlyArray<SessionMessage.Info>,
  context: {
    readonly sessionID: Parameters<PermissionV2.Interface["assert"]>[0]["sessionID"]
    readonly agent: Parameters<PermissionV2.Interface["assert"]>[0]["agent"]
    readonly messageID: string
    readonly callID: string
  },
) =>
  Effect.gen(function* () {
    const origin = SkillV2.mcpSkillOrigin(id)
    if (!origin) return yield* unableToLoad(id)
    const { SessionSkillStatus } = yield* Effect.promise(() => import("../session/skill-status"))
    const activation = SessionSkillStatus.mcpActivation(messages, id)
    if (!activation || activation.entry.server !== origin.server || activation.entry.uri !== origin.uri)
      return yield* unableToLoad(id)
    const verified = MCPSkills.entry(origin.server, activation.entry)
    if (!verified.ok) return yield* unableToLoad(id, new Error(`held entry ${verified.reason}`))
    const entry = verified.entry
    if (entry.resources === "dynamic") return yield* unableToLoad(id, new Error("dynamic MCP skill"))
    const uri = MCPSkills.resolve(entry, reference)
    if (uri === undefined) return yield* resourceFailure(id, reference)
    const resource = MCPSkills.identity(entry)
    yield* services.permission
      .assert({
        action: name,
        resources: [id, resource],
        save: [id, resource],
        metadata: { server: entry.server, uri: entry.uri, manifest: entry.resources },
        sessionID: context.sessionID,
        agent: context.agent,
        source: { type: "tool", messageID: context.messageID, callID: context.callID },
      })
      .pipe(Effect.mapError((error) => resourceFailure(id, reference, error)))
    const file = yield* services.mcp
      .readSkillResource({ server: origin.server, entry, uri })
      .pipe(Effect.mapError((error) => resourceFailure(id, reference, error)))
    return {
      name: activation.status.name,
      directory: "",
      output: renderMcpResource(file),
      alreadyActive: true,
    }
  })

const decodeText = (blob: string | undefined) => {
  if (blob === undefined) return undefined
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(blob, "base64"))
  } catch {
    return undefined
  }
}

const renderMcpResource = (file: McpSkill.File) => {
  const attributes = [
    `uri="${escapeXML(file.uri)}"`,
    ...(file.mimeType ? [`mime_type="${escapeXML(file.mimeType)}"`] : []),
    ...("blob" in file ? ['encoding="base64"'] : []),
  ].join(" ")
  return [`<skill_resource ${attributes}>`, "text" in file ? file.text : file.blob, "</skill_resource>"].join("\n")
}

export const Plugin = {
  id: "ycoding.tool.skill",
  effect: Effect.fn("SkillTool.Plugin")(function* (ctx: PluginContext) {
    const { PluginRuntime } = yield* Effect.promise(() => import("../plugin/runtime"))
    const fs = yield* FSUtil.Service
    const skills = yield* SkillV2.Service
    const mcp = yield* MCP.Service
    const permission = yield* PermissionV2.Service
    const projectArtifactSource = yield* Effect.serviceOption(ProjectArtifactSource.Service)
    const runtime = yield* PluginRuntime.Service
    yield* ctx.tool
      .transform((draft) =>
        draft.add(
          name,
          Tool.make({
            description,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const messages = yield* runtime.session
                  .messages({ sessionID: context.sessionID })
                  .pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
                const { SessionSkillStatus } = yield* Effect.promise(() => import("../session/skill-status"))
                const statuses = SessionSkillStatus.list(messages, [])
                const active = statuses.find((status) => status.id === input.id && status.state === "active")
                // A supporting-resource read never reactivates: the skill is already loaded, and its
                // content-bound approval was established when it was. The resource is served from the
                // manifest held at that approval, so metadata changes cannot slip content in.
                if (input.resource !== undefined) {
                  if (!active) return yield* unableToLoad(input.id)
                  return yield* readMcpResource({ mcp, permission }, input.id, input.resource, messages, context)
                }
                const origin = SkillV2.mcpSkillOrigin(input.id)
                if (origin) {
                  const entry = yield* mcp
                    .getSkill({ server: origin.server, uri: origin.uri })
                    .pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
                  if (entry.resources === "dynamic")
                    return yield* unableToLoad(input.id, new Error("dynamic MCP skill"))
                  const activation = SessionSkillStatus.mcpActivation(messages, input.id)
                  if (activation && MCPSkills.identity(activation.entry) === MCPSkills.identity(entry))
                    return {
                      name: activation.status.name,
                      directory: "",
                      output: `Skill ${activation.status.name} is already active for this session.`,
                      alreadyActive: true,
                    }
                  return yield* loadMcpSkill({ mcp, permission }, input.id, entry, context)
                }
                if (active)
                  return {
                    name: active.name,
                    directory: "",
                    output: `Skill ${active.name} is already active for this session.`,
                    alreadyActive: true,
                  }
                const current = yield* skills.list()
                const skill = current.find((skill) => skill.id === input.id)
                if (!skill) return yield* unableToLoad(input.id)
                return yield* Effect.gen(function* () {
                  yield* permission.assert({
                    action: name,
                    resources: [skill.id],
                    save: [skill.id],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.messageID, callID: context.callID },
                  })
                  const directory = path.dirname(skill.location)
                  const files =
                    path.basename(skill.location) === "SKILL.md"
                      ? (yield* fs.scan("**/*", { cwd: directory, absolute: true, include: "file", dot: true }))
                          .filter((file) => path.basename(file) !== "SKILL.md")
                          .toSorted()
                          .slice(0, FILE_LIMIT)
                      : []
                  if (Option.isSome(projectArtifactSource))
                    yield* projectArtifactSource.value
                      .activate({
                        kind: "skill",
                        id: skill.id,
                        sessionID: context.sessionID,
                        agentID: context.agent,
                        source: "skill-tool",
                        messageID: context.messageID,
                        callID: context.callID,
                      })
                      .pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning("project artifact skill activation failed", {
                            cause,
                            sessionID: context.sessionID,
                          }),
                        ),
                      )
                  return {
                    name: skill.name,
                    directory,
                    output: toModelOutput(skill, files),
                    conflicts: skill.conflicts,
                  }
                }).pipe(Effect.mapError((error) => unableToLoad(input.id, error)))
              }),
          }),
          { codemode: false },
        ),
      )
      .pipe(Effect.orDie)
  }),
}
