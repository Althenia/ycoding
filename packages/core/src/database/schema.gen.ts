import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`project_id\` text NOT NULL,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_workspace_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_analytics_request\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`session_updated\` integer NOT NULL,
          \`agent\` text NOT NULL,
          \`source\` text NOT NULL,
          \`model\` text NOT NULL,
          \`usage_anchor\` text,
          \`task_path\` text NOT NULL,
          \`request\` integer NOT NULL,
          \`attempts\` integer NOT NULL,
          \`continuation\` text NOT NULL,
          \`invalidation\` text NOT NULL,
          \`prompt_cache_key\` text NOT NULL,
          \`cache_read_reported\` integer,
          \`tokens\` text NOT NULL,
          \`cost\` real,
          \`timing\` text,
          \`outcome\` text,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_usage_cell_leaf\` (
          \`cell\` integer NOT NULL,
          \`updated\` integer NOT NULL,
          \`request\` integer NOT NULL,
          \`source\` text NOT NULL,
          CONSTRAINT \`session_usage_cell_leaf_pk\` PRIMARY KEY(\`cell\`, \`updated\`, \`request\`, \`source\`),
          CONSTRAINT \`fk_session_usage_cell_leaf_cell_session_usage_cell_id_fk\` FOREIGN KEY (\`cell\`) REFERENCES \`session_usage_cell\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_usage_cell_sample\` (
          \`cell\` integer NOT NULL,
          \`metric\` integer NOT NULL,
          \`value\` real NOT NULL,
          \`count\` integer NOT NULL,
          CONSTRAINT \`session_usage_cell_sample_pk\` PRIMARY KEY(\`cell\`, \`metric\`, \`value\`),
          CONSTRAINT \`fk_session_usage_cell_sample_cell_session_usage_cell_id_fk\` FOREIGN KEY (\`cell\`) REFERENCES \`session_usage_cell\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_usage_cell\` (
          \`id\` integer PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`span\` integer NOT NULL,
          \`bucket\` integer NOT NULL,
          \`key\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`source\` text NOT NULL,
          \`model\` text NOT NULL,
          \`usage_anchor\` text,
          \`input_id\` text,
          \`logical\` integer NOT NULL,
          \`physical\` integer NOT NULL,
          \`helpers\` integer NOT NULL,
          \`continued\` integer NOT NULL,
          \`fallback\` integer NOT NULL,
          \`input\` integer NOT NULL,
          \`output\` integer NOT NULL,
          \`reasoning\` integer NOT NULL,
          \`cache_read\` integer NOT NULL,
          \`cache_write\` integer NOT NULL,
          \`cache_read_reported\` integer NOT NULL,
          \`cost\` real NOT NULL,
          \`priced\` integer NOT NULL,
          \`spend\` real NOT NULL,
          \`spend_priced\` integer NOT NULL,
          \`unpriced\` integer NOT NULL,
          \`first_output\` integer NOT NULL,
          \`total_output\` integer NOT NULL,
          \`generation_samples\` integer NOT NULL,
          \`provider_timed\` integer NOT NULL,
          \`observed\` integer NOT NULL,
          \`generation_tokens\` real NOT NULL,
          \`generation_duration\` real NOT NULL,
          \`generation_rate\` real DEFAULT 0 NOT NULL,
          \`busy_ms\` integer DEFAULT 0 NOT NULL,
          \`failed\` integer DEFAULT 0 NOT NULL,
          \`cancelled\` integer DEFAULT 0 NOT NULL,
          \`outcomes\` integer DEFAULT 0 NOT NULL,
          \`first_updated\` integer,
          \`first_request\` integer,
          \`last_updated\` integer,
          \`last_request\` integer,
          \`last_invalidation\` text,
          \`last_namespace\` text,
          \`last_timing\` text,
          CONSTRAINT \`fk_session_usage_cell_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_usage_cell_unpriced\` (
          \`cell\` integer NOT NULL,
          \`context\` integer NOT NULL,
          \`requests\` integer NOT NULL,
          \`input\` integer NOT NULL,
          \`output\` integer NOT NULL,
          \`reasoning\` integer NOT NULL,
          \`cache_read\` integer NOT NULL,
          \`cache_write\` integer NOT NULL,
          CONSTRAINT \`session_usage_cell_unpriced_pk\` PRIMARY KEY(\`cell\`, \`context\`),
          CONSTRAINT \`fk_session_usage_cell_unpriced_cell_session_usage_cell_id_fk\` FOREIGN KEY (\`cell\`) REFERENCES \`session_usage_cell\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_analytics_cell_leaf\` (
          \`cell\` integer NOT NULL,
          \`updated\` integer NOT NULL,
          \`request\` integer NOT NULL,
          \`source\` text NOT NULL,
          CONSTRAINT \`usage_analytics_cell_leaf_pk\` PRIMARY KEY(\`cell\`, \`updated\`, \`request\`, \`source\`),
          CONSTRAINT \`fk_usage_analytics_cell_leaf_cell_usage_analytics_cell_id_fk\` FOREIGN KEY (\`cell\`) REFERENCES \`usage_analytics_cell\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_analytics_cell_sample\` (
          \`cell\` integer NOT NULL,
          \`metric\` integer NOT NULL,
          \`value\` real NOT NULL,
          \`count\` integer NOT NULL,
          CONSTRAINT \`usage_analytics_cell_sample_pk\` PRIMARY KEY(\`cell\`, \`metric\`, \`value\`),
          CONSTRAINT \`fk_usage_analytics_cell_sample_cell_usage_analytics_cell_id_fk\` FOREIGN KEY (\`cell\`) REFERENCES \`usage_analytics_cell\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_analytics_cell\` (
          \`id\` integer PRIMARY KEY,
          \`span\` integer NOT NULL,
          \`bucket\` integer NOT NULL,
          \`key\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`workspace_id\` text,
          \`agent\` text NOT NULL,
          \`model\` text NOT NULL,
          \`usage_anchor\` text,
          \`task_path\` text NOT NULL,
          \`logical\` integer NOT NULL,
          \`physical\` integer NOT NULL,
          \`helpers\` integer NOT NULL,
          \`continued\` integer NOT NULL,
          \`fallback\` integer NOT NULL,
          \`input\` integer NOT NULL,
          \`output\` integer NOT NULL,
          \`reasoning\` integer NOT NULL,
          \`cache_read\` integer NOT NULL,
          \`cache_write\` integer NOT NULL,
          \`cache_read_reported\` integer NOT NULL,
          \`cost\` real NOT NULL,
          \`priced\` integer NOT NULL,
          \`spend\` real NOT NULL,
          \`spend_priced\` integer NOT NULL,
          \`unpriced\` integer NOT NULL,
          \`first_output\` integer NOT NULL,
          \`total_output\` integer NOT NULL,
          \`generation_samples\` integer NOT NULL,
          \`provider_timed\` integer NOT NULL,
          \`observed\` integer NOT NULL,
          \`generation_tokens\` real NOT NULL,
          \`generation_duration\` real NOT NULL,
          \`generation_rate\` real DEFAULT 0 NOT NULL,
          \`busy_ms\` integer DEFAULT 0 NOT NULL,
          \`failed\` integer DEFAULT 0 NOT NULL,
          \`cancelled\` integer DEFAULT 0 NOT NULL,
          \`outcomes\` integer DEFAULT 0 NOT NULL,
          \`first_updated\` integer,
          \`first_request\` integer,
          \`last_updated\` integer,
          \`last_request\` integer,
          \`last_invalidation\` text,
          \`last_namespace\` text,
          \`last_timing\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_analytics_cell_unpriced\` (
          \`cell\` integer NOT NULL,
          \`context\` integer NOT NULL,
          \`requests\` integer NOT NULL,
          \`input\` integer NOT NULL,
          \`output\` integer NOT NULL,
          \`reasoning\` integer NOT NULL,
          \`cache_read\` integer NOT NULL,
          \`cache_write\` integer NOT NULL,
          CONSTRAINT \`usage_analytics_cell_unpriced_pk\` PRIMARY KEY(\`cell\`, \`context\`),
          CONSTRAINT \`fk_usage_analytics_cell_unpriced_cell_usage_analytics_cell_id_fk\` FOREIGN KEY (\`cell\`) REFERENCES \`usage_analytics_cell\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_view_change\` (
          \`seq\` integer PRIMARY KEY AUTOINCREMENT,
          \`kind\` text NOT NULL,
          \`source\` text,
          \`through\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_view_journal\` (
          \`id\` integer PRIMARY KEY,
          \`pruned\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_view_presentation\` (
          \`id\` text PRIMARY KEY,
          \`state\` text NOT NULL,
          \`recipe\` text NOT NULL,
          \`payload\` text,
          \`version\` integer,
          \`labels\` text,
          \`time_published\` integer,
          \`time_used\` integer NOT NULL,
          CONSTRAINT \`fk_usage_view_presentation_state_usage_view_state_id_fk\` FOREIGN KEY (\`state\`) REFERENCES \`usage_view_state\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_view_rank\` (
          \`state\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`key\` text NOT NULL,
          \`quantile\` integer NOT NULL,
          \`value\` real NOT NULL,
          \`below\` integer NOT NULL,
          CONSTRAINT \`usage_view_rank_pk\` PRIMARY KEY(\`state\`, \`generation\`, \`key\`, \`quantile\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_view_ref\` (
          \`state\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`location\` text NOT NULL,
          \`ref\` text NOT NULL,
          \`price\` text NOT NULL,
          CONSTRAINT \`usage_view_ref_pk\` PRIMARY KEY(\`state\`, \`generation\`, \`location\`, \`ref\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_view_row\` (
          \`state\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`key\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`title\` text NOT NULL,
          \`project_id\` text NOT NULL,
          \`model\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`time\` integer NOT NULL,
          \`rep_updated\` integer,
          \`rep_session\` text,
          \`rep_request\` integer,
          \`logical\` integer NOT NULL,
          \`physical\` integer NOT NULL,
          \`helpers\` integer NOT NULL,
          \`continued\` integer NOT NULL,
          \`fallback\` integer NOT NULL,
          \`input\` integer NOT NULL,
          \`output\` integer NOT NULL,
          \`reasoning\` integer NOT NULL,
          \`cache_read\` integer NOT NULL,
          \`cache_write\` integer NOT NULL,
          \`reported\` integer NOT NULL,
          \`cost\` real NOT NULL,
          \`priced\` integer NOT NULL,
          \`catalog_cost\` real NOT NULL,
          \`catalog_requests\` integer NOT NULL,
          \`total_cost\` real NOT NULL,
          \`total_tokens\` integer NOT NULL,
          \`first_output\` integer NOT NULL,
          \`total_output\` integer NOT NULL,
          \`generation_samples\` integer NOT NULL,
          \`provider_timed\` integer NOT NULL,
          \`observed\` integer NOT NULL,
          \`generation_tokens\` real NOT NULL,
          \`generation_duration\` real NOT NULL,
          \`generation_rate\` real DEFAULT 0 NOT NULL,
          \`busy_ms\` integer DEFAULT 0 NOT NULL,
          \`failed\` integer DEFAULT 0 NOT NULL,
          \`cancelled\` integer DEFAULT 0 NOT NULL,
          \`outcomes\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`usage_view_row_pk\` PRIMARY KEY(\`state\`, \`generation\`, \`key\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_view_sample\` (
          \`state\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`key\` text NOT NULL,
          \`metric\` integer NOT NULL,
          \`value\` real NOT NULL,
          \`count\` integer NOT NULL,
          CONSTRAINT \`usage_view_sample_pk\` PRIMARY KEY(\`state\`, \`generation\`, \`key\`, \`metric\`, \`value\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`usage_view_state\` (
          \`id\` text PRIMARY KEY,
          \`recipe\` text NOT NULL,
          \`generation\` integer NOT NULL,
          \`status\` text NOT NULL,
          \`applied_seq\` integer NOT NULL,
          \`rows\` integer NOT NULL,
          \`latest\` text,
          \`error\` text,
          \`version\` integer NOT NULL,
          \`epoch\` text,
          \`refs\` integer NOT NULL,
          \`owner\` text,
          \`time_used\` integer NOT NULL
        );
      `)
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
          \`owner_session_id\` text,
          CONSTRAINT \`coordination_member_pk\` PRIMARY KEY(\`group_id\`, \`session_id\`),
          CONSTRAINT \`fk_coordination_member_group_id_coordination_group_id_fk\` FOREIGN KEY (\`group_id\`) REFERENCES \`coordination_group\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_member_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_coordination_member_owner_session_id_session_id_fk\` FOREIGN KEY (\`owner_session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`generation\` integer DEFAULT 0 NOT NULL,
          \`account_generation\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT "credential_generation_check" CHECK(typeof("generation") = 'integer' AND "generation" >= 0),
          CONSTRAINT "credential_account_generation_check" CHECK(typeof("account_generation") = 'integer' AND "account_generation" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`created\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`kv\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
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
          \`attention\` text,
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
          \`pruned_through\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_permission_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_directory\` (
          \`project_id\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`type\` text,
          \`strategy\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_directory_pk\` PRIMARY KEY(\`project_id\`, \`directory\`),
          CONSTRAINT \`fk_project_directory_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project\` (
          \`id\` text PRIMARY KEY,
          \`worktree\` text NOT NULL,
          \`vcs\` text,
          \`name\` text,
          \`icon_url\` text,
          \`icon_url_override\` text,
          \`icon_color\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_initialized\` integer,
          \`sandboxes\` text NOT NULL,
          \`commands\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`compaction_manifest_blob\` (
          \`digest\` text PRIMARY KEY,
          \`schema_version\` integer NOT NULL,
          \`content\` text NOT NULL,
          \`input_tokens\` integer NOT NULL,
          \`retained_tokens\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT "compaction_manifest_blob_digest_check" CHECK(length("digest") = 64 AND "digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "compaction_manifest_blob_schema_version_check" CHECK("schema_version" > 0),
          CONSTRAINT "compaction_manifest_blob_content_check" CHECK(json_valid("content")),
          CONSTRAINT "compaction_manifest_blob_counts_check" CHECK(typeof("input_tokens") = 'integer' AND "input_tokens" >= 0 AND typeof("retained_tokens") = 'integer' AND "retained_tokens" >= 0),
          CONSTRAINT "compaction_manifest_blob_time_check" CHECK(typeof("time_created") = 'integer' AND "time_created" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instruction_blob\` (
          \`hash\` text PRIMARY KEY,
          \`value\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instruction_entry\` (
          \`session_id\` text NOT NULL,
          \`key\` text NOT NULL,
          \`value\` text,
          \`removed\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`instruction_entry_pk\` PRIMARY KEY(\`session_id\`, \`key\`),
          CONSTRAINT \`fk_instruction_entry_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instruction_state\` (
          \`session_id\` text PRIMARY KEY,
          \`epoch_start\` integer NOT NULL,
          \`through_seq\` integer NOT NULL,
          \`initial_values\` text NOT NULL,
          \`current_values\` text NOT NULL,
          CONSTRAINT \`fk_instruction_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_compaction_job\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`legacy_input_id\` text,
          \`usage_anchor\` text,
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
      yield* tx.run(`
        CREATE TABLE \`session_context_exclusion\` (
          \`session_id\` text NOT NULL,
          \`context_revision\` integer NOT NULL,
          \`target_key\` text NOT NULL,
          \`target_kind\` text NOT NULL,
          \`target_selector\` text NOT NULL,
          \`dependency_group\` text,
          \`reason\` text NOT NULL,
          \`manifest_digest\` text NOT NULL,
          CONSTRAINT \`session_context_exclusion_pk\` PRIMARY KEY(\`session_id\`, \`context_revision\`, \`target_key\`),
          CONSTRAINT \`fk_session_context_exclusion_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_context_exclusion_manifest_digest_compaction_manifest_blob_digest_fk\` FOREIGN KEY (\`manifest_digest\`) REFERENCES \`compaction_manifest_blob\`(\`digest\`) ON DELETE RESTRICT,
          CONSTRAINT \`session_context_exclusion_revision_fk\` FOREIGN KEY (\`session_id\`,\`context_revision\`) REFERENCES \`session_context_revision\`(\`session_id\`,\`revision\`) ON DELETE CASCADE,
          CONSTRAINT "session_context_exclusion_target_key_check" CHECK(length("target_key") = 64 AND "target_key" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "session_context_exclusion_target_kind_check" CHECK("target_kind" IN ('message', 'part', 'provider_state')),
          CONSTRAINT "session_context_exclusion_selector_check" CHECK(json_valid("target_selector")),
          CONSTRAINT "session_context_exclusion_dependency_check" CHECK(("dependency_group" IS NULL OR length("dependency_group") > 0)),
          CONSTRAINT "session_context_exclusion_reason_check" CHECK("reason" IN ('exact_duplicate', 'superseded_authority', 'terminal_intermediate', 'stale_tool_result', 'provider_rebase')),
          CONSTRAINT "session_context_exclusion_manifest_check" CHECK(length("manifest_digest") = 64 AND "manifest_digest" NOT GLOB '*[^0-9a-f]*')
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_revision\` (
          \`session_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`parent_revision\` integer,
          \`manifest_digest\` text,
          \`covered_through_message_id\` text,
          \`covered_through_seq\` integer,
          \`activation_event_id\` text,
          \`activation_sequence\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_context_revision_pk\` PRIMARY KEY(\`session_id\`, \`revision\`),
          CONSTRAINT \`fk_session_context_revision_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_context_revision_manifest_digest_compaction_manifest_blob_digest_fk\` FOREIGN KEY (\`manifest_digest\`) REFERENCES \`compaction_manifest_blob\`(\`digest\`) ON DELETE RESTRICT,
          CONSTRAINT \`session_context_revision_parent_fk\` FOREIGN KEY (\`session_id\`,\`parent_revision\`) REFERENCES \`session_context_revision\`(\`session_id\`,\`revision\`) ON DELETE CASCADE,
          CONSTRAINT "session_context_revision_lineage_check" CHECK(("revision" = 0 AND "parent_revision" IS NULL) OR ("revision" > 0 AND "parent_revision" = "revision" - 1)),
          CONSTRAINT "session_context_revision_manifest_check" CHECK(("manifest_digest" IS NULL OR (length("manifest_digest") = 64 AND "manifest_digest" NOT GLOB '*[^0-9a-f]*'))),
          CONSTRAINT "session_context_revision_boundary_check" CHECK(("covered_through_message_id" IS NULL AND "covered_through_seq" IS NULL) OR (length("covered_through_message_id") > 0 AND typeof("covered_through_seq") = 'integer' AND "covered_through_seq" >= 0)),
          CONSTRAINT "session_context_revision_activation_check" CHECK(("activation_event_id" IS NULL AND "activation_sequence" IS NULL) OR (length("activation_event_id") > 0 AND typeof("activation_sequence") = 'integer' AND "activation_sequence" >= 0)),
          CONSTRAINT "session_context_revision_time_check" CHECK(typeof("time_created") = 'integer' AND "time_created" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_state\` (
          \`session_id\` text PRIMARY KEY,
          \`status\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`manifest_digest\` text,
          \`covered_through_message_id\` text,
          \`covered_through_seq\` integer,
          \`activated_event_id\` text,
          \`time_activated\` integer,
          \`error_code\` text,
          CONSTRAINT \`fk_session_context_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_context_state_manifest_digest_compaction_manifest_blob_digest_fk\` FOREIGN KEY (\`manifest_digest\`) REFERENCES \`compaction_manifest_blob\`(\`digest\`) ON DELETE RESTRICT,
          CONSTRAINT \`session_context_state_revision_fk\` FOREIGN KEY (\`session_id\`,\`revision\`) REFERENCES \`session_context_revision\`(\`session_id\`,\`revision\`) ON DELETE CASCADE,
          CONSTRAINT "session_context_state_status_check" CHECK("status" IN ('active', 'quarantined')),
          CONSTRAINT "session_context_state_revision_check" CHECK(typeof("revision") = 'integer' AND "revision" >= 0),
          CONSTRAINT "session_context_state_manifest_check" CHECK(("manifest_digest" IS NULL OR (length("manifest_digest") = 64 AND "manifest_digest" NOT GLOB '*[^0-9a-f]*'))),
          CONSTRAINT "session_context_state_boundary_check" CHECK(("covered_through_message_id" IS NULL AND "covered_through_seq" IS NULL) OR (length("covered_through_message_id") > 0 AND typeof("covered_through_seq") = 'integer' AND "covered_through_seq" >= 0)),
          CONSTRAINT "session_context_state_activation_check" CHECK(("activated_event_id" IS NULL AND "time_activated" IS NULL) OR (length("activated_event_id") > 0 AND typeof("time_activated") = 'integer' AND "time_activated" >= 0)),
          CONSTRAINT "session_context_state_error_check" CHECK(("status" = 'active' AND "error_code" IS NULL) OR ("status" = 'quarantined' AND length("error_code") > 0))
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_pending\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          \`delivery\` text,
          \`admitted_seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_pending_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`session_provider_continuation\` (
          \`session_id\` text PRIMARY KEY,
          \`response_id\` text NOT NULL,
          \`represented_through_message_id\` text,
          \`represented_message_count\` integer NOT NULL,
          \`context_revision\` integer NOT NULL,
          \`continuation_generation\` integer NOT NULL,
          \`provider\` text NOT NULL,
          \`route_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`variant\` text,
          \`connection_identity_digest\` text NOT NULL,
          \`prompt_cache_key\` text NOT NULL,
          \`instructions_digest\` text NOT NULL,
          \`tools_digest\` text NOT NULL,
          \`options_digest\` text NOT NULL,
          \`volatile_context_digest\` text NOT NULL,
          \`continuation_fingerprint\` text NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_provider_continuation_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`session_provider_continuation_revision_fk\` FOREIGN KEY (\`session_id\`,\`context_revision\`) REFERENCES \`session_context_revision\`(\`session_id\`,\`revision\`) ON DELETE CASCADE,
          CONSTRAINT "session_provider_continuation_response_check" CHECK(length("response_id") > 0),
          CONSTRAINT "session_provider_continuation_boundary_check" CHECK(("represented_message_count" = 0 AND "represented_through_message_id" IS NULL) OR ("represented_message_count" > 0 AND length("represented_through_message_id") > 0)),
          CONSTRAINT "session_provider_continuation_counts_check" CHECK(typeof("represented_message_count") = 'integer' AND "represented_message_count" >= 0 AND typeof("context_revision") = 'integer' AND "context_revision" >= 0 AND typeof("continuation_generation") = 'integer' AND "continuation_generation" >= 0),
          CONSTRAINT "session_provider_continuation_identity_check" CHECK(length("provider") > 0 AND length("route_id") > 0 AND length("model_id") > 0 AND ("variant" IS NULL OR length("variant") > 0) AND length("prompt_cache_key") > 0),
          CONSTRAINT "session_provider_continuation_digest_check" CHECK(length("connection_identity_digest") = 64 AND "connection_identity_digest" NOT GLOB '*[^0-9a-f]*' AND length("instructions_digest") = 64 AND "instructions_digest" NOT GLOB '*[^0-9a-f]*' AND length("tools_digest") = 64 AND "tools_digest" NOT GLOB '*[^0-9a-f]*' AND length("options_digest") = 64 AND "options_digest" NOT GLOB '*[^0-9a-f]*' AND length("volatile_context_digest") = 64 AND "volatile_context_digest" NOT GLOB '*[^0-9a-f]*' AND length("continuation_fingerprint") = 64 AND "continuation_fingerprint" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "session_provider_continuation_time_check" CHECK(typeof("time_updated") = 'integer' AND "time_updated" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_provider_request\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`input_id\` text,
          \`usage_anchor\` text,
          \`assistant_message_id\` text,
          \`connection_identity_digest\` text,
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
          \`cache_read_reported\` integer,
          \`timing\` text,
          \`outcome\` text,
          \`cost\` real,
          \`tokens\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_provider_request_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_provider_state_blob\` (
          \`digest\` text PRIMARY KEY,
          \`provider\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`item_type\` text NOT NULL,
          \`content\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT "session_provider_state_blob_digest_check" CHECK(length("digest") = 64 AND "digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "session_provider_state_blob_identity_check" CHECK(length("provider") > 0 AND length("model_id") > 0 AND length("item_type") > 0),
          CONSTRAINT "session_provider_state_blob_content_check" CHECK(json_valid("content")),
          CONSTRAINT "session_provider_state_blob_time_check" CHECK(typeof("time_created") = 'integer' AND "time_created" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_provider_state_link\` (
          \`session_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`part_ordinal\` integer NOT NULL,
          \`part_kind\` text NOT NULL,
          \`provider\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`blob_digest\` text NOT NULL,
          \`context_revision\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`session_provider_state_link_pk\` PRIMARY KEY(\`session_id\`, \`message_id\`, \`part_ordinal\`, \`part_kind\`),
          CONSTRAINT \`fk_session_provider_state_link_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_provider_state_link_blob_digest_session_provider_state_blob_digest_fk\` FOREIGN KEY (\`blob_digest\`) REFERENCES \`session_provider_state_blob\`(\`digest\`) ON DELETE RESTRICT,
          CONSTRAINT \`session_provider_state_link_revision_fk\` FOREIGN KEY (\`session_id\`,\`context_revision\`) REFERENCES \`session_context_revision\`(\`session_id\`,\`revision\`) ON DELETE CASCADE,
          CONSTRAINT "session_provider_state_link_message_check" CHECK(length("message_id") > 0),
          CONSTRAINT "session_provider_state_link_ordinal_check" CHECK(typeof("part_ordinal") = 'integer' AND "part_ordinal" >= 0),
          CONSTRAINT "session_provider_state_link_identity_check" CHECK(length("part_kind") > 0 AND length("provider") > 0 AND length("model_id") > 0),
          CONSTRAINT "session_provider_state_link_blob_check" CHECK(length("blob_digest") = 64 AND "blob_digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "session_provider_state_link_revision_check" CHECK(typeof("context_revision") = 'integer' AND "context_revision" >= 0),
          CONSTRAINT "session_provider_state_link_time_check" CHECK(typeof("time_created") = 'integer' AND "time_created" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`scope\` text DEFAULT 'bound' NOT NULL,
          \`project_id\` text NOT NULL,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`fork_session_id\` text,
          \`fork_message_id\` text,
          \`fork_seq\` integer,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`usage_pruned_through\` integer,
          \`revert\` text,
          \`permission\` text,
          \`autonomy\` text,
          \`autonomy_revision\` integer DEFAULT 0 NOT NULL,
          \`orchestration_revision\` integer DEFAULT 0 NOT NULL,
          \`agent\` text,
          \`model\` text,
          \`profile_binding\` text,
          \`daybreak\` text,
          \`origin\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_archived\` integer,
          \`time_active\` integer,
          \`time_pinned\` integer,
          \`time_suspended\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "session_scope_check" CHECK("scope" IN ('bound', 'standalone'))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_task_notification\` (
          \`id\` text PRIMARY KEY,
          \`task_session_id\` text NOT NULL,
          \`parent_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`excerpt\` text,
          \`delivered\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_delivered\` integer,
          CONSTRAINT \`fk_session_task_notification_task_session_id_session_task_session_id_fk\` FOREIGN KEY (\`task_session_id\`) REFERENCES \`session_task\`(\`session_id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_notification_parent_id_session_id_fk\` FOREIGN KEY (\`parent_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_task\` (
          \`session_id\` text PRIMARY KEY,
          \`parent_id\` text NOT NULL,
          \`parent_assistant_message_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`input_id\` text NOT NULL UNIQUE,
          \`usage_anchor\` text,
          \`description\` text NOT NULL,
          \`agent\` text NOT NULL,
          \`model\` text NOT NULL,
          \`prompt_digest\` text NOT NULL,
          \`background\` integer NOT NULL,
          \`delivery\` text NOT NULL,
          \`state\` text NOT NULL,
          \`progress\` text,
          \`progress_time\` integer,
          \`question_id\` text,
          \`question\` text,
          \`question_data\` text,
          \`question_time\` integer,
          \`attempt_started\` integer DEFAULT false NOT NULL,
          \`owner_pid\` integer,
          \`owner_started\` text,
          \`revision\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_task_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_session_task_parent_id_session_id_fk\` FOREIGN KEY (\`parent_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_todo_state\` (
          \`session_id\` text PRIMARY KEY,
          \`revision\` integer NOT NULL,
          \`digest\` text NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_todo_state_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "session_todo_state_revision_check" CHECK(typeof("revision") = 'integer' AND "revision" >= 0),
          CONSTRAINT "session_todo_state_digest_check" CHECK(length("digest") = 64 AND "digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "session_todo_state_time_check" CHECK(typeof("time_updated") = 'integer' AND "time_updated" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_session_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
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
        CREATE TABLE \`shell\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text,
          \`pid\` integer NOT NULL,
          \`process_started\` text,
          \`owner_pid\` integer NOT NULL,
          \`owner_started\` text NOT NULL,
          \`notice_pending\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_lost\` integer,
          \`start_seq\` integer DEFAULT -1 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`telemetry_consent\` (
          \`id\` integer PRIMARY KEY,
          \`enabled\` integer NOT NULL,
          \`notice_version\` integer NOT NULL,
          \`decided_at\` integer NOT NULL,
          CONSTRAINT "telemetry_consent_single_row" CHECK("id" = 1)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`web_latency\` (
          \`id\` integer PRIMARY KEY AUTOINCREMENT,
          \`received_at\` integer NOT NULL,
          \`sample\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`usage_analytics_request_time_created_id_idx\` ON \`usage_analytics_request\` (\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_analytics_request_unpriced_time_created_id_idx\` ON \`usage_analytics_request\` (\`time_created\`,\`id\`) WHERE cost IS NULL AND source <> 'decision';`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_analytics_request_metrics_idx\` ON \`usage_analytics_request\` (\`time_created\`,\`id\`,\`session_id\`,\`project_id\`,\`directory\`,\`workspace_id\`,\`session_updated\`,\`agent\`,\`source\`,\`model\`,\`usage_anchor\`,\`task_path\`,\`request\`,\`attempts\`,\`continuation\`,\`cache_read_reported\`,\`cost\`,json_extract(tokens, '$.input'),json_extract(tokens, '$.output'),json_extract(tokens, '$.reasoning'),json_extract(tokens, '$.cache.read'),json_extract(tokens, '$.cache.write'),json_extract(timing, '$.firstOutputMs'),json_extract(timing, '$.totalMs'),json_extract(timing, '$.generatedTokens'),json_extract(timing, '$.generationDurationNs'),json_extract(timing, '$.observedGenerationDurationNs'),json_type(timing, '$.generationDurationNs'));`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_usage_cell_session_span_bucket_key_idx\` ON \`session_usage_cell\` (\`session_id\`,\`span\`,\`bucket\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_usage_cell_unpriced_idx\` ON \`session_usage_cell\` (\`session_id\`,\`span\`,\`bucket\`,\`key\`) WHERE unpriced > 0;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`usage_analytics_cell_span_bucket_key_idx\` ON \`usage_analytics_cell\` (\`span\`,\`bucket\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_analytics_cell_unpriced_idx\` ON \`usage_analytics_cell\` (\`span\`,\`bucket\`,\`key\`) WHERE unpriced > 0;`,
      )
      yield* tx.run(`CREATE INDEX \`usage_view_presentation_state_idx\` ON \`usage_view_presentation\` (\`state\`);`)
      yield* tx.run(
        `CREATE INDEX \`usage_view_presentation_time_used_idx\` ON \`usage_view_presentation\` (\`time_used\`);`,
      )
      yield* tx.run(`CREATE INDEX \`usage_view_ref_location_idx\` ON \`usage_view_ref\` (\`location\`);`)
      yield* tx.run(
        `CREATE INDEX \`usage_view_row_cost_idx\` ON \`usage_view_row\` (\`state\`,\`generation\`,\`total_cost\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_view_row_tokens_idx\` ON \`usage_view_row\` (\`state\`,\`generation\`,\`total_tokens\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_view_row_steps_idx\` ON \`usage_view_row\` (\`state\`,\`generation\`,\`logical\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_view_row_input_idx\` ON \`usage_view_row\` (\`state\`,\`generation\`,\`input\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_view_row_output_idx\` ON \`usage_view_row\` (\`state\`,\`generation\`,\`output\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_view_row_reasoning_idx\` ON \`usage_view_row\` (\`state\`,\`generation\`,\`reasoning\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_view_row_cache_read_idx\` ON \`usage_view_row\` (\`state\`,\`generation\`,\`cache_read\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_view_row_cache_write_idx\` ON \`usage_view_row\` (\`state\`,\`generation\`,\`cache_write\`,\`key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`usage_view_row_hour_idx\` ON \`usage_view_row\` (\`state\`,\`generation\`,strftime('%s', "key"),\`key\`);`,
      )
      yield* tx.run(`CREATE INDEX \`usage_view_state_status_idx\` ON \`usage_view_state\` (\`status\`);`)
      yield* tx.run(`CREATE INDEX \`usage_view_state_time_used_idx\` ON \`usage_view_state\` (\`time_used\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`coordination_group_master_idx\` ON \`coordination_group\` (\`master_session_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`coordination_group_updated_idx\` ON \`coordination_group\` (\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`coordination_member_owner_idx\` ON \`coordination_member\` (\`owner_session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`coordination_member_session_idx\` ON \`coordination_member\` (\`session_id\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE INDEX \`event_review_type_aggregate_seq_idx\` ON \`event\` (\`type\`,\`aggregate_id\`,\`seq\`) WHERE "event"."type" IN ('session.review.deferred.1', 'session.review.decided.1', 'session.review.withdrawn.1', 'session.review.consumed.1');`,
      )
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
      yield* tx.run(
        `CREATE INDEX \`model_incident_time_created_id_idx\` ON \`model_incident\` (\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`model_incident_model_time_idx\` ON \`model_incident\` (\`provider_id\`,\`model_id\`,\`time_created\`);`,
      )
      yield* tx.run(`CREATE INDEX \`model_incident_request_id_idx\` ON \`model_incident\` (\`request_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
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
        `CREATE INDEX \`session_compaction_job_session_ended_idx\` ON \`session_compaction_job\` (\`session_id\`,\`time_ended\`) WHERE "session_compaction_job"."status" = 'ended';`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_compaction_job_manifest_idx\` ON \`session_compaction_job\` (\`manifest_digest\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_context_exclusion_current_target_idx\` ON \`session_context_exclusion\` (\`session_id\`,\`target_key\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_context_exclusion_manifest_idx\` ON \`session_context_exclusion\` (\`manifest_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_file_change_path_session_idx\` ON \`session_file_change\` (\`path\`,\`session_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_pending_session_delivery_seq_idx\` ON \`session_pending\` (\`session_id\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_pending_session_admitted_seq_idx\` ON \`session_pending\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_provider_request_session_request_idx\` ON \`session_provider_request\` (\`session_id\`,\`request\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_provider_request_session_source_idx\` ON \`session_provider_request\` (\`session_id\`,\`source\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_provider_request_time_created_idx\` ON \`session_provider_request\` (\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_provider_state_link_blob_idx\` ON \`session_provider_state_link\` (\`blob_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_provider_state_link_revision_idx\` ON \`session_provider_state_link\` (\`session_id\`,\`context_revision\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_time_updated_id_idx\` ON \`session\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_active_goal_idx\` ON \`session\` (\`id\`) WHERE json_extract("session"."autonomy", '$.goal.status') = 'active';`,
      )
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
      yield* tx.run(
        `CREATE INDEX \`session_time_suspended_idx\` ON \`session\` (\`time_suspended\`) WHERE "session"."time_suspended" is not null;`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_pinned_time_updated_id_idx\` ON \`session\` (\`time_updated\`,\`id\`) WHERE "session"."time_pinned" is not null;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_notification_transition_idx\` ON \`session_task_notification\` (\`task_session_id\`,\`type\`,\`revision\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_notification_delivery_idx\` ON \`session_task_notification\` (\`delivered\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_task_launch_identity_idx\` ON \`session_task\` (\`parent_id\`,\`parent_assistant_message_id\`,\`tool_call_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_task_parent_state_updated_idx\` ON \`session_task\` (\`parent_id\`,\`state\`,\`time_updated\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_todo_session_idx\` ON \`session_todo\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`web_latency_received_at_idx\` ON \`web_latency\` (\`received_at\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
