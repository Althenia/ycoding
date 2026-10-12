import { Effect, Option, Schema } from "effect"
import { sql } from "drizzle-orm"
import type { Database } from "../database/database"
import { McpSkill } from "@ycoding-ai/schema/mcp-skill"
import { Conflict, Info, State } from "@ycoding-ai/schema/session-skill-status"
import { Skill } from "../skill"
import { SkillTool } from "../tool/skill"
import { SessionMessage } from "./message"
import type { SessionSchema } from "./schema"
import { MessageDecodeError } from "./error"

export { Conflict, Info, State } from "@ycoding-ai/schema/session-skill-status"

const emptyDeclarations = { skills: [], instructions: [] } as const satisfies Skill.Conflicts

type StatusMessage =
  | Pick<SessionMessage.Skill, "type" | "id" | "skill" | "name" | "text" | "conflicts" | "skillDeactivations">
  | Pick<SessionMessage.Assistant, "type" | "id" | "content" | "skillDeactivations">
  | { readonly type: Exclude<SessionMessage.Info["type"], "skill" | "assistant" | "compaction"> }
  | { readonly type: "compaction"; readonly status: SessionMessage.Compaction["status"] }

const skillSnapshot = Schema.Struct({
  skill: SessionMessage.Skill.fields.skill,
  name: SessionMessage.Skill.fields.name,
  text: SessionMessage.Skill.fields.text,
  conflicts: SessionMessage.Skill.fields.conflicts,
  skillDeactivations: SessionMessage.Skill.fields.skillDeactivations,
})
const toolSnapshot = Schema.Array(SessionMessage.AssistantTool)
const deactivations = Schema.Array(SessionMessage.SkillDeactivation)

export function list(messages: ReadonlyArray<SessionMessage.Info>, instructionKeys: ReadonlyArray<string>): Info[] {
  const statuses = messages.reduce<Map<Skill.ID, Info>>(fold, new Map())
  return conflicts(statuses, instructionKeys)
}

function fold(result: Map<Skill.ID, Info>, message: StatusMessage) {
  const applyDeactivations = (deactivations: readonly SessionMessage.SkillDeactivation[] | undefined) =>
    deactivations?.forEach((deactivation) => {
      const status = result.get(deactivation.skill)
      if (status)
        result.set(deactivation.skill, {
          ...status,
          state: "inactive",
          inactiveReason: deactivation.reason,
        })
    })
  if (message.type === "skill") {
    result.set(message.skill, {
      id: message.skill,
      name: message.name,
      state: "active",
      activatedBy: "reference",
      activationMessageID: message.id,
      content: message.text,
      conflicts: [],
      declarations: message.conflicts ?? emptyDeclarations,
    })
    applyDeactivations(message.skillDeactivations)
    return result
  }
  if (message.type === "assistant") {
    message.content
      .filter((content): content is SessionMessage.AssistantTool => content.type === "tool")
      .forEach((tool) => {
        if (tool.name !== SkillTool.name || tool.state.status !== "completed") return
        const input = Option.getOrUndefined(Schema.decodeUnknownOption(SkillTool.Input)(tool.state.input))
        const output = Option.getOrUndefined(Schema.decodeUnknownOption(SkillTool.Output)(tool.state.structured))
        if (!input || !output || output.alreadyActive) return
        result.set(input.id, {
          id: input.id,
          name: output.name,
          state: "active",
          activatedBy: "tool",
          activationMessageID: message.id,
          content: output.output,
          conflicts: [],
          declarations: output.conflicts ?? emptyDeclarations,
        })
      })
    applyDeactivations(message.skillDeactivations)
    return result
  }
  const inactiveReason =
    message.type === "agent-switched"
      ? "agent_switched"
      : message.type === "compaction" && message.status === "completed"
        ? "compacted"
        : undefined
  if (inactiveReason)
    result.forEach((status, skillID) => {
      result.set(skillID, { ...status, state: "inactive", inactiveReason })
    })
  return result
}

function conflicts(statuses: Map<Skill.ID, Info>, instructionKeys: ReadonlyArray<string>) {
  const active = [...statuses.values()].filter((status) => status.state === "active")
  const activeByID = new Map(active.map((status) => [status.id, status]))
  const inbound = active
    .flatMap((status) => status.declarations.skills.map((target) => ({ source: status.id, target })))
    .reduce<Map<Skill.ID, Set<Skill.ID>>>((result, declaration) => {
      const sources = result.get(declaration.target) ?? new Set<Skill.ID>()
      sources.add(declaration.source)
      result.set(declaration.target, sources)
      return result
    }, new Map())
  const instructions = new Set(instructionKeys)

  return [...statuses.values()].map((status) => {
    if (status.state !== "active") return { ...status, conflicts: [] }
    const skillConflicts = [...new Set([...status.declarations.skills, ...(inbound.get(status.id) ?? [])])].flatMap(
      (skillID) => {
        const target = activeByID.get(skillID)
        return target && skillID !== status.id ? [{ type: "skill" as const, id: skillID, name: target.name }] : []
      },
    )
    const instructionConflicts = status.declarations.instructions.flatMap((instructionID) =>
      instructions.has(instructionID) ? [{ type: "instruction" as const, id: instructionID, name: instructionID }] : [],
    )
    return { ...status, conflicts: [...skillConflicts, ...instructionConflicts] }
  })
}

