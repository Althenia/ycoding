import { Show, createSignal } from "solid-js"
import { render } from "solid-js/web"
import { isManagedSubagent, siblingTargets, type TeamActionOutcome, type TeamPanelData, type TeamSubagent } from "../src/remote/ui/team-model"
import { SubagentBar } from "../src/remote/ui/subagent-bar"
import { TeamHeading, TeamView } from "../src/remote/ui/team-view"
import { Modal } from "../src/ui/modal"
import "../src/styles/tokens.css"
import "../src/styles/base.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light"
const initialTasks: readonly TeamSubagent[] = [
  { sessionID: "ses_child", parentID: "ses_root", description: "Review test coverage", agent: "omoikane", modelLabel: "openai/gpt-6-sol#high", state: "running", revision: 1, startedAt: 1_000, updatedAt: 2_000, cacheHitRatio: 1 },
  { sessionID: "ses_waiting", parentID: "ses_root", description: "Investigate deployment", agent: "researcher", modelLabel: "anthropic/opus#high", state: "waiting", revision: 1, startedAt: 1_000, updatedAt: 3_000, question: { id: "qst_1", text: "Which environment?" } },
  { sessionID: "ses_done", parentID: "ses_root", description: "Run focused tests", agent: "tester", state: "completed", revision: 1, startedAt: 1_000, updatedAt: 4_000 },
]
const crowdedTasks: readonly TeamSubagent[] = params.has("crowded") ? [
  ...initialTasks,
  ...[1, 2, 3].map((index) => ({ sessionID: `ses_extra_${index}`, parentID: "ses_root", description: `Review additional task ${index}`, agent: "reviewer", state: "running" as const, revision: 1, startedAt: 1_000, updatedAt: 2_000 })),
] : initialTasks
const [tasks, setTasks] = createSignal(crowdedTasks)
const [rootID, setRootID] = createSignal("ses_root")
const [shells, setShells] = createSignal<TeamPanelData["shells"]>([{ id: "sh_1", ownerID: "ses_root", command: "bun test", status: "running", startedAt: 1_000 },
  ...(params.has("sideShell") ? [{ id: "sh_btw", ownerID: "ses_btw", command: "bun lint", status: "running" as const, startedAt: 2_000 }] : [])])
const [sideChats, setSideChats] = createSignal<TeamPanelData["sideChats"]>([{ id: "ses_btw", title: "Quick question", updatedAt: 5_000 }])
const [selectedID, setSelectedID] = createSignal(params.get("mode") === "btw" ? "ses_btw" : params.get("mode") === "team" ? "ses_root" : "ses_child")
const [open, setOpen] = createSignal(params.get("mode") === "team")
const [next, setNext] = createSignal<string | undefined>("older")
const [sideNext, setSideNext] = createSignal<string | undefined>("older")
const events: string[] = []
let releaseCancel: ((outcome: TeamActionOutcome) => void) | undefined
const panel = (): TeamPanelData => ({ rootID: rootID(), status: params.has("unsupported") ? "unsupported" : "ready", tasks: tasks(), total: params.has("crowded") ? 53 : 4, activeTotal: tasks().filter((task) => task.state === "running" || task.state === "waiting" || task.state === "starting" || task.state === "cancelling").length, next: next(), pageLoading: false,
  shells: shells(), shellStatus: params.has("unsupported") ? "unsupported" : "ready", sideChats: sideChats(), sideChatStatus: params.has("unsupported") ? "unsupported" : "ready", sideChatNext: sideNext(), sideChatLoading: false })
