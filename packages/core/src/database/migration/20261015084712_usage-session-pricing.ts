import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261015084712_usage-session-pricing",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE INDEX \`session_provider_request_session_unpriced_idx\` ON \`session_provider_request\` (\`session_id\`,\`id\`) WHERE "session_provider_request"."cost" is null and "session_provider_request"."source" <> 'decision';`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
