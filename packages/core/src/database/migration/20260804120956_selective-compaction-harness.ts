import { SessionPending } from "@ycoding-ai/schema/session-pending"
import { sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { DatabaseMigration } from "../migration"
import { DatabaseFormat } from "../format"
import { Hash } from "../../util/hash"

export default {
  id: "20260804120956_selective-compaction-harness",
  format: { from: DatabaseFormat.PreviousID, to: DatabaseFormat.CurrentID },
  up(tx) {
    return Effect.gen(function* () {
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
      yield* tx.run(`ALTER TABLE \`credential\` ADD \`generation\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`PRAGMA foreign_keys=OFF;`)
      yield* tx.run(`
        CREATE TABLE \`__new_credential\` (
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
      yield* tx.run(
        `INSERT INTO \`__new_credential\`(\`id\`, \`integration_id\`, \`label\`, \`value\`, \`connector_id\`, \`method_id\`, \`active\`, \`time_created\`, \`time_updated\`) SELECT \`id\`, \`integration_id\`, \`label\`, \`value\`, \`connector_id\`, \`method_id\`, \`active\`, \`time_created\`, \`time_updated\` FROM \`credential\`;`,
      )
      yield* tx.run(`DROP TABLE \`credential\`;`)
      yield* tx.run(`ALTER TABLE \`__new_credential\` RENAME TO \`credential\`;`)
      yield* tx.run(`PRAGMA foreign_keys=ON;`)
      yield* tx.run(`DROP INDEX IF EXISTS \`session_pending_session_compaction_idx\`;`)
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
        `CREATE INDEX \`session_provider_state_link_blob_idx\` ON \`session_provider_state_link\` (\`blob_digest\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_provider_state_link_revision_idx\` ON \`session_provider_state_link\` (\`session_id\`,\`context_revision\`);`,
      )
      yield* migrateLegacyContext(tx)
      yield* migrateLegacyPending(tx)
      yield* tx.run(
        sql`UPDATE database_format SET id = ${DatabaseFormat.CurrentID} WHERE id = ${DatabaseFormat.PreviousID}`,
      )
    })
  },
} satisfies DatabaseMigration.Migration

type Transaction = Parameters<DatabaseMigration.Migration["up"]>[0]
type LegacyEventRow = {
  readonly id: string
  readonly seq: number
  readonly created: number
  readonly type: "session.compaction.replaced.1" | "session.compaction.ended.1"
  readonly data: unknown
}
type LegacyMessageRow = {
  readonly id: string
  readonly seq: number
  readonly type: string
  readonly data: unknown
}
type LegacyBaseline = {
  readonly kind: "replaced" | "ended"
  readonly messageID: string
  readonly messageSeq: number
  readonly eventID: string
  readonly eventSeq: number
  readonly eventCreated: number
}

const decodeJSON = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeLegacyPending = Schema.decodeUnknownOption(SessionPending.LegacyInfo)

function migrateLegacyContext(tx: Transaction) {
  return Effect.gen(function* () {
    const sessions = yield* tx.all<{ id: string; time_created: number }>(
      sql`SELECT id, time_created FROM session ORDER BY id`,
    )
    for (const session of sessions) {
      const events = yield* tx.all<LegacyEventRow>(sql`
        SELECT id, seq, created, type, data
        FROM event
        WHERE aggregate_id = ${session.id}
          AND type IN ('session.compaction.replaced.1', 'session.compaction.ended.1')
        ORDER BY seq, id
      `)
      const messages = yield* tx.all<LegacyMessageRow>(sql`
        SELECT id, seq, type, data
        FROM session_message
        WHERE session_id = ${session.id}
        ORDER BY seq, id
      `)
      const baseline = legacyBaseline(session.id, events, messages)
      const timeCreated =
        baseline.status === "active" ? (baseline.value?.eventCreated ?? session.time_created) : session.time_created
      yield* tx.run(sql`
        INSERT INTO session_context_revision (
          session_id, revision, parent_revision, manifest_digest,
          covered_through_message_id, covered_through_seq,
          activation_event_id, activation_sequence, time_created
        ) VALUES (
          ${session.id}, 0, NULL, NULL,
          ${baseline.value?.messageID ?? null}, ${baseline.value?.messageSeq ?? null},
          ${baseline.value?.eventID ?? null}, ${baseline.value?.eventSeq ?? null}, ${timeCreated}
        )
      `)
      yield* tx.run(sql`
        INSERT INTO session_context_state (
          session_id, status, revision, manifest_digest,
          covered_through_message_id, covered_through_seq,
          activated_event_id, time_activated, error_code
        ) VALUES (
          ${session.id}, ${baseline.status}, 0, NULL,
          ${baseline.value?.messageID ?? null}, ${baseline.value?.messageSeq ?? null},
          ${baseline.value?.eventID ?? null}, ${baseline.value?.eventCreated ?? null},
          ${baseline.status === "quarantined" ? "legacy_lineage_invalid" : null}
        )
      `)
    }
  })
}

