import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260806071025_drop-compaction-admission-mode",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_session_compaction_job\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`legacy_input_id\` text,
          \`trigger\` text NOT NULL,
          \`requested_through_message_id\` text NOT NULL,
          \`requested_through_seq\` integer NOT NULL,
          \`base_context_revision\` integer NOT NULL,
          \`target_max_input_tokens\` integer,
          \`config_digest\` text,
          \`status\` text NOT NULL,
          \`lease_owner\` text,
          \`lease_expires_at\` integer,
          \`attempts\` integer NOT NULL,
          \`manifest_digest\` text,
          \`error_code\` text,
          \`error_message\` text,
          \`time_created\` integer NOT NULL,
          \`time_started\` integer,
          \`time_ended\` integer,
          CONSTRAINT \`fk_session_compaction_job_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_compaction_job_manifest_digest_compaction_manifest_blob_digest_fk\` FOREIGN KEY (\`manifest_digest\`) REFERENCES \`compaction_manifest_blob\`(\`digest\`) ON DELETE RESTRICT,
          CONSTRAINT \`session_compaction_job_base_revision_fk\` FOREIGN KEY (\`session_id\`,\`base_context_revision\`) REFERENCES \`session_context_revision\`(\`session_id\`,\`revision\`) ON DELETE CASCADE,
          CONSTRAINT "session_compaction_job_id_check" CHECK(length("id") > 4 AND substr("id", 1, 4) = 'cmp_'),
          CONSTRAINT "session_compaction_job_legacy_input_check" CHECK(("legacy_input_id" IS NULL OR length("legacy_input_id") > 0)),
          CONSTRAINT "session_compaction_job_trigger_check" CHECK("trigger" IN ('consider', 'advised', 'mandatory', 'manual')),
          CONSTRAINT "session_compaction_job_requested_message_check" CHECK(length("requested_through_message_id") > 0),
          CONSTRAINT "session_compaction_job_counts_check" CHECK(typeof("requested_through_seq") = 'integer' AND "requested_through_seq" >= 0 AND typeof("base_context_revision") = 'integer' AND "base_context_revision" >= 0 AND ("target_max_input_tokens" IS NULL OR (typeof("target_max_input_tokens") = 'integer' AND "target_max_input_tokens" >= 0)) AND typeof("attempts") = 'integer' AND "attempts" >= 0),
          CONSTRAINT "session_compaction_job_config_digest_check" CHECK(("config_digest" IS NULL OR (length("config_digest") = 64 AND "config_digest" NOT GLOB '*[^0-9a-f]*'))),
          CONSTRAINT "session_compaction_job_manifest_digest_check" CHECK(("manifest_digest" IS NULL OR (length("manifest_digest") = 64 AND "manifest_digest" NOT GLOB '*[^0-9a-f]*'))),
          CONSTRAINT "session_compaction_job_current_input_check" CHECK("legacy_input_id" IS NOT NULL OR ("target_max_input_tokens" IS NOT NULL AND "config_digest" IS NOT NULL)),
          CONSTRAINT "session_compaction_job_status_check" CHECK("status" IN ('pending', 'running', 'ended', 'failed')),
          CONSTRAINT "session_compaction_job_lease_check" CHECK(("lease_owner" IS NULL AND "lease_expires_at" IS NULL) OR (length("lease_owner") > 0 AND typeof("lease_expires_at") = 'integer' AND "lease_expires_at" >= 0)),
          CONSTRAINT "session_compaction_job_terminal_check" CHECK(("status" = 'pending' AND "lease_owner" IS NULL AND "time_started" IS NULL AND "time_ended" IS NULL AND "manifest_digest" IS NULL AND "error_code" IS NULL AND "error_message" IS NULL) OR ("status" = 'running' AND "lease_owner" IS NOT NULL AND "time_started" IS NOT NULL AND "time_ended" IS NULL AND "manifest_digest" IS NULL AND "error_code" IS NULL AND "error_message" IS NULL) OR ("status" = 'ended' AND "lease_owner" IS NULL AND "time_started" IS NOT NULL AND "time_ended" IS NOT NULL AND "manifest_digest" IS NOT NULL AND "error_code" IS NULL AND "error_message" IS NULL) OR ("status" = 'failed' AND "lease_owner" IS NULL AND "time_ended" IS NOT NULL AND "manifest_digest" IS NULL AND "error_code" IS NOT NULL)),
          CONSTRAINT "session_compaction_job_time_check" CHECK(typeof("time_created") = 'integer' AND "time_created" >= 0 AND ("time_started" IS NULL OR (typeof("time_started") = 'integer' AND "time_started" >= 0)) AND ("time_ended" IS NULL OR (typeof("time_ended") = 'integer' AND "time_ended" >= 0)))
        );
      `)
      yield* tx.run(
        `INSERT INTO \`__new_session_compaction_job\`(\`id\`, \`session_id\`, \`legacy_input_id\`, \`trigger\`, \`requested_through_message_id\`, \`requested_through_seq\`, \`base_context_revision\`, \`target_max_input_tokens\`, \`config_digest\`, \`status\`, \`lease_owner\`, \`lease_expires_at\`, \`attempts\`, \`manifest_digest\`, \`error_code\`, \`error_message\`, \`time_created\`, \`time_started\`, \`time_ended\`) SELECT \`id\`, \`session_id\`, \`legacy_input_id\`, \`trigger\`, \`requested_through_message_id\`, \`requested_through_seq\`, \`base_context_revision\`, \`target_max_input_tokens\`, \`config_digest\`, \`status\`, \`lease_owner\`, \`lease_expires_at\`, \`attempts\`, \`manifest_digest\`, \`error_code\`, \`error_message\`, \`time_created\`, \`time_started\`, \`time_ended\` FROM \`session_compaction_job\`;`,
      )
      yield* tx.run(`DROP TABLE \`session_compaction_job\`;`)
      yield* tx.run(`ALTER TABLE \`__new_session_compaction_job\` RENAME TO \`session_compaction_job\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_compaction_job_pending_revision_idx\` ON \`session_compaction_job\` (\`session_id\`,\`base_context_revision\`) WHERE "session_compaction_job"."status" = 'pending';`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_compaction_job_legacy_input_idx\` ON \`session_compaction_job\` (\`legacy_input_id\`) WHERE "session_compaction_job"."legacy_input_id" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_compaction_job_recovery_idx\` ON \`session_compaction_job\` (\`status\`,\`lease_expires_at\`,\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_compaction_job_manifest_idx\` ON \`session_compaction_job\` (\`manifest_digest\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
