import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261023160000_projects-redesign",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`DROP TABLE \`coordination_claim\`;`)
      yield* tx.run(`DROP TABLE \`coordination_dispatch\`;`)
      yield* tx.run(`DROP TABLE \`coordination_receipt\`;`)
      yield* tx.run(`DROP TABLE \`coordination_wait\`;`)
      yield* tx.run(`DROP TABLE \`coordination_member\`;`)
      yield* tx.run(`DROP TABLE \`coordination_group\`;`)
      yield* tx.run(`
        CREATE TABLE \`coordination_group\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`master_session_id\` text NOT NULL,
          \`concurrency\` integer,
          \`delegated_decisions\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_coordination_group_master_session_id_session_id_fk\` FOREIGN KEY (\`master_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`coordination_member\` (
          \`group_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          CONSTRAINT \`coordination_member_pk\` PRIMARY KEY(\`group_id\`, \`session_id\`),
          CONSTRAINT \`fk_coordination_member_group_id_coordination_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`coordination_group\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_member_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`coordination_group_master_idx\` ON \`coordination_group\` (\`master_session_id\`);`)
      yield* tx.run(`CREATE INDEX \`coordination_group_updated_idx\` ON \`coordination_group\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`coordination_member_session_idx\` ON \`coordination_member\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
