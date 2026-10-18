import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261018113719_mcp-events",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`mcp_event_outbox\` (
          \`seq\` integer PRIMARY KEY AUTOINCREMENT,
          \`id\` text NOT NULL,
          \`subscription_id\` text NOT NULL,
          \`dedupe_key\` text NOT NULL,
          \`name\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`root_session_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`request_id\` text,
          \`item_id\` text,
          \`task_id\` text,
          \`category\` text,
          \`reason\` text,
          \`time_created\` integer NOT NULL,
          \`attempts\` integer NOT NULL,
          \`next_attempt_at\` integer NOT NULL,
          \`delivered_at\` integer,
          \`dead\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`mcp_event_subscription\` (
          \`id\` text PRIMARY KEY,
          \`identity_hash\` text NOT NULL,
          \`owner_id\` text NOT NULL,
          \`device_id\` text NOT NULL,
          \`client_id\` text NOT NULL,
          \`grant_id\` text NOT NULL,
          \`epoch\` text NOT NULL,
          \`name\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`include_descendants\` integer NOT NULL,
          \`callback_url\` text NOT NULL,
          \`secret_ciphertext\` text NOT NULL,
          \`secret_fingerprint\` text NOT NULL,
          \`previous_secret_ciphertext\` text,
          \`previous_secret_until\` integer,
          \`expires_at\` integer NOT NULL,
          \`disabled\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`mcp_event_outbox_id_idx\` ON \`mcp_event_outbox\` (\`id\`);`)
      yield* tx.run(`CREATE UNIQUE INDEX \`mcp_event_outbox_dedupe_idx\` ON \`mcp_event_outbox\` (\`dedupe_key\`);`)
      yield* tx.run(
        `CREATE INDEX \`mcp_event_outbox_dispatch_idx\` ON \`mcp_event_outbox\` (\`delivered_at\`,\`dead\`,\`next_attempt_at\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`mcp_event_outbox_subscription_seq_idx\` ON \`mcp_event_outbox\` (\`subscription_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`mcp_event_subscription_identity_idx\` ON \`mcp_event_subscription\` (\`identity_hash\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`mcp_event_subscription_session_idx\` ON \`mcp_event_subscription\` (\`session_id\`,\`name\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`mcp_event_subscription_expiry_idx\` ON \`mcp_event_subscription\` (\`expires_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
