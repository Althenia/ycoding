import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261017230123_usage-analytics-unpriced-index",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`usage_analytics_request_unpriced_time_created_id_idx\` ON \`usage_analytics_request\` (\`time_created\`,\`id\`) WHERE cost IS NULL AND source <> 'decision';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
