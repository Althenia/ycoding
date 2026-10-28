import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261028041559_prepared-usage",
  up(tx) {
    return Effect.gen(function* () {
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
    })
  },
} satisfies DatabaseMigration.Migration
