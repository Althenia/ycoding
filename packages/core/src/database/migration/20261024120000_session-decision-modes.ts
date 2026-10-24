import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

const decisionMode = (flag: string) =>
  `CASE WHEN json_type(\`autonomy\`, '$.${flag}') = 'true' THEN 'auto' WHEN json_type(\`autonomy\`, '$.yolo') = 'true' THEN 'yolo' ELSE 'manual' END`

export default {
  id: "20261024120000_session-decision-modes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `UPDATE \`session\` SET \`autonomy\` = json_remove(json_set(\`autonomy\`, '$.mode', 'normal', '$.permissions', ${decisionMode("autoPermission")}, '$.guardrails', ${decisionMode("autoGuardrail")}, '$.answers', ${decisionMode("autoAnswer")}), '$.yolo', '$.autoPermission', '$.autoGuardrail', '$.autoAnswer'), \`autonomy_revision\` = \`autonomy_revision\` + 1 WHERE json_valid(\`autonomy\`) AND json_type(\`autonomy\`) = 'object' AND json_type(\`autonomy\`, '$.permissions') IS NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
