import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260727000736_observation-session-identity",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`project_artifact_observation_version_terminal_absent_idx\`;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_observation_version_session_absent_idx\` ON \`project_artifact_observation\` (\`version_id\`,\`session_id\`) WHERE "project_artifact_observation"."terminal_message_id" IS NULL;`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