function migrateLegacyPending(tx: Transaction) {
  return Effect.gen(function* () {
    const pending = yield* tx.all<{
      id: string
      session_id: string
      type: string
      data: unknown
      delivery: string | null
      admitted_seq: number
      time_created: number
    }>(sql`
      SELECT id, session_id, type, data, delivery, admitted_seq, time_created
      FROM session_pending
      WHERE type = 'compaction'
      ORDER BY session_id, admitted_seq, id
    `)
    for (const row of pending) {
      const storedData = asRecord(decodeStoredJSON(row.data))
      const decoded = Option.getOrUndefined(
        decodeLegacyPending({
          id: row.id,
          sessionID: row.session_id,
          type: row.type,
          admittedSeq: row.admitted_seq,
          timeCreated: row.time_created,
        }),
      )
      if (
        decoded?.type !== "compaction" ||
        row.delivery !== null ||
        !storedData ||
        Object.keys(storedData).length > 0
      ) {
        return yield* Effect.fail(new Error(`invalid legacy compaction barrier ${row.id}`))
      }
      const boundary = yield* tx.get<{ id: string; seq: number }>(sql`
        SELECT id, seq
        FROM session_message
        WHERE session_id = ${row.session_id}
        ORDER BY seq DESC, id DESC
        LIMIT 1
      `)
      if (!boundary || !nonnegativeInteger(boundary.seq)) {
        return yield* Effect.fail(new Error(`legacy compaction barrier has no surviving message boundary: ${row.id}`))
      }
      yield* tx.run(sql`
        INSERT INTO session_compaction_job (
          id, session_id, legacy_input_id, trigger, admission_mode,
          requested_through_message_id, requested_through_seq, base_context_revision,
          target_max_input_tokens, config_digest, status, lease_owner, lease_expires_at,
          attempts, manifest_digest, error_code, error_message,
          time_created, time_started, time_ended
        ) VALUES (
          ${`cmp_${Hash.sha256(row.id)}`}, ${row.session_id}, ${row.id}, 'manual', 'background',
          ${boundary.id}, ${boundary.seq}, 0,
          NULL, NULL, 'pending', NULL, NULL,
          0, NULL, NULL, NULL,
          ${row.time_created}, NULL, NULL
        )
      `)
      yield* tx.run(sql`DELETE FROM session_pending WHERE id = ${row.id} AND type = 'compaction'`)
    }
  })
}

function legacyBaseline(sessionID: string, events: LegacyEventRow[], messages: LegacyMessageRow[]) {
  const values = events.map((event) =>
    event.type === "session.compaction.replaced.1"
      ? replacedBaseline(sessionID, event, messages)
      : endedBaseline(sessionID, event, messages),
  )
  if (values.some((value) => value === undefined)) {
    return { status: "quarantined" as const, value: undefined }
  }
  const valid = values.filter((value): value is LegacyBaseline => value !== undefined)
  return {
    status: "active" as const,
    value: valid.filter((value) => value.kind === "replaced").at(-1) ?? valid.at(-1),
  }
}

function replacedBaseline(sessionID: string, event: LegacyEventRow, messages: LegacyMessageRow[]) {
  const data = asRecord(decodeStoredJSON(event.data))
  if (
    !data ||
    data.sessionID !== sessionID ||
    typeof data.summaryMessageID !== "string" ||
    !nonnegativeInteger(data.through) ||
    !nonnegativeInteger(data.summaryRevision) ||
    !nonnegativeInteger(data.deletedMessageCount) ||
    !nonnegativeInteger(data.remainingMessageCount)
  )
    return
  const message = messages.find(
    (candidate) =>
      candidate.id === data.summaryMessageID &&
      candidate.seq === data.through &&
      candidate.type === "compaction" &&
      asRecord(decodeStoredJSON(candidate.data))?.status === "completed",
  )
  if (!message) return
  return {
    kind: "replaced",
    messageID: message.id,
    messageSeq: message.seq,
    eventID: event.id,
    eventSeq: event.seq,
    eventCreated: event.created,
  } satisfies LegacyBaseline
}

function endedBaseline(sessionID: string, event: LegacyEventRow, messages: LegacyMessageRow[]) {
  const data = asRecord(decodeStoredJSON(event.data))
  if (
    !data ||
    data.sessionID !== sessionID ||
    (data.reason !== "auto" && data.reason !== "manual") ||
    typeof data.text !== "string" ||
    typeof data.recent !== "string"
  )
    return
  const message = messages.findLast((candidate) => {
    const content = asRecord(decodeStoredJSON(candidate.data))
    return (
      candidate.type === "compaction" &&
      candidate.seq <= event.seq &&
      content?.status === "completed" &&
      content.reason === data.reason &&
      content.summary === data.text &&
      content.recent === data.recent
    )
  })
  if (!message) return
  return {
    kind: "ended",
    messageID: message.id,
    messageSeq: message.seq,
    eventID: event.id,
    eventSeq: event.seq,
    eventCreated: event.created,
  } satisfies LegacyBaseline
}

function decodeStoredJSON(value: unknown) {
  return typeof value === "string" ? Option.getOrUndefined(decodeJSON(value)) : value
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}
