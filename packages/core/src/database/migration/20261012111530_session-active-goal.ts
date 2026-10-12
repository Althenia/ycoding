import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261012111530_session-active-goal",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_active_goal_idx\` ON \`session\` (\`id\`) WHERE json_extract("session"."autonomy", '$.goal.status') = 'active';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
