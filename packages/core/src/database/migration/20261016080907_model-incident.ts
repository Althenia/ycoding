import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261016080907_model-incident",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`model_guidance_clear\` (
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`cleared_at\` integer NOT NULL,
          CONSTRAINT \`model_guidance_clear_pk\` PRIMARY KEY(\`provider_id\`, \`model_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`model_incident\` (
          \`id\` text PRIMARY KEY,
          \`time_created\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`profile\` text,
          \`agent\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`request_id\` text,
          \`category\` text NOT NULL,
          \`rule_ids\` text NOT NULL,
          \`target\` text,
          \`decided_by\` text
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`model_incident_time_created_id_idx\` ON \`model_incident\` (\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`model_incident_model_time_idx\` ON \`model_incident\` (\`provider_id\`,\`model_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`model_incident_request_id_idx\` ON \`model_incident\` (\`request_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
