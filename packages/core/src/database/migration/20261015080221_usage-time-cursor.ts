import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015080221_usage-time-cursor",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_provider_request_time_created_id_idx\` ON \`session_provider_request\` (\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
