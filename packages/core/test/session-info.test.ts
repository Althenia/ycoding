import { describe, expect, test } from "bun:test"
import { fromRow } from "@ycoding-ai/core/session/info"
import type { SessionTable } from "@ycoding-ai/core/session/sql"

const row = (model: { id: string; providerID: string; variant?: string } | null): typeof SessionTable.$inferSelect => ({
  id: "ses_info_test",
  project_id: "prj_info_test",
  workspace_id: null,
  parent_id: null,
  fork_session_id: null,
  fork_message_id: null,
  fork_seq: null,
  directory: "/tmp/info-test",
  path: null,
  title: "Info",
  cost: 0,
  tokens_input: 0,
  tokens_output: 0,
  tokens_reasoning: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  revert: null,
  permission: null,
  autonomy: null,
  autonomy_revision: 0,
  orchestration_revision: 0,
  agent: null,
  model,
  daybreak: null,
  time_created: 1,
  time_updated: 1,
  time_archived: null,
  time_active: null,
  time_pinned: null,
  time_suspended: null,
} as typeof SessionTable.$inferSelect)

describe("Session info projection", () => {
  test("keeps a model without a variant free of any variant", () => {
    expect(fromRow(row({ id: "qwen-3.8-flash", providerID: "local" })).model).toStrictEqual({ id: "qwen-3.8-flash", providerID: "local" } as never)
  })

  test("carries an explicit variant through", () => {
    expect(fromRow(row({ id: "claude-opus-5-5", providerID: "anthropic", variant: "high" })).model).toEqual({ id: "claude-opus-5-5", providerID: "anthropic", variant: "high" } as never)
    expect(fromRow(row(null)).model).toBeUndefined()
  })
})
