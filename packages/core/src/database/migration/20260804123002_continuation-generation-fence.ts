import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260804123002_continuation-generation-fence",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_provider_continuation_generation\` (
          \`session_id\` text PRIMARY KEY,
          \`generation\` integer NOT NULL,
          \`context_revision\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_provider_continuation_generation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`session_provider_continuation_generation_revision_fk\` FOREIGN KEY (\`session_id\`,\`context_revision\`) REFERENCES \`session_context_revision\`(\`session_id\`,\`revision\`) ON DELETE CASCADE,
          CONSTRAINT "session_provider_continuation_generation_counts_check" CHECK(typeof("generation") = 'integer' AND "generation" >= 0),
          CONSTRAINT "session_provider_continuation_generation_revision_check" CHECK(typeof("context_revision") = 'integer' AND "context_revision" >= 0),
          CONSTRAINT "session_provider_continuation_generation_time_check" CHECK(typeof("time_updated") = 'integer' AND "time_updated" >= 0)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