export const load = Effect.fn("SessionSkillStatus.load")(function* (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
  instructionKeys: ReadonlyArray<string> = [],
) {
  const statuses = new Map<Skill.ID, Info>()
  let after = -1
  while (true) {
    const rows = yield* db
      .all<{ id: string; type: string; seq: number; data: string | null; tools: string; deactivations: string | null }>(
        sql`
      SELECT id, type, seq,
        CASE WHEN type = 'skill' THEN json_patch('{}', json_object(
          'skill', json_extract(data, '$.skill'), 'name', json_extract(data, '$.name'),
          'text', json_extract(data, '$.text'), 'conflicts', json_extract(data, '$.conflicts'),
          'skillDeactivations', json_extract(data, '$.skillDeactivations'))) END AS data,
        CASE WHEN type = 'assistant' THEN (
          SELECT coalesce(json_group_array(json_object(
            'type', 'tool', 'id', json_extract(tool.value, '$.id'), 'name', 'skill',
            'state', json_object('status', 'completed', 'input', json_extract(tool.value, '$.state.input'),
              'structured', json_extract(tool.value, '$.state.structured'), 'content', json('[]')),
            'time', json_extract(tool.value, '$.time'))), '[]')
          FROM json_each(data, '$.content') AS tool
          WHERE json_extract(tool.value, '$.type') = 'tool'
            AND json_extract(tool.value, '$.name') = 'skill'
            AND json_extract(tool.value, '$.state.status') = 'completed'
        ) ELSE '[]' END AS tools,
        json_extract(data, '$.skillDeactivations') AS deactivations
      FROM session_message
      WHERE session_id = ${sessionID} AND seq > ${after}
        AND (type IN ('skill', 'agent-switched')
          OR (type = 'compaction' AND json_extract(data, '$.status') = 'completed')
          OR (type = 'assistant' AND (json_array_length(data, '$.skillDeactivations') > 0
            OR EXISTS (SELECT 1 FROM json_each(data, '$.content') AS tool
              WHERE json_extract(tool.value, '$.type') = 'tool'
                AND json_extract(tool.value, '$.name') = 'skill'
                AND json_extract(tool.value, '$.state.status') = 'completed'))))
      ORDER BY seq ASC LIMIT 200
    `,
      )
      .pipe(Effect.orDie)
    for (const row of rows) {
      const decode = <S extends Schema.Top>(schema: S, value: string) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(value).pipe(
          Effect.mapError(() => new MessageDecodeError({ sessionID, messageID: SessionMessage.ID.make(row.id) })),
        )
      if (row.type === "skill") {
        const snapshot = yield* decode(skillSnapshot, row.data!)
        fold(statuses, { ...snapshot, id: SessionMessage.ID.make(row.id), type: "skill" })
        continue
      }
      if (row.type === "assistant") {
        fold(statuses, {
          type: "assistant",
          id: SessionMessage.ID.make(row.id),
          content: yield* decode(toolSnapshot, row.tools),
          ...(row.deactivations === null
            ? {}
            : { skillDeactivations: yield* decode(deactivations, row.deactivations) }),
        })
        continue
      }
      fold(
        statuses,
        row.type === "agent-switched" ? { type: "agent-switched" } : { type: "compaction", status: "completed" },
      )
    }
    if (rows.length < 200) return conflicts(statuses, instructionKeys)
    after = rows.at(-1)!.seq
  }
})

export type MCPActivation = {
  readonly status: Info
  readonly entry: McpSkill.Entry
}

/** Returns the held MCP entry from the durable tool message that established the active skill. */
export function mcpActivation(messages: ReadonlyArray<SessionMessage.Info>, id: Skill.ID): MCPActivation | undefined {
  const status = list(messages, []).find((candidate) => candidate.id === id && candidate.state === "active")
  if (!status || status.activatedBy !== "tool") return undefined
  const message = messages.find(
    (candidate): candidate is SessionMessage.Assistant =>
      candidate.type === "assistant" && candidate.id === status.activationMessageID,
  )
  if (!message) return undefined
  for (const content of message.content.toReversed()) {
    if (content.type !== "tool" || content.name !== SkillTool.name || content.state.status !== "completed") continue
    const input = Option.getOrUndefined(Schema.decodeUnknownOption(SkillTool.Input)(content.state.input))
    const output = Option.getOrUndefined(Schema.decodeUnknownOption(SkillTool.Output)(content.state.structured))
    if (input?.id !== id || output?.alreadyActive || !output?.entry) continue
    return { status, entry: output.entry }
  }
  return undefined
}

export const SessionSkillStatus = { Conflict, Info, State, list, load, mcpActivation }
