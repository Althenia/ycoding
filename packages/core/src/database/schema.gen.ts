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
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
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
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT "credential_generation_check" CHECK(typeof("generation") = 'integer' AND "generation" >= 0)
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
        CREATE TABLE \`project_artifact_activation\` (
          \`id\` text PRIMARY KEY,
          \`scope_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`version_id\` text NOT NULL,
          \`project_id\` text,
          \`session_id\` text,
          \`agent_id\` text,
          \`source\` text NOT NULL,
          \`message_id\` text,
          \`call_id\` text,
          \`boundary_seq\` integer NOT NULL,
          \`activated_at\` integer NOT NULL,
          \`deactivated_at\` integer,
          CONSTRAINT \`project_artifact_activation_version_owner_fk\` FOREIGN KEY (\`version_id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) ON DELETE CASCADE,
          CONSTRAINT "project_artifact_activation_id_check" CHECK(length("id") BETWEEN 5 AND 64 AND substr("id", 1, 4) = 'paa_' AND substr("id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("id", 5, 1) GLOB '[a-z0-9]' AND substr("id", -1, 1) GLOB '[a-z0-9]'),
          CONSTRAINT "project_artifact_activation_source_check" CHECK("source" IN ('skill-tool', 'session-skill', 'command', 'agent-selected', 'subagent-launch', 'manual')),
          CONSTRAINT "project_artifact_activation_session_check" CHECK(("session_id" IS NULL OR (length("session_id") >= 3 AND substr("session_id", 1, 3) = 'ses'))),
          CONSTRAINT "project_artifact_activation_optional_id_check" CHECK(("message_id" IS NULL OR length("message_id") > 0) AND ("call_id" IS NULL OR length("call_id") > 0)),
          CONSTRAINT "project_artifact_activation_number_check" CHECK(typeof("boundary_seq") = 'integer' AND "boundary_seq" >= 0 AND typeof("activated_at") = 'integer' AND "activated_at" >= 0 AND ("deactivated_at" IS NULL OR (typeof("deactivated_at") = 'integer' AND "deactivated_at" >= 0)))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_feedback\` (
          \`id\` text PRIMARY KEY,
          \`scope_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`version_id\` text NOT NULL,
          \`action\` text NOT NULL,
          \`actor\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_artifact_feedback_version_owner_fk\` FOREIGN KEY (\`version_id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) ON DELETE CASCADE,
          CONSTRAINT "project_artifact_feedback_id_check" CHECK(length("id") BETWEEN 5 AND 64 AND substr("id", 1, 4) = 'paf_' AND substr("id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("id", 5, 1) GLOB '[a-z0-9]' AND substr("id", -1, 1) GLOB '[a-z0-9]'),
          CONSTRAINT "project_artifact_feedback_action_check" CHECK("action" IN ('disable', 'delete', 'revert', 'restore', 'enable', 'promote')),
          CONSTRAINT "project_artifact_feedback_actor_check" CHECK("actor" IN ('user', 'automatic-governor')),
          CONSTRAINT "project_artifact_feedback_time_check" CHECK(typeof("time_created") = 'integer' AND "time_created" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_global_scope\` (
          \`scope_id\` text PRIMARY KEY,
          \`scope_type\` text GENERATED ALWAYS AS ('global') VIRTUAL,
          \`singleton\` integer NOT NULL,
          CONSTRAINT \`project_artifact_global_scope_parent_fk\` FOREIGN KEY (\`scope_id\`,\`scope_type\`) REFERENCES \`project_artifact_scope\`(\`id\`,\`type\`) ON DELETE CASCADE,
          CONSTRAINT "project_artifact_global_scope_singleton_check" CHECK("singleton" = 1)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_legacy_cleanup\` (
          \`id\` integer PRIMARY KEY,
          \`status\` text NOT NULL,
          \`cursor\` text,
          \`attempts\` integer NOT NULL,
          \`removed_count\` integer NOT NULL,
          \`skipped_count\` integer NOT NULL,
          \`failed_count\` integer NOT NULL,
          \`error_code\` text,
          \`last_attempt_at\` integer,
          \`completed_at\` integer,
          CONSTRAINT "project_artifact_legacy_cleanup_singleton_check" CHECK("id" = 1),
          CONSTRAINT "project_artifact_legacy_cleanup_status_check" CHECK("status" IN ('pending', 'partial', 'complete', 'failed')),
          CONSTRAINT "project_artifact_legacy_cleanup_counts_check" CHECK(typeof("attempts") = 'integer' AND "attempts" >= 0 AND typeof("removed_count") = 'integer' AND "removed_count" >= 0 AND typeof("skipped_count") = 'integer' AND "skipped_count" >= 0 AND typeof("failed_count") = 'integer' AND "failed_count" >= 0),
          CONSTRAINT "project_artifact_legacy_cleanup_time_check" CHECK(("last_attempt_at" IS NULL OR (typeof("last_attempt_at") = 'integer' AND "last_attempt_at" >= 0)) AND ("completed_at" IS NULL OR (typeof("completed_at") = 'integer' AND "completed_at" >= 0)))
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_observation\` (
          \`id\` text PRIMARY KEY,
          \`scope_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`version_id\` text NOT NULL,
          \`project_id\` text,
          \`session_id\` text,
          \`activation_set_digest\` text NOT NULL,
          \`active_artifact_count\` integer NOT NULL,
          \`external_confounded\` integer NOT NULL,
          \`eligible\` integer NOT NULL,
          \`terminal_outcome\` text NOT NULL,
          \`goal_status\` text NOT NULL,
          \`repeat_fix\` integer NOT NULL,
          \`latency_ms\` integer,
          \`input_tokens\` integer,
          \`output_tokens\` integer,
          \`cache_read_tokens\` integer,
          \`completed_tool_count\` integer,
          \`failed_tool_count\` integer,
          \`terminal_message_id\` text,
          \`observed_at\` integer NOT NULL,
          CONSTRAINT \`project_artifact_observation_version_owner_fk\` FOREIGN KEY (\`version_id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) ON DELETE CASCADE,
          CONSTRAINT "project_artifact_observation_id_check" CHECK(length("id") BETWEEN 5 AND 64 AND substr("id", 1, 4) = 'pao_' AND substr("id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("id", 5, 1) GLOB '[a-z0-9]' AND substr("id", -1, 1) GLOB '[a-z0-9]'),
          CONSTRAINT "project_artifact_observation_digest_check" CHECK(length("activation_set_digest") = 64 AND "activation_set_digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "project_artifact_observation_terminal_check" CHECK("terminal_outcome" IN ('succeeded', 'failed', 'interrupted')),
          CONSTRAINT "project_artifact_observation_goal_check" CHECK("goal_status" IN ('none', 'completed', 'stopped', 'exhausted')),
          CONSTRAINT "project_artifact_observation_session_check" CHECK(("session_id" IS NULL OR (length("session_id") >= 3 AND substr("session_id", 1, 3) = 'ses'))),
          CONSTRAINT "project_artifact_observation_message_check" CHECK(("terminal_message_id" IS NULL OR length("terminal_message_id") > 0)),
          CONSTRAINT "project_artifact_observation_boolean_check" CHECK(typeof("external_confounded") = 'integer' AND "external_confounded" IN (0, 1) AND typeof("eligible") = 'integer' AND "eligible" IN (0, 1) AND typeof("repeat_fix") = 'integer' AND "repeat_fix" IN (0, 1)),
          CONSTRAINT "project_artifact_observation_number_check" CHECK(typeof("active_artifact_count") = 'integer' AND "active_artifact_count" >= 0 AND ("latency_ms" IS NULL OR (typeof("latency_ms") = 'integer' AND "latency_ms" >= 0)) AND ("input_tokens" IS NULL OR (typeof("input_tokens") = 'integer' AND "input_tokens" >= 0)) AND ("output_tokens" IS NULL OR (typeof("output_tokens") = 'integer' AND "output_tokens" >= 0)) AND ("cache_read_tokens" IS NULL OR (typeof("cache_read_tokens") = 'integer' AND "cache_read_tokens" >= 0)) AND ("completed_tool_count" IS NULL OR (typeof("completed_tool_count") = 'integer' AND "completed_tool_count" >= 0)) AND ("failed_tool_count" IS NULL OR (typeof("failed_tool_count") = 'integer' AND "failed_tool_count" >= 0)) AND typeof("observed_at") = 'integer' AND "observed_at" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_operation\` (
          \`id\` text PRIMARY KEY,
          \`scope_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`operation\` text NOT NULL,
          \`request_fingerprint\` text NOT NULL,
          \`expected_revision\` integer,
          \`expected_version_id\` text,
          \`expected_digest\` text,
          \`source_scope_id\` text,
          \`source_version_id\` text,
          \`source_digest\` text,
          \`target_version_id\` text,
          \`target_digest\` text,
          \`final_version_id\` text,
          \`deletion_id\` text,
          \`automatic_session_id\` text,
          \`automatic_insight_digest\` text,
          \`phase\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_project_artifact_operation_scope_id_project_artifact_scope_id_fk\` FOREIGN KEY (\`scope_id\`) REFERENCES \`project_artifact_scope\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`project_artifact_operation_expected_owner_fk\` FOREIGN KEY (\`expected_version_id\`,\`scope_id\`,\`kind\`,\`artifact_id\`,\`expected_digest\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`,\`content_digest\`) ON DELETE RESTRICT,
          CONSTRAINT \`project_artifact_operation_source_owner_fk\` FOREIGN KEY (\`source_version_id\`,\`source_scope_id\`,\`kind\`,\`artifact_id\`,\`source_digest\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`,\`content_digest\`) ON DELETE RESTRICT,
          CONSTRAINT \`project_artifact_operation_final_owner_fk\` FOREIGN KEY (\`final_version_id\`,\`scope_id\`,\`kind\`,\`artifact_id\`,\`target_digest\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`,\`content_digest\`) ON DELETE RESTRICT,
          CONSTRAINT "project_artifact_operation_id_check" CHECK(length("id") BETWEEN 5 AND 64 AND substr("id", 1, 4) = 'pop_' AND substr("id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("id", 5, 1) GLOB '[a-z0-9]' AND substr("id", -1, 1) GLOB '[a-z0-9]'),
          CONSTRAINT "project_artifact_operation_artifact_id_check" CHECK(length("artifact_id") BETWEEN 1 AND 64 AND "artifact_id" NOT GLOB '*[^a-z0-9-]*' AND substr("artifact_id", 1, 1) GLOB '[a-z0-9]' AND substr("artifact_id", -1, 1) GLOB '[a-z0-9]' AND "artifact_id" NOT IN ('aux', 'clock$', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'con', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9', 'nul', 'prn')),
          CONSTRAINT "project_artifact_operation_kind_check" CHECK("kind" IN ('skill', 'command', 'agent', 'plugin')),
          CONSTRAINT "project_artifact_operation_operation_check" CHECK("operation" IN ('create', 'update', 'promotion', 'fork', 'shadow', 'remove', 'restore', 'disable', 'enable', 'revert', 'purge')),
          CONSTRAINT "project_artifact_operation_phase_check" CHECK("phase" IN ('preparing', 'available', 'finalized', 'aborted')),
          CONSTRAINT "project_artifact_operation_digest_check" CHECK(length("request_fingerprint") = 64 AND "request_fingerprint" NOT GLOB '*[^0-9a-f]*' AND ("expected_digest" IS NULL OR (length("expected_digest") = 64 AND "expected_digest" NOT GLOB '*[^0-9a-f]*')) AND ("source_digest" IS NULL OR (length("source_digest") = 64 AND "source_digest" NOT GLOB '*[^0-9a-f]*')) AND ("target_digest" IS NULL OR (length("target_digest") = 64 AND "target_digest" NOT GLOB '*[^0-9a-f]*')) AND ("automatic_insight_digest" IS NULL OR (length("automatic_insight_digest") = 64 AND "automatic_insight_digest" NOT GLOB '*[^0-9a-f]*'))),
          CONSTRAINT "project_artifact_operation_version_id_check" CHECK(("expected_version_id" IS NULL OR (length("expected_version_id") BETWEEN 5 AND 64 AND substr("expected_version_id", 1, 4) = 'pav_' AND substr("expected_version_id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("expected_version_id", 5, 1) GLOB '[a-z0-9]' AND substr("expected_version_id", -1, 1) GLOB '[a-z0-9]')) AND ("source_version_id" IS NULL OR (length("source_version_id") BETWEEN 5 AND 64 AND substr("source_version_id", 1, 4) = 'pav_' AND substr("source_version_id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("source_version_id", 5, 1) GLOB '[a-z0-9]' AND substr("source_version_id", -1, 1) GLOB '[a-z0-9]')) AND ("target_version_id" IS NULL OR (length("target_version_id") BETWEEN 5 AND 64 AND substr("target_version_id", 1, 4) = 'pav_' AND substr("target_version_id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("target_version_id", 5, 1) GLOB '[a-z0-9]' AND substr("target_version_id", -1, 1) GLOB '[a-z0-9]')) AND ("final_version_id" IS NULL OR (length("final_version_id") BETWEEN 5 AND 64 AND substr("final_version_id", 1, 4) = 'pav_' AND substr("final_version_id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("final_version_id", 5, 1) GLOB '[a-z0-9]' AND substr("final_version_id", -1, 1) GLOB '[a-z0-9]'))),
          CONSTRAINT "project_artifact_operation_deletion_id_check" CHECK(("deletion_id" IS NULL OR (length("deletion_id") BETWEEN 5 AND 64 AND substr("deletion_id", 1, 4) = 'pad_' AND substr("deletion_id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("deletion_id", 5, 1) GLOB '[a-z0-9]' AND substr("deletion_id", -1, 1) GLOB '[a-z0-9]'))),
          CONSTRAINT "project_artifact_operation_session_check" CHECK(("automatic_session_id" IS NULL OR (length("automatic_session_id") >= 3 AND substr("automatic_session_id", 1, 3) = 'ses'))),
          CONSTRAINT "project_artifact_operation_expectation_check" CHECK(("expected_revision" IS NULL AND "expected_version_id" IS NULL AND "expected_digest" IS NULL) OR ("expected_revision" IS NOT NULL AND "expected_version_id" IS NOT NULL AND "expected_digest" IS NOT NULL)),
          CONSTRAINT "project_artifact_operation_source_check" CHECK(("operation" IN ('promotion', 'fork', 'shadow') AND "source_scope_id" IS NOT NULL AND "source_version_id" IS NOT NULL AND "source_digest" IS NOT NULL) OR ("operation" NOT IN ('promotion', 'fork', 'shadow') AND "source_scope_id" IS NULL AND "source_version_id" IS NULL AND "source_digest" IS NULL)),
          CONSTRAINT "project_artifact_operation_target_check" CHECK(("target_version_id" IS NULL AND "target_digest" IS NULL) OR ("target_version_id" IS NOT NULL AND "target_digest" IS NOT NULL)),
          CONSTRAINT "project_artifact_operation_automatic_check" CHECK(("automatic_session_id" IS NULL AND "automatic_insight_digest" IS NULL) OR ("automatic_session_id" IS NOT NULL AND "automatic_insight_digest" IS NOT NULL)),
          CONSTRAINT "project_artifact_operation_finalization_check" CHECK(("phase" <> 'finalized' AND "final_version_id" IS NULL) OR ("phase" = 'finalized' AND (("operation" IN ('remove', 'purge') AND "final_version_id" IS NULL) OR ("operation" NOT IN ('remove', 'purge') AND "final_version_id" IS NOT NULL AND "target_version_id" IS NOT NULL AND "target_digest" IS NOT NULL AND "target_version_id" = "final_version_id")))),
          CONSTRAINT "project_artifact_operation_final_target_check" CHECK("target_version_id" IS NULL OR "final_version_id" IS NULL OR "target_version_id" = "final_version_id"),
          CONSTRAINT "project_artifact_operation_deletion_check" CHECK(("operation" IN ('remove', 'restore', 'purge') AND "deletion_id" IS NOT NULL) OR ("operation" NOT IN ('remove', 'restore', 'purge') AND "deletion_id" IS NULL)),
          CONSTRAINT "project_artifact_operation_time_check" CHECK(("expected_revision" IS NULL OR (typeof("expected_revision") = 'integer' AND "expected_revision" >= 0)) AND typeof("time_created") = 'integer' AND "time_created" >= 0 AND typeof("time_updated") = 'integer' AND "time_updated" >= 0 AND "time_updated" >= "time_created")
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_project_scope\` (
          \`scope_id\` text PRIMARY KEY,
          \`scope_type\` text GENERATED ALWAYS AS ('project') VIRTUAL,
          \`project_id\` text NOT NULL,
          CONSTRAINT \`fk_project_artifact_project_scope_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`project_artifact_project_scope_parent_fk\` FOREIGN KEY (\`scope_id\`,\`scope_type\`) REFERENCES \`project_artifact_scope\`(\`id\`,\`type\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_scope\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`storage_id\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`project_artifact_scope_id_type_unique\` UNIQUE(\`id\`,\`type\`),
          CONSTRAINT "project_artifact_scope_type_check" CHECK("type" IN ('project', 'global')),
          CONSTRAINT "project_artifact_scope_storage_id_check" CHECK(length("storage_id") = 36 AND "storage_id" = lower("storage_id") AND "storage_id" NOT GLOB '*[^0-9a-f-]*' AND length("storage_id") - length(replace("storage_id", '-', '')) = 4 AND substr("storage_id", 9, 1) = '-' AND substr("storage_id", 14, 1) = '-' AND substr("storage_id", 19, 1) = '-' AND substr("storage_id", 24, 1) = '-'),
          CONSTRAINT "project_artifact_scope_id_check" CHECK(length("id") BETWEEN 5 AND 64 AND substr("id", 1, 4) = 'pas_' AND substr("id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("id", 5, 1) GLOB '[a-z0-9]' AND substr("id", -1, 1) GLOB '[a-z0-9]'),
          CONSTRAINT "project_artifact_scope_time_check" CHECK(typeof("time_created") = 'integer' AND "time_created" >= 0 AND typeof("time_updated") = 'integer' AND "time_updated" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact\` (
          \`scope_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`revision\` integer NOT NULL,
          \`stage\` text NOT NULL,
          \`current_version_id\` text NOT NULL,
          \`fallback_version_id\` text,
          \`shadowed_scope_id\` text,
          \`last_used_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`project_artifact_pk\` PRIMARY KEY(\`scope_id\`, \`kind\`, \`artifact_id\`),
          CONSTRAINT \`fk_project_artifact_scope_id_project_artifact_scope_id_fk\` FOREIGN KEY (\`scope_id\`) REFERENCES \`project_artifact_scope\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_project_artifact_shadowed_scope_id_project_artifact_scope_id_fk\` FOREIGN KEY (\`shadowed_scope_id\`) REFERENCES \`project_artifact_scope\`(\`id\`) ON DELETE RESTRICT,
          CONSTRAINT \`project_artifact_current_version_owner_fk\` FOREIGN KEY (\`current_version_id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`),
          CONSTRAINT \`project_artifact_fallback_version_owner_fk\` FOREIGN KEY (\`fallback_version_id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`),
          CONSTRAINT "project_artifact_id_check" CHECK(length("artifact_id") BETWEEN 1 AND 64 AND "artifact_id" NOT GLOB '*[^a-z0-9-]*' AND substr("artifact_id", 1, 1) GLOB '[a-z0-9]' AND substr("artifact_id", -1, 1) GLOB '[a-z0-9]' AND "artifact_id" NOT IN ('aux', 'clock$', 'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9', 'con', 'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9', 'nul', 'prn')),
          CONSTRAINT "project_artifact_revision_check" CHECK(typeof("revision") = 'integer' AND "revision" >= 0),
          CONSTRAINT "project_artifact_kind_check" CHECK("kind" IN ('skill', 'command', 'agent', 'plugin')),
          CONSTRAINT "project_artifact_stage_check" CHECK("stage" IN ('trial', 'active', 'degraded', 'disabled', 'quarantine')),
          CONSTRAINT "project_artifact_time_check" CHECK(("last_used_at" IS NULL OR (typeof("last_used_at") = 'integer' AND "last_used_at" >= 0)) AND typeof("time_created") = 'integer' AND "time_created" >= 0 AND typeof("time_updated") = 'integer' AND "time_updated" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_terminal\` (
          \`id\` text PRIMARY KEY,
          \`project_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`terminal_message_id\` text,
          \`boundary_seq\` integer NOT NULL,
          \`kind\` text NOT NULL,
          \`agent_id\` text,
          \`model_id\` text NOT NULL,
          \`goal_mode\` integer NOT NULL,
          \`managed_activation_count\` integer NOT NULL,
          \`standard_invocation_count\` integer NOT NULL,
          \`external_confounded\` integer NOT NULL,
          \`terminal_outcome\` text NOT NULL,
          \`goal_status\` text NOT NULL,
          \`repeat_fix\` integer NOT NULL,
          \`observed_at\` integer NOT NULL,
          CONSTRAINT \`fk_project_artifact_terminal_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT "project_artifact_terminal_id_check" CHECK(length("id") BETWEEN 5 AND 64 AND substr("id", 1, 4) = 'pat_' AND substr("id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("id", 5, 1) GLOB '[a-z0-9]' AND substr("id", -1, 1) GLOB '[a-z0-9]'),
          CONSTRAINT "project_artifact_terminal_session_check" CHECK(("session_id" IS NULL OR (length("session_id") >= 3 AND substr("session_id", 1, 3) = 'ses'))),
          CONSTRAINT "project_artifact_terminal_message_check" CHECK(("terminal_message_id" IS NULL OR length("terminal_message_id") > 0)),
          CONSTRAINT "project_artifact_terminal_model_check" CHECK(length("model_id") > 0),
          CONSTRAINT "project_artifact_terminal_kind_check" CHECK("kind" IN ('skill', 'command', 'agent', 'plugin')),
          CONSTRAINT "project_artifact_terminal_outcome_check" CHECK("terminal_outcome" IN ('succeeded', 'failed', 'interrupted')),
          CONSTRAINT "project_artifact_terminal_goal_check" CHECK("goal_status" IN ('none', 'completed', 'stopped', 'exhausted')),
          CONSTRAINT "project_artifact_terminal_boolean_check" CHECK(typeof("goal_mode") = 'integer' AND "goal_mode" IN (0, 1) AND typeof("external_confounded") = 'integer' AND "external_confounded" IN (0, 1) AND typeof("repeat_fix") = 'integer' AND "repeat_fix" IN (0, 1)),
          CONSTRAINT "project_artifact_terminal_number_check" CHECK(typeof("boundary_seq") = 'integer' AND "boundary_seq" >= 0 AND typeof("managed_activation_count") = 'integer' AND "managed_activation_count" >= 0 AND typeof("standard_invocation_count") = 'integer' AND "standard_invocation_count" >= 0 AND typeof("observed_at") = 'integer' AND "observed_at" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_trash\` (
          \`deletion_id\` text PRIMARY KEY,
          \`scope_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`prior_stage\` text NOT NULL,
          \`prior_version_id\` text NOT NULL,
          \`deleted_at\` integer NOT NULL,
          \`purge_after\` integer NOT NULL,
          CONSTRAINT \`fk_project_artifact_trash_scope_id_kind_artifact_id_project_artifact_scope_id_kind_artifact_id_fk\` FOREIGN KEY (\`scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact\`(\`scope_id\`,\`kind\`,\`artifact_id\`) ON DELETE CASCADE,
          CONSTRAINT \`project_artifact_trash_prior_version_owner_fk\` FOREIGN KEY (\`prior_version_id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`),
          CONSTRAINT "project_artifact_trash_id_check" CHECK(length("deletion_id") BETWEEN 5 AND 64 AND substr("deletion_id", 1, 4) = 'pad_' AND substr("deletion_id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("deletion_id", 5, 1) GLOB '[a-z0-9]' AND substr("deletion_id", -1, 1) GLOB '[a-z0-9]'),
          CONSTRAINT "project_artifact_trash_stage_check" CHECK("prior_stage" IN ('trial', 'active', 'degraded', 'disabled', 'quarantine')),
          CONSTRAINT "project_artifact_trash_time_check" CHECK(typeof("deleted_at") = 'integer' AND "deleted_at" >= 0 AND typeof("purge_after") = 'integer' AND "purge_after" >= 0),
          CONSTRAINT "project_artifact_trash_expiry_check" CHECK("purge_after" = "deleted_at" + 2592000000)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_version\` (
          \`id\` text PRIMARY KEY,
          \`scope_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`parent_version_id\` text,
          \`state\` text NOT NULL,
          \`content_digest\` text NOT NULL,
          \`content_relpath\` text NOT NULL,
          \`source\` text NOT NULL,
          \`creator_agent_id\` text,
          \`creator_session_id\` text,
          \`insight_digest\` text,
          \`origin_scope_id\` text,
          \`origin_version_id\` text,
          \`origin_evidence_digest\` text,
          \`first_qualified_at\` integer,
          \`last_evaluated_at\` integer,
          \`last_restored_at\` integer,
          \`last_governor_transition_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_state_changed\` integer NOT NULL,
          CONSTRAINT \`fk_project_artifact_version_scope_id_kind_artifact_id_project_artifact_scope_id_kind_artifact_id_fk\` FOREIGN KEY (\`scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact\`(\`scope_id\`,\`kind\`,\`artifact_id\`) ON DELETE CASCADE,
          CONSTRAINT \`project_artifact_version_parent_owner_fk\` FOREIGN KEY (\`parent_version_id\`,\`scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`),
          CONSTRAINT \`project_artifact_version_origin_owner_fk\` FOREIGN KEY (\`origin_version_id\`,\`origin_scope_id\`,\`kind\`,\`artifact_id\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`),
          CONSTRAINT \`project_artifact_version_owner_unique\` UNIQUE(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`),
          CONSTRAINT \`project_artifact_version_digest_owner_unique\` UNIQUE(\`id\`,\`scope_id\`,\`kind\`,\`artifact_id\`,\`content_digest\`),
          CONSTRAINT \`project_artifact_version_write_unique\` UNIQUE(\`id\`,\`scope_id\`,\`content_digest\`),
          CONSTRAINT "project_artifact_version_id_check" CHECK(length("id") BETWEEN 5 AND 64 AND substr("id", 1, 4) = 'pav_' AND substr("id", 5) NOT GLOB '*[^a-z0-9-]*' AND substr("id", 5, 1) GLOB '[a-z0-9]' AND substr("id", -1, 1) GLOB '[a-z0-9]'),
          CONSTRAINT "project_artifact_version_state_check" CHECK("state" IN ('trial', 'active', 'degraded', 'disabled', 'quarantine', 'superseded')),
          CONSTRAINT "project_artifact_version_digest_check" CHECK(length("content_digest") = 64 AND "content_digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "project_artifact_version_optional_digest_check" CHECK(("insight_digest" IS NULL OR (length("insight_digest") = 64 AND "insight_digest" NOT GLOB '*[^0-9a-f]*')) AND ("origin_evidence_digest" IS NULL OR (length("origin_evidence_digest") = 64 AND "origin_evidence_digest" NOT GLOB '*[^0-9a-f]*'))),
          CONSTRAINT "project_artifact_version_relpath_check" CHECK(length("content_relpath") > 0 AND substr("content_relpath", 1, 1) GLOB '[A-Za-z0-9]' AND substr("content_relpath", -1, 1) <> '/' AND "content_relpath" NOT GLOB '*[^A-Za-z0-9._/-]*' AND "content_relpath" NOT GLOB '*//*' AND "content_relpath" NOT GLOB '*/./*' AND "content_relpath" NOT GLOB '*/.' AND "content_relpath" NOT GLOB '*/../*' AND "content_relpath" NOT GLOB '*/..'),
          CONSTRAINT "project_artifact_version_source_check" CHECK("source" IN ('agent', 'user', 'promotion', 'fork', 'restore')),
          CONSTRAINT "project_artifact_version_session_check" CHECK(("creator_session_id" IS NULL OR (length("creator_session_id") >= 3 AND substr("creator_session_id", 1, 3) = 'ses'))),
          CONSTRAINT "project_artifact_version_origin_check" CHECK(("source" IN ('promotion', 'fork') AND "origin_scope_id" IS NOT NULL AND "origin_version_id" IS NOT NULL AND "origin_evidence_digest" IS NOT NULL) OR ("source" IN ('agent', 'user', 'restore') AND "origin_scope_id" IS NULL AND "origin_version_id" IS NULL AND "origin_evidence_digest" IS NULL)),
          CONSTRAINT "project_artifact_version_time_check" CHECK(("first_qualified_at" IS NULL OR (typeof("first_qualified_at") = 'integer' AND "first_qualified_at" >= 0)) AND ("last_evaluated_at" IS NULL OR (typeof("last_evaluated_at") = 'integer' AND "last_evaluated_at" >= 0)) AND ("last_restored_at" IS NULL OR (typeof("last_restored_at") = 'integer' AND "last_restored_at" >= 0)) AND ("last_governor_transition_at" IS NULL OR (typeof("last_governor_transition_at") = 'integer' AND "last_governor_transition_at" >= 0)) AND typeof("time_created") = 'integer' AND "time_created" >= 0 AND typeof("time_state_changed") = 'integer' AND "time_state_changed" >= 0)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`project_artifact_write\` (
          \`scope_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`insight_digest\` text NOT NULL,
          \`operation\` text NOT NULL,
          \`result\` text NOT NULL,
          \`version_id\` text NOT NULL,
          \`content_digest\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`project_artifact_write_pk\` PRIMARY KEY(\`scope_id\`, \`session_id\`, \`insight_digest\`),
          CONSTRAINT \`fk_project_artifact_write_scope_id_project_artifact_scope_id_fk\` FOREIGN KEY (\`scope_id\`) REFERENCES \`project_artifact_scope\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`project_artifact_write_version_owner_fk\` FOREIGN KEY (\`version_id\`,\`scope_id\`,\`content_digest\`) REFERENCES \`project_artifact_version\`(\`id\`,\`scope_id\`,\`content_digest\`) ON DELETE CASCADE,
          CONSTRAINT "project_artifact_write_operation_check" CHECK("operation" IN ('create', 'update', 'reconcile')),
          CONSTRAINT "project_artifact_write_result_check" CHECK("result" IN ('created', 'updated', 'reconciled')),
          CONSTRAINT "project_artifact_write_session_check" CHECK(length("session_id") >= 3 AND substr("session_id", 1, 3) = 'ses'),
          CONSTRAINT "project_artifact_write_digest_check" CHECK(length("insight_digest") = 64 AND "insight_digest" NOT GLOB '*[^0-9a-f]*' AND length("content_digest") = 64 AND "content_digest" NOT GLOB '*[^0-9a-f]*'),
          CONSTRAINT "project_artifact_write_time_check" CHECK(typeof("time_created") = 'integer' AND "time_created" >= 0)
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
          \`trigger\` text NOT NULL,
          \`admission_mode\` text NOT NULL,
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
          CONSTRAINT "session_compaction_job_admission_check" CHECK("admission_mode" IN ('background', 'mandatory')),
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
          \`revert\` text,
          \`permission\` text,
          \`autonomy\` text,
          \`autonomy_revision\` integer DEFAULT 0 NOT NULL,
          \`orchestration_revision\` integer DEFAULT 0 NOT NULL,
          \`agent\` text,
          \`model\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_suspended\` integer,
          CONSTRAINT \`fk_session_project_id_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`project\`(\`id\`) ON DELETE CASCADE
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
        CREATE TABLE \`session_share\` (
          \`session_id\` text PRIMARY KEY,
          \`id\` text NOT NULL,
          \`secret\` text NOT NULL,
          \`url\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_share_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_project_action_resource_idx\` ON \`permission\` (\`project_id\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_activation_identity_idx\` ON \`project_artifact_activation\` (\`session_id\`,\`version_id\`,\`source\`,\`boundary_seq\`) WHERE "project_artifact_activation"."session_id" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_activation_sessionless_identity_idx\` ON \`project_artifact_activation\` (\`version_id\`,\`source\`,\`boundary_seq\`) WHERE "project_artifact_activation"."session_id" IS NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_activation_session_open_idx\` ON \`project_artifact_activation\` (\`session_id\`,\`deactivated_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_feedback_version_created_idx\` ON \`project_artifact_feedback\` (\`version_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_global_scope_singleton_idx\` ON \`project_artifact_global_scope\` (\`singleton\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_observation_version_terminal_idx\` ON \`project_artifact_observation\` (\`version_id\`,\`terminal_message_id\`) WHERE "project_artifact_observation"."terminal_message_id" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_observation_version_session_absent_idx\` ON \`project_artifact_observation\` (\`version_id\`,\`session_id\`) WHERE "project_artifact_observation"."terminal_message_id" IS NULL;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_observation_sessionless_absent_idx\` ON \`project_artifact_observation\` (\`version_id\`) WHERE "project_artifact_observation"."terminal_message_id" IS NULL AND "project_artifact_observation"."session_id" IS NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_observation_version_eligible_observed_idx\` ON \`project_artifact_observation\` (\`version_id\`,\`eligible\`,\`observed_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_operation_request_idx\` ON \`project_artifact_operation\` (\`scope_id\`,\`request_fingerprint\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_operation_automatic_retry_idx\` ON \`project_artifact_operation\` (\`scope_id\`,\`automatic_session_id\`,\`automatic_insight_digest\`) WHERE "project_artifact_operation"."automatic_session_id" IS NOT NULL AND "project_artifact_operation"."automatic_insight_digest" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_operation_active_artifact_idx\` ON \`project_artifact_operation\` (\`scope_id\`,\`kind\`,\`artifact_id\`) WHERE "project_artifact_operation"."phase" IN ('preparing', 'available');`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_operation_recovery_idx\` ON \`project_artifact_operation\` (\`phase\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_project_scope_project_id_idx\` ON \`project_artifact_project_scope\` (\`project_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_scope_storage_id_idx\` ON \`project_artifact_scope\` (\`storage_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_scope_stage_kind_updated_idx\` ON \`project_artifact\` (\`scope_id\`,\`stage\`,\`kind\`,\`time_updated\`,\`artifact_id\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_terminal_message_identity_idx\` ON \`project_artifact_terminal\` (\`session_id\`,\`terminal_message_id\`) WHERE "project_artifact_terminal"."terminal_message_id" IS NOT NULL;`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_terminal_boundary_identity_idx\` ON \`project_artifact_terminal\` (\`session_id\`,\`boundary_seq\`) WHERE "project_artifact_terminal"."terminal_message_id" IS NULL;`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_terminal_cohort_idx\` ON \`project_artifact_terminal\` (\`kind\`,\`agent_id\`,\`model_id\`,\`goal_mode\`,\`observed_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_trash_scope_kind_id_idx\` ON \`project_artifact_trash\` (\`scope_id\`,\`kind\`,\`artifact_id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_trash_purge_after_idx\` ON \`project_artifact_trash\` (\`purge_after\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`project_artifact_version_scope_kind_id_digest_idx\` ON \`project_artifact_version\` (\`scope_id\`,\`kind\`,\`artifact_id\`,\`content_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_version_scope_kind_id_created_idx\` ON \`project_artifact_version\` (\`scope_id\`,\`kind\`,\`artifact_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_write_scope_created_idx\` ON \`project_artifact_write\` (\`scope_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`project_artifact_write_session_created_idx\` ON \`project_artifact_write\` (\`session_id\`,\`time_created\`);`,
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
        `CREATE INDEX \`session_provider_state_link_blob_idx\` ON \`session_provider_state_link\` (\`blob_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_provider_state_link_revision_idx\` ON \`session_provider_state_link\` (\`session_id\`,\`context_revision\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_project_idx\` ON \`session\` (\`project_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_time_suspended_idx\` ON \`session\` (\`time_suspended\`) WHERE "session"."time_suspended" is not null;`,
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
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
