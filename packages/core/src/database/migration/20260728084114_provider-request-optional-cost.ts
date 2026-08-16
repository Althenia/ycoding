import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260728084114_provider-request-optional-cost",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_session_provider_request\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`input_id\` text,
          \`source\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`model\` text NOT NULL,
          \`route_id\` text NOT NULL,
          \`prompt_cache_key\` text NOT NULL,
          \`system_digest\` text NOT NULL,
          \`tool_digest\` text NOT NULL,
          \`request\` integer NOT NULL,
          \`attempts\` integer NOT NULL,
          \`invalidation\` text NOT NULL,
          \`continuation\` text NOT NULL,
          \`cost\` real,
          \`tokens\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_provider_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_session_provider_request\`(\`id\`, \`session_id\`, \`input_id\`, \`source\`, \`agent\`, \`model\`, \`route_id\`, \`prompt_cache_key\`, \`system_digest\`, \`tool_digest\`, \`request\`, \`attempts\`, \`invalidation\`, \`continuation\`, \`cost\`, \`tokens\`, \`time_created\`) SELECT \`id\`, \`session_id\`, \`input_id\`, \`source\`, \`agent\`, \`model\`, \`route_id\`, \`prompt_cache_key\`, \`system_digest\`, \`tool_digest\`, \`request\`, \`attempts\`, \`invalidation\`, \`continuation\`, \`cost\`, \`tokens\`, \`time_created\` FROM \`session_provider_request\`;`,
      )
      yield* tx.run(`DROP TABLE \`session_provider_request\`;`)
      yield* tx.run(`ALTER TABLE \`__new_session_provider_request\` RENAME TO \`session_provider_request\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_provider_request_session_request_idx\` ON \`session_provider_request\` (\`session_id\`,\`request\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_provider_request_session_source_idx\` ON \`session_provider_request\` (\`session_id\`,\`source\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
