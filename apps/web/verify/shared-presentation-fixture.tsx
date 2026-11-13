import { render } from "solid-js/web"
import { createSignal } from "solid-js"
import { FileChangeCard } from "../src/remote/ui/file-change-card"
import { SharedActivitySurface, SharedChangesSurface, SharedCompanionSurface, SharedContextBreakdownPanel, SharedEditedFilesCard, SharedReasoningDisclosure, SharedToolDisclosure } from "../src/remote/ui/shared-workspace"

const files = [{ path: "a.ts", patch: "@@ -1 +1 @@\n-old\n+new", additions: 1, deletions: 1 }, { path: "b.ts", patch: "@@ -0,0 +1 @@\n+second", additions: 1, deletions: 0 }]
const captured = [{ path: "a.ts", placementMessageID: "message", additions: 1, deletions: 1, status: "modified" as const, files: [{ path: "a.ts", diff: files[0]!.patch, additions: 1, deletions: 1, status: "modified" as const }] }]
const record = (value: string) => { document.body.dataset.result = value }
const [selectedTurn, setSelectedTurn] = createSignal<string>()
const [staged, setStaged] = createSignal(false)
window.addEventListener("ycoding:open-companion", () => record("fallback"))
render(() => <>
  <SharedToolDisclosure tools={[{ id: "t", name: "Shell", status: "completed", outputText: "tool result" }]} />
  <SharedReasoningDisclosure text="reasoning body" />
  <SharedEditedFilesCard files={files} onViewChanges={(path) => record(`edited:${path}`)} onUndo={() => record("undo")} footerNote="Review first" />
  <SharedCompanionSurface active="activity" onSelect={(tab) => record(`tab:${tab}`)} onCloseTab={(tab) => record(`close:${tab}`)} onAddTab={() => record("add-tab")} activityContent="Activity content" changesContent="Changes content" />
  <SharedActivitySurface shells={[{ id: "s", command: "echo test", status: "running", pid: 42 }]} subagents={[{ sessionID: "a", agent: "worker", description: "Review", state: "running", model: "model", onOpen: () => record("agent") }]} capabilityNote="Limited access" onSelectShell={(id) => record(`shell:${id}`)} shellOutput={{ shellID: "s", output: "shell output", nextCursor: 0, onLoadMore: () => record("output-page") }} subagentNext="next" onLoadMoreSubagents={() => record("subagent-page")} />
  <SharedChangesSurface files={files} onSelectFile={(path) => record(`select:${path}`)} onRefresh={() => record("refresh")} turns={[{ id: "one", label: "First turn", files: [files[0]!] }]} selectedTurnID={selectedTurn()} onSelectTurn={setSelectedTurn} turnsNotice="Limited history" onOpenFullChanges={() => record("full-changes")} revert={{ staged: staged(), onStage: () => setStaged(true), onCommit: () => record("commit"), onClear: () => setStaged(false) }} />
  <SharedContextBreakdownPanel contextMessages={[{ id: "m", role: "user", summary: "question" }]} stepDiagnostics={{ uncachedInput: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 }} onOpenUsage={() => record("usage")} />
  <div id="callback"><FileChangeCard files={() => captured} onOpenChanges={(path) => record(`callback:${path}`)} /></div>
  <div id="fallback"><FileChangeCard files={() => captured} /></div>
</>, document.getElementById("app")!)
