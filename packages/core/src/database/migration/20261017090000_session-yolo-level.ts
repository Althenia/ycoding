import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261017090000_session-yolo-level",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `UPDATE \`session\` SET \`autonomy\` = json_set(\`autonomy\`, '$.yolo', 2), \`autonomy_revision\` = \`autonomy_revision\` + 1 WHERE json_extract(\`autonomy\`, '$.yolo') = 3;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
