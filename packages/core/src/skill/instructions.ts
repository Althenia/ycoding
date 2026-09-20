export * as SkillInstructions from "./instructions"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { SkillV2 } from "../skill"
import { Instructions } from "../instructions/index"
import { optional } from "@ycoding-ai/schema/schema"

const Summary = Schema.Struct({
  id: SkillV2.ID,
  name: SkillV2.Name,
  description: Schema.String,
  // Present only for MCP-served skills. The extension requires the originating server to be visible to
  // the model, and requires names to be resolved within a per-origin namespace.
  server: Schema.String.pipe(optional),
})
type Summary = typeof Summary.Type

/**
 * Skill names and descriptions are remote-authored text placed in the model's context inside XML-shaped
 * markup, so every interpolated value is escaped. An unescaped name could close the element and inject
 * sibling instructions.
 */
const escapeXML = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")

const entries = (skills: ReadonlyArray<Summary>) =>
  skills.flatMap((skill) => [
    "  <skill>",
    `    <id>${escapeXML(skill.id)}</id>`,
    `    <name>${escapeXML(skill.name)}</name>`,
    `    <description>${escapeXML(skill.description)}</description>`,
    ...(skill.server === undefined ? [] : [`    <origin>${escapeXML(skill.server)}</origin>`]),
    "  </skill>",
  ])

const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : ["<available_skills>", ...entries(skills), "</available_skills>"]),
  ].join("\n")

const update = (previous: ReadonlyArray<Summary>, current: ReadonlyArray<Summary>) => {
  const diff = Instructions.diffByKey(
    previous,
    current,
    (skill) => skill.id,
    (before, after) => before.name !== after.name || before.description !== after.description,
  )
  // Additions and removals render as small deltas; anything else restates the full list.
  if (diff.changed.length > 0 || (diff.added.length === 0 && diff.removed.length === 0))
    return [
      "The available skills have changed. This list supersedes the previous available skills list.",
      render(current),
    ].join("\n")
  return [
    ...(diff.added.length === 0
      ? []
      : ["New skills are available in addition to those previously listed:", ...entries(diff.added)]),
    ...(diff.removed.length === 0
      ? []
      : [
          `The following skill IDs are no longer available and must not be used: ${diff.removed.map((skill) => skill.id).join(", ")}.`,
        ]),
  ].join("\n")
}

export interface Interface {
  readonly load: (agent: AgentV2.Selection) => Effect.Effect<Instructions.Instructions>
}

/**
 * Renders the catalog prompt for given summaries. Exported so the escaping and origin-tagging rules
 * are verifiable without assembling a full instruction source.
 */
export const renderForTest = (skills: ReadonlyArray<Summary>) => render(skills)

export class Service extends Context.Service<Service, Interface>()("@ycoding/v2/SkillInstructions") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service

    return Service.of({
      load: Effect.fn("SkillInstructions.load")(function* (selection) {
        const agent = selection.info
        if (!agent) return Instructions.empty
        const permitted = SkillV2.available(yield* skills.list(), agent)
        const available = permitted.flatMap((skill) =>
          skill.description === undefined || skill.autoinvoke === false
            ? []
            : [{ id: skill.id, name: skill.name, description: skill.description }],
        )
        // MCP-served skills are advertised from their listings alone. The entry's name and description
        // are remote-authored text, so they are escaped at render and tagged with their origin.
        const mcpAvailable = SkillV2.available(yield* skills.mcp(), agent).map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          server: skill.server,
        }))
        const all = [...available, ...mcpAvailable].toSorted((a, b) => a.id.localeCompare(b.id))
        return Instructions.make<ReadonlyArray<Summary>>({
          key: Instructions.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          read: Effect.succeed(all.length === 0 ? Instructions.removed : all),
          render: {
            initial: render,
            changed: update,
            removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
          },
        })
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node] })
