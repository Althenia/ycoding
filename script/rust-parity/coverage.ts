import path from "node:path"

export type Tables = Record<string, unknown[]>
export type TableCoverage = {
  table: string
  rows: number
  status: "populated" | "unreachable-current-runtime"
  evidence: string
  reason?: string
}

const sources: Record<string, string> = {
  project: "packages/core/src/project.ts:124 (Project.recordOpened)",
  project_directory: "packages/core/src/project.ts:124 (Project.recordOpened → ProjectDirectories.create)",
  credential: "packages/core/src/credential.ts:183 (Credential.create; synthetic key only)",
  permission: "packages/core/src/permission/saved.ts:54 (PermissionSaved.add)",
  kv: "packages/core/src/kv.ts:32 (KV.set)",
  shell:
    "packages/core/src/shell/ledger.ts:60,124 (record/noticeOwed/reconcile; owned temporary process exits before export)",
  telemetry_consent: "packages/core/src/telemetry-consent.ts:17 (TelemetryConsent.make/set)",
  data_migration: "packages/core/src/attachment-store.ts:156 (AttachmentStore.migrate on startup)",
  event_sequence: "packages/core/src/event.ts:36 (EventRuntime.reserveSequence via real event publication)",
  event: "packages/core/src/event.ts:429 (EventRuntime.publish)",
  session: "packages/core/src/session/runtime.ts:901 (Session.create); packages/core/src/session/projector.ts:759",
  session_message:
    "packages/core/src/session/projector.ts:998,1069,1075 (input promotion and real provider terminal Steps)",
  session_pending:
    "packages/core/src/session/runtime.ts:1443 (Session.prompt resume:false steer + queue); packages/core/src/session/projector.ts:1030",
  session_todo: "packages/core/src/session/todo.ts:32 (SessionTodo.update)",
  session_todo_state: "packages/core/src/session/todo.ts:32 (SessionTodo.update)",
  session_file_change:
    "packages/core/src/session/projector.ts (FileChange.Recorded projector from real EventRuntime.publish)",
  session_task: "packages/core/src/session/projector.ts:1063 (Task.Updated launched/started/completed)",
  session_task_notification:
    "packages/core/src/session/projector.ts:1063 (terminal Task.Updated notification projector)",
  compaction_manifest_blob: "packages/core/src/session/context-state.ts:513 (validated ContextManifest activation)",
  session_compaction_job:
    "packages/core/src/session/compaction-job.ts (SessionCompactionJob.admit/claim); packages/core/src/session/context-state.ts (activation commits terminal job)",
  session_context_revision: "packages/core/src/session/context-state.ts:98,525 (initialize/activation)",
  session_context_state: "packages/core/src/session/context-state.ts:98,561 (initialize/activation)",
  session_context_exclusion: "packages/core/src/session/context-state.ts:544 (validated exact_duplicate selector)",
  instruction_entry:
    "packages/core/src/session/instruction-entry.ts:88 (InstructionEntry.put; UTF-16 JSON keys/values)",
  instruction_blob: "packages/core/src/session/instruction-state.ts:55 (InstructionState.commit from real runner)",
  instruction_state: "packages/core/src/session/instruction-state.ts:55 (InstructionState.commit from real runner)",
  session_provider_continuation_generation:
    "packages/core/src/session/runner/continuation.ts:108 (SessionContinuation.remember)",
  session_provider_continuation:
    "packages/core/src/session/runner/continuation.ts:108 (SessionContinuation.remember; synthetic response identity)",
  session_provider_state_blob:
    "packages/core/src/session/provider-state.ts:61 (SessionProviderState.capture; synthetic opaque JSON)",
  session_provider_state_link: "packages/core/src/session/provider-state.ts:61 (SessionProviderState.capture)",
  session_provider_request:
    "packages/core/src/session/runner/llm.ts (real runner/request tracker and fixture-native adapter)",
  session_usage: "packages/core/src/session/projector.ts:1075 (Step.Ended from fixture-native provider settlement)",
  web_latency: "packages/core/src/web-latency.ts:28 (WebLatency.append with real consent gate)",
  migration: "packages/core/src/database/migration.ts:23 (DatabaseMigration.apply; current migration ledger)",
  database_format: "packages/core/src/database/migration.ts:23 (DatabaseMigration.apply; current format bootstrap)",
}

