export * as ModelGuidanceInstructions from "./instructions"

import { Instruction } from "@ycoding-ai/schema/instruction"
import type { Model } from "@ycoding-ai/schema/model"
import { Clock, Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import type { Database } from "../database/database"
import { Instructions } from "../instructions/index"

type Db = Pick<Database.Interface["db"], "all">

export const WINDOW_MILLIS = 30 * 86_400_000
export const THRESHOLD = 2
export const MAX_LINES = 5
export const MAX_BYTES = 1024
export const MAX_ROWS = 10_000

export interface Row {
  readonly requestID: string
  readonly ruleIDs: ReadonlyArray<string>
}

const custom = "custom"

const lines: Readonly<Record<string, string>> = {
  "standard.review.outside-repo":
    "Outside-repository changes (standard.review.outside-repo): Respect approved paths and required approval checks for outside-repository mutations.",
  "standard.review.git-destructive":
    "Destructive Git (standard.review.git-destructive): Prefer reversible Git commands and retain required approval checks.",
  "standard.review.force-push":
    "Force push (standard.review.force-push): Do not force-push unless the task requires it; retain required approval checks.",
  "standard.review.project-deletion":
    "Project deletion (standard.review.project-deletion): Confirm the target and pass required approval checks before deleting a project or its ancestors.",
  "standard.review.home-child":
    "Home-directory deletion (standard.review.home-child): Confirm the target and pass required approval checks before deleting a direct child of the home directory.",
  "standard.review.database-destructive":
    "Destructive database statements (standard.review.database-destructive): Use scoped statements and pass required approval checks before destructive database changes.",
  [custom]: "Custom guardrail rules (custom): Review configured guardrail rules before repeating a blocked action.",
}

const header = "<model-guidance>\nPast guardrail reviews stopped some of this model's actions:"
const footer = "</model-guidance>"

export const retraction = "Earlier <model-guidance> notes no longer apply."

export function render(rows: ReadonlyArray<Row>): string | undefined {
  const requests = new Map<string, Set<string>>()
  for (const row of rows)
    for (const ruleID of row.ruleIDs) {
      const key = Object.hasOwn(lines, ruleID) ? ruleID : custom
      const group = requests.get(key) ?? new Set<string>()
      group.add(row.requestID)
      requests.set(key, group)
    }
  const selected = [...requests]
    .filter(([, group]) => group.size >= THRESHOLD)
    .toSorted(([left, a], [right, b]) => b.size - a.size || (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, MAX_LINES)
    .map(([ruleID]) => `- ${lines[ruleID]}`)
  return Array.from({ length: selected.length }, (_, index) =>
    [header, ...selected.slice(0, selected.length - index), footer].join("\n"),
  ).find((candidate) => Buffer.byteLength(candidate) <= MAX_BYTES)
}

const decodeRuleIDs = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.String)))

export const rows = Effect.fn("ModelGuidanceInstructions.rows")(function* (
  db: Db,
  model: Pick<Model.Ref, "providerID" | "id">,
  now: number,
) {
  const found = yield* db
    .all<{ id: string; requestID: string | null; ruleIDs: string }>(
      sql`
    SELECT id, request_id AS requestID, rule_ids AS ruleIDs
    FROM model_incident INDEXED BY model_incident_model_time_idx
    WHERE provider_id = ${model.providerID} AND model_id = ${model.id}
      AND time_created >= ${now - WINDOW_MILLIS} AND time_created <= ${now}
      AND time_created > coalesce(
        (SELECT cleared_at FROM model_guidance_clear WHERE provider_id = ${model.providerID} AND model_id = ${model.id}), -1)
      AND kind <> 'fallback'
    ORDER BY time_created DESC, id DESC
    LIMIT ${MAX_ROWS}
  `,
    )
    .pipe(Effect.orDie)
  return found.map((row): Row => {
    const ruleIDs = decodeRuleIDs(row.ruleIDs)
    return { requestID: row.requestID ?? row.id, ruleIDs: ruleIDs._tag === "Some" ? ruleIDs.value : [] }
  })
})

export const text = Effect.fn("ModelGuidanceInstructions.text")(function* (
  db: Db,
  model: Pick<Model.Ref, "providerID" | "id">,
) {
  return render(yield* rows(db, model, yield* Clock.currentTimeMillis))
})

export function make(db: Db, model: Pick<Model.Ref, "providerID" | "id">) {
  return Instructions.make({
    key: Instruction.Key.make("core/model-guidance"),
    codec: Schema.toCodecJson(Schema.String),
    read: text(db, model).pipe(Effect.map((value) => value ?? Instructions.removed)),
    render: {
      initial: (value) => value,
      changed: (_previous, value) => `Model guidance changed. It replaces the earlier <model-guidance> notes.\n${value}`,
      removed: () => retraction,
    },
  })
}
