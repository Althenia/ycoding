import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261023093249_coordination-groups",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`coordination_claim\` (
          \`group_id\` text NOT NULL,
          \`target_session_id\` text NOT NULL,
          \`holder_session_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`lease_expires_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`coordination_claim_pk\` PRIMARY KEY(\`group_id\`, \`target_session_id\`),
          CONSTRAINT \`fk_coordination_claim_group_id_coordination_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`coordination_group\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_claim_target_session_id_session_id_fk\` FOREIGN KEY (\`target_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_claim_holder_session_id_session_id_fk\` FOREIGN KEY (\`holder_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`coordination_dispatch\` (
          \`id\` text PRIMARY KEY,
          \`group_id\` text NOT NULL,
          \`target_session_id\` text NOT NULL,
          \`coordinator_session_id\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`reason\` text,
          \`text\` text NOT NULL,
          \`selection\` text NOT NULL,
          \`depends_on\` text,
          \`resource_scope\` text,
          \`allowed_tools\` text,
          \`message_id\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_coordination_dispatch_group_id_coordination_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`coordination_group\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_dispatch_target_session_id_session_id_fk\` FOREIGN KEY (\`target_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_dispatch_coordinator_session_id_session_id_fk\` FOREIGN KEY (\`coordinator_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`coordination_group\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`concurrency\` integer,
          \`queue_capacity\` integer NOT NULL,
          \`budget\` real,
          \`delegated_decisions\` text,
          \`fencing_generation\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`coordination_member\` (
          \`group_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`role\` text NOT NULL,
          \`allowed_tools\` text,
          \`resource_scopes\` text,
          CONSTRAINT \`coordination_member_pk\` PRIMARY KEY(\`group_id\`, \`session_id\`),
          CONSTRAINT \`fk_coordination_member_group_id_coordination_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`coordination_group\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_member_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`coordination_receipt\` (
          \`id\` text PRIMARY KEY,
          \`group_id\` text NOT NULL,
          \`dispatch_id\` text,
          \`kind\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`message_id\` text,
          \`generation\` integer,
          \`detail\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_coordination_receipt_group_id_coordination_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`coordination_group\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_receipt_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`coordination_wait\` (
          \`id\` text PRIMARY KEY,
          \`group_id\` text NOT NULL,
          \`coordinator_session_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`targets\` text NOT NULL,
          \`cursors\` text NOT NULL,
          \`expires_at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_coordination_wait_group_id_coordination_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`coordination_group\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_wait_coordinator_session_id_session_id_fk\` FOREIGN KEY (\`coordinator_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`coordination_claim_target_status_idx\` ON \`coordination_claim\` (\`target_session_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`coordination_dispatch_group_status_idx\` ON \`coordination_dispatch\` (\`group_id\`,\`status\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`coordination_dispatch_target_status_idx\` ON \`coordination_dispatch\` (\`target_session_id\`,\`status\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`coordination_dispatch_message_idx\` ON \`coordination_dispatch\` (\`message_id\`) WHERE "coordination_dispatch"."message_id" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`coordination_group_status_updated_idx\` ON \`coordination_group\` (\`status\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`coordination_member_session_idx\` ON \`coordination_member\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`coordination_receipt_group_time_idx\` ON \`coordination_receipt\` (\`group_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`coordination_wait_group_status_idx\` ON \`coordination_wait\` (\`group_id\`,\`status\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