const unreachable = {
  workspace: {
    evidence: "packages/core/src/control-plane/workspace.sql.ts:6; packages/core/src/session/projector.ts:803–805",
    reason:
      "Reserved persisted workspace schema has no current insert/create API. Its only runtime reference updates time_used on a preexisting record. No live external system supplies an insertion path.",
    symbol: "WorkspaceTable",
    allowed: ["control-plane/workspace.sql.ts", "session/projector.ts"],
  },
  project_artifact_legacy_cleanup: {
    evidence: "packages/core/src/project-artifact/sql.ts:724; packages/core/src/project-artifact/legacy-cleanup.ts:45",
    reason:
      "Historical cleanup table has no current runtime consumer or insertion path. Current ProjectArtifactLegacyCleanup operates on filesystem entries and returns a report without persisting this table.",
    symbol: "ProjectArtifactLegacyCleanupTable",
    allowed: ["project-artifact/sql.ts"],
  },
} as const

export async function coverageReport(repository: string, core: Tables, meeting: Tables) {
  const references = new Map<string, string[]>()
  for await (const file of new Bun.Glob("**/*.ts").scan(path.join(repository, "packages/core/src"))) {
    if (file.startsWith("database/migration/")) continue
    const content = await Bun.file(path.join(repository, "packages/core/src", file)).text()
    for (const [table, rule] of Object.entries(unreachable))
      if (content.includes(rule.symbol)) references.set(table, [...(references.get(table) ?? []), file])
  }
  const tableCoverage = Object.entries(core).map(([table, rows]): TableCoverage => {
    if (table in unreachable) {
      const rule = unreachable[table as keyof typeof unreachable]
      if (
        rows.length ||
        (references.get(table) ?? []).some((file) => !(rule.allowed as readonly string[]).includes(file))
      )
        throw new Error(`${table}: unreachable-runtime evidence drift; review current writer before classifying`)
      return { table, rows: 0, status: "unreachable-current-runtime", evidence: rule.evidence, reason: rule.reason }
    }
    const evidence =
      sources[table] ??
      (table.startsWith("project_artifact_") || table === "project_artifact"
        ? "packages/core/src/project-artifact/store.ts:1122,3037 (writeAutomatic/remove and real scope/version/operation/write/trash journals); packages/core/src/project-artifact/accounting.ts:531–534 (activation/observation/feedback)"
        : undefined)
    if (!rows.length || !evidence) throw new Error(`${table}: missing populated runtime coverage or source evidence`)
    return { table, rows: rows.length, status: "populated", evidence }
  })
  const meetingCoverage = Object.entries(meeting).map(([table, rows]): TableCoverage => {
    if (!rows.length) throw new Error(`${table}: missing populated Meeting runtime coverage`)
    return {
      table,
      rows: rows.length,
      status: "populated",
      evidence:
        "extensions/meeting/src/store.ts:212,267,350–398 (MeetingStore createMeeting/putSegment/putFinding/putCheckpoint/putProposal/putPlan/putApproval/putJob/putReference)",
    }
  })
  return {
    mainTables: 47,
    bootstrapTables: 2,
    meetingTables: 9,
    core: tableCoverage,
    meeting: meetingCoverage,
    unresolved: [] as string[],
    boundaries: {
      provider:
        "Replay current recorded OpenAI chat SSE through real AI adapter/runner. No provider socket or live key.",
      forms:
        "Form state is process-local and events are ephemeral; runtime-oracle.json records the real create/reply/state result, not a fabricated durable table.",
      compaction:
        "Validate real promoted duplicate synthetic messages and protected-state capture, claim a real job, and activate through the actual transactional context API. No raw SQL rows or generated fake database.",
      shell:
        "Identify only an owned temporary stdin-blocked process, record its real identity, terminate/join it, then reconcile the real ledger. No user process or arbitrary shell tool effects.",
      native: "No live browser, desktop helper, audio capture, transcription model, external MCP or knowledge write.",
    },
  }
}
