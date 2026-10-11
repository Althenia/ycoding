import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261011135037_session-usage-indexes",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP INDEX IF EXISTS \`session_project_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_workspace_idx\`;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_parent_idx\`;`)
      yield* tx.run(
        `CREATE INDEX \`session_compaction_job_session_ended_idx\` ON \`session_compaction_job\` (\`session_id\`,\`time_ended\`) WHERE "session_compaction_job"."status" = 'ended';`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_provider_request_time_created_idx\` ON \`session_provider_request\` (\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_time_updated_id_idx\` ON \`session\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_project_time_updated_id_idx\` ON \`session\` (\`project_id\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_workspace_time_updated_id_idx\` ON \`session\` (\`workspace_id\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_parent_time_updated_id_idx\` ON \`session\` (\`parent_id\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_directory_time_updated_id_idx\` ON \`session\` (\`directory\`,\`time_updated\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
