import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803004514_session-file-change-ledger",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_file_change\` (
          \`session_id\` text NOT NULL,
          \`path\` text NOT NULL,
          \`patch\` text NOT NULL,
          \`additions\` integer NOT NULL,
          \`deletions\` integer NOT NULL,
          \`latest_seq\` integer NOT NULL,
          CONSTRAINT \`session_file_change_pk\` PRIMARY KEY(\`session_id\`, \`path\`),
          CONSTRAINT \`fk_session_file_change_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_file_change_path_session_idx\` ON \`session_file_change\` (\`path\`,\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
