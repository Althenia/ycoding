import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727001011_observation-sessionless-identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_observation_sessionless_absent_idx\` ON \`project_artifact_observation\` (\`version_id\`) WHERE "project_artifact_observation"."terminal_message_id" IS NULL AND "project_artifact_observation"."session_id" IS NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
