import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260803011247_session-usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_usage\` (
          \`session_id\` text NOT NULL,
          \`model_key\` text NOT NULL,
          \`model\` text NOT NULL,
          \`logical\` integer NOT NULL,
          \`physical\` integer NOT NULL,
          \`helpers\` integer NOT NULL,
          \`continued\` integer NOT NULL,
          \`fallback\` integer NOT NULL,
          \`cost\` real,
          \`input\` integer NOT NULL,
          \`output\` integer NOT NULL,
          \`reasoning\` integer NOT NULL,
          \`cache_read\` integer NOT NULL,
          \`cache_write\` integer NOT NULL,
          CONSTRAINT \`session_usage_pk\` PRIMARY KEY(\`session_id\`, \`model_key\`),
          CONSTRAINT \`fk_session_usage_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        INSERT INTO \`session_usage\` (
          \`session_id\`, \`model_key\`, \`model\`, \`logical\`, \`physical\`, \`helpers\`, \`continued\`, \`fallback\`, \`cost\`, \`input\`, \`output\`, \`reasoning\`, \`cache_read\`, \`cache_write\`
        )
        SELECT
          \`session_id\`,
          json_array(json_extract(\`model\`, '$.providerID'), json_extract(\`model\`, '$.id'), json_extract(\`model\`, '$.variant')),
          MIN(\`model\`),
          COUNT(*),
          SUM(\`attempts\`),
          SUM(CASE WHEN \`source\` = 'step' THEN 0 ELSE 1 END),
          SUM(CASE WHEN \`continuation\` = 'continued' THEN 1 ELSE 0 END),
          SUM(CASE WHEN \`continuation\` = 'fallback' THEN 1 ELSE 0 END),
          CASE WHEN COUNT(\`cost\`) = COUNT(*) THEN SUM(\`cost\`) ELSE NULL END,
          SUM(json_extract(\`tokens\`, '$.input')),
          SUM(json_extract(\`tokens\`, '$.output')),
          SUM(json_extract(\`tokens\`, '$.reasoning')),
          SUM(json_extract(\`tokens\`, '$.cache.read')),
          SUM(json_extract(\`tokens\`, '$.cache.write'))
        FROM \`session_provider_request\`
        GROUP BY
          \`session_id\`,
          json_extract(\`model\`, '$.providerID'),
          json_extract(\`model\`, '$.id'),
          json_extract(\`model\`, '$.variant');
      `)
    })
  },
} satisfies DatabaseMigration.Migration