const success: TeamActionOutcome = { status: "ok" }
const select = (id: string) => { setSelectedID(id); events.push(`open:${id}`) }
const answer = async (id: string, questionID: string, text: string): Promise<TeamActionOutcome> => {
  events.push(`answer:${id}:${questionID}:${text}`)
  setTasks((items) => items.map((item) => item.sessionID === id ? { ...item, state: "running", question: undefined } : item))
  return success
}
Object.assign(window, {
  teamEvents: () => events.slice(),
  teamSelected: () => selectedID(),
  teamRefresh: () => setTasks((items) => items.map((item) => ({ ...item }))),
  teamComplete: (id: string) => setTasks((items) => items.map((item) => item.sessionID === id ? { ...item, state: "cancelled", updatedAt: 6_000 } : item)),
  teamShellExit: (id: string) => setShells((items) => items.map((item) => item.id === id ? { ...item, status: "exited", completedAt: 37_021_000 } : item)),
  teamSwitchRoot: () => { setRootID("ses_other"); setTasks([{ sessionID: "ses_other_child", parentID: "ses_other", description: "Different family", agent: "researcher", state: "running", revision: 1, updatedAt: 7_000 }]); setShells([]); setSideChats([]) },
  teamReleaseCancel: () => releaseCancel?.({ status: "unknown", message: "Old family outcome unknown" }),
})
const root = document.getElementById("app")
if (!root) throw new Error("Missing Team fixture root")
let teamTrigger: HTMLButtonElement | undefined
const teamContent = (sheet: boolean) => <TeamView data={panel} currentSessionID={selectedID()} now={() => 37_021_000} sheet={sheet} onClose={() => setOpen(false)}
  onOpen={select} onCancel={async (id) => {
    events.push(`cancel:${id}`)
    if (params.get("cancelOutcome") === "deferred") return new Promise<TeamActionOutcome>((resolve) => { releaseCancel = resolve })
    if (params.get("cancelOutcome") === "unknown") return { status: "unknown", message: "Outcome unknown; check the task before retrying." }
    setTasks((items) => items.map((item) => item.sessionID === id ? { ...item, state: "cancelling" } : item))
    return success
  }} onAnswer={answer} onLoadOlder={async () => { events.push("older:subagents"); setTasks((items) => [...items, { sessionID: "ses_old", parentID: "ses_root", description: "Older task", agent: "general", state: "failed", revision: 1, updatedAt: 1_000 }]); setNext(undefined) }}
  onViewShell={async (ownerID, id) => { events.push(`output:${ownerID}:${id}`); return { text: "Tests passed\n", cursor: 13, size: 13, truncated: false } }} onKillShell={async (id) => { events.push(`kill:${id}`); setShells((items) => items.map((item) => item.id === id ? { ...item, status: "killed", completedAt: 37_021_000 } : item)); return success }}
  onOpenSideChat={select} onCreateSideChat={async () => { events.push("new:sidechat"); setSideChats((items) => [...items, { id: "ses_btw_new", title: "New side chat", updatedAt: 6_000 }]); return { status: "ok", sessionID: "ses_btw_new" } }}
  onLoadOlderSideChats={async () => { events.push("older:sidechats"); setSideChats((items) => [...items, { id: "ses_btw_old", title: "Older side chat", updatedAt: 1_000 }]); setSideNext(undefined) }} />
render(() => <main class="team-fixture">
  <button ref={teamTrigger} type="button" id="team-open" onClick={() => setOpen(true)}>Team</button>
  <Show when={isManagedSubagent({ parentID: selectedID() === "ses_root" ? undefined : "ses_root", agent: selectedID() === "ses_btw" ? "btw" : "omoikane" })}
    fallback={<textarea aria-label={selectedID() === "ses_btw" ? "Message BTW" : "Message main session"} />}>
    <SubagentBar parentTitle="Main session" agent="omoikane" description="Review test coverage" status="running"
      modelLabel="openai/gpt-6-sol#high" economics={{ tokens: 2_300, cacheHitRatio: 1, cost: 0.08 }}
      previousID={siblingTargets(tasks(), selectedID()).previous} nextID={siblingTargets(tasks(), selectedID()).next} onMain={() => select("ses_root")}
      onPrevious={() => { const id = siblingTargets(tasks(), selectedID()).previous; if (id) select(id) }}
      onNext={() => { const id = siblingTargets(tasks(), selectedID()).next; if (id) select(id) }}
      question={tasks().find((item) => item.sessionID === selectedID())?.question}
      onAnswer={(questionID, text) => answer(selectedID(), questionID, text)} />
  </Show>
  <Show when={open()}>{matchMedia("(max-width: 767px)").matches
    ? <Modal class="overlay--sheet team-view__sheet" label="Team" header={<TeamHeading data={panel} />} returnFocus={teamTrigger!} onClose={() => setOpen(false)}>{teamContent(true)}</Modal>
    : teamContent(false)}</Show>
</main>, root)
