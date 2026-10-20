import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const stored = "CASE WHEN json_valid(`autonomy`) THEN"
const mode = "json_extract(`autonomy`, '$.mode')"
const yoloType = "json_type(`autonomy`, '$.yolo')"
const yolo = "json_extract(`autonomy`, '$.yolo')"

const guardrailLevel = `${stored} (${mode} = 'yolo' OR ${yoloType} = 'true' OR (${yoloType} = 'integer' AND ${yolo} IN (2, 3))) ELSE 0 END`
const approvalLevel = `${stored} (${yoloType} = 'integer' AND ${yolo} = 1) ELSE 0 END`
const otherLegacy = `${stored} (${mode} IN ('yolo', 'goal') OR (${yoloType} IS NOT NULL AND ${yoloType} != 'false')) ELSE 0 END`

const rewrite = (where: string, flags: string) =>
  `UPDATE \`session\` SET \`autonomy\` = json_set(\`autonomy\`, '$.mode', 'normal', '$.yolo', json('false')${flags}), \`autonomy_revision\` = \`autonomy_revision\` + 1 WHERE ${where};`

export default {
  id: "20261020120000_session-yolo-toggle",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(rewrite(guardrailLevel, ", '$.autoPermission', json('true'), '$.autoGuardrail', json('true')"))
      yield* tx.run(rewrite(approvalLevel, ", '$.autoPermission', json('true')"))
      yield* tx.run(rewrite(otherLegacy, ""))
    })
  },
} satisfies DatabaseMigration.Migration
