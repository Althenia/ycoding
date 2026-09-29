import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js"
import { Modal } from "../../ui/modal"
import { TeamAnswerForm } from "./subagent-bar"
import { LoadingPlaceholder } from "./loading"
import { canCancelSubagent, formatCacheHit, formatElapsed, isActiveSubagent, shellRows, taskRows, type TeamActionOutcome, type TeamPanelData, type TeamShellOutput } from "./team-model"
import "./team-view.css"

type Tab = "subagents" | "shell" | "side-chats"
const tabs: readonly Tab[] = ["subagents", "shell", "side-chats"]

export function TeamHeading(props: { readonly data: () => TeamPanelData }): JSX.Element {
  return <div class="team-view__heading"><h2>Team</h2><span>{props.data().activeTotal ?? props.data().tasks.filter((entry) => isActiveSubagent(entry.state)).length} active</span></div>
}

export function TeamView(props: {
  readonly data: () => TeamPanelData
  readonly currentSessionID: string
  readonly now: () => number
  readonly sheet: boolean
  readonly onClose: () => void
  readonly onOpen: (sessionID: string) => void
  readonly onCancel: (childID: string) => Promise<TeamActionOutcome>
  readonly onAnswer: (childID: string, questionID: string, text: string) => Promise<TeamActionOutcome>
  readonly onLoadOlder: () => Promise<void>
  readonly onViewShell: (ownerID: string, shellID: string, cursor?: number) => Promise<TeamShellOutput>
  readonly onKillShell: (shellID: string) => Promise<TeamActionOutcome>
  readonly onOpenSideChat: (sessionID: string) => void
  readonly onCreateSideChat: () => Promise<{ readonly status: "ok"; readonly sessionID: string } | Exclude<TeamActionOutcome, { readonly status: "ok" }>>
  readonly onLoadOlderSideChats: () => Promise<void>
}): JSX.Element {
  const [tab, setTab] = createSignal<Tab>("subagents")
  const [confirm, setConfirm] = createSignal<{ readonly kind: "cancel" | "kill"; readonly id: string; readonly label: string }>()
  const [working, setWorking] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [answerID, setAnswerID] = createSignal<string>()
  const [output, setOutput] = createSignal<{ readonly ownerID: string; readonly shellID: string; readonly page?: TeamShellOutput; readonly loading: boolean }>()
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
  let familyID = props.data().rootID
  createEffect(() => {
    const current = props.data().rootID
    if (current === familyID) return
    familyID = current
    setTab("subagents")
    setConfirm(undefined)
    setWorking(undefined)
    setAnswerID(undefined)
    setOutput(undefined)
    setError(undefined)
  })
  let section: HTMLElement | undefined
  const rows = createMemo(() => taskRows(props.data().tasks))
  const shells = createMemo(() => shellRows(props.data().shells))
  const task = (id: string) => props.data().tasks.find((entry) => entry.sessionID === id)!
  const shell = (id: string) => props.data().shells.find((entry) => entry.id === id)!
  const sideChat = (id: string) => props.data().sideChats.find((entry) => entry.id === id)!
  const ownerLabel = (id: string) => {
    if (id === props.data().rootID) return "Main session"
    const owner = props.data().tasks.find((task) => task.sessionID === id)
    if (owner) return `${owner.agent ?? "Subagent"} · ${owner.description}`
    const chat = props.data().sideChats.find((item) => item.id === id)
    return chat ? `Side chat · ${chat.title}` : "Unknown session"
  }
  const controlsAvailable = () => props.data().shellStatus === "ready" || props.data().sideChatStatus === "ready" || props.data().tasks.some((entry) => entry.tokens !== undefined)
  const canConfirm = () => {
    const item = confirm()
    if (!item || !controlsAvailable() || props.data().status !== "ready") return false
    return item.kind === "cancel" ? props.data().tasks.some((task) => task.sessionID === item.id && canCancelSubagent(task.state))
      : props.data().shells.some((shell) => shell.id === item.id && shell.status === "running")
  }
  const selectTab = (value: Tab) => {
    setTab(value)
    section?.querySelector<HTMLButtonElement>(`[role="tab"][data-tab="${value}"]`)?.focus()
  }
  const moveTab = (event: KeyboardEvent, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : undefined
    if (next === undefined) return
    event.preventDefault()
    selectTab(tabs[next]!)
  }
  const runAction = (item: { readonly kind: "cancel" | "kill"; readonly id: string }, action: () => Promise<TeamActionOutcome>, dismiss: () => void) => {
    if (working() !== undefined) return
    const rootID = props.data().rootID
    setWorking(item.id)
    setError(undefined)
    void action().then((result) => { if (rootID === props.data().rootID && result.status !== "ok") setError(result.message) },
      (cause: unknown) => { if (rootID === props.data().rootID) setError(cause instanceof Error ? cause.message : "The action could not be completed.") }).finally(() => {
      if (rootID !== props.data().rootID) return
      setWorking(undefined)
      if (confirm()?.id === item.id && confirm()?.kind === item.kind) dismiss()
    })
  }
  const readOutput = (ownerID: string, shellID: string, cursor?: number) => {
    if (output()?.loading) return
    const rootID = props.data().rootID
    const previous = output()?.shellID === shellID ? output()?.page : undefined
    setOutput({ ownerID, shellID, page: previous, loading: true })
    setError(undefined)
    void props.onViewShell(ownerID, shellID, cursor).then((page) => {
      if (rootID !== props.data().rootID || output()?.shellID !== shellID) return
      setOutput({ ownerID, shellID, page: previous && cursor !== undefined
        ? { ...page, text: previous.text + page.text } : page, loading: false })
    }, (cause: unknown) => {
      if (rootID !== props.data().rootID || output()?.shellID !== shellID) return
      setOutput({ ownerID, shellID, page: previous, loading: false })
      setError(cause instanceof Error ? cause.message : "Shell output is unavailable.")
    })
  }
  const runRead = (action: () => Promise<void>) => {
    const rootID = props.data().rootID
    setError(undefined)
    void action().catch((cause: unknown) => { if (rootID === props.data().rootID) setError(cause instanceof Error ? cause.message : "The page could not be loaded.") })
  }
  const panel = <section class="team-view" ref={section} aria-label="Team">
    <Show when={!props.sheet}><div class="team-view__header"><TeamHeading data={props.data} /><button type="button" aria-label="Close Team" onClick={props.onClose}>Close</button></div></Show>
    <div class="team-view__tabs" role="tablist" aria-label="Team sections">
      <For each={tabs}>{(value, index) => <button type="button" role="tab" data-tab={value} aria-selected={tab() === value} aria-controls={`team-panel-${value}`}
        tabIndex={tab() === value ? 0 : -1} onClick={() => selectTab(value)} onKeyDown={(event) => moveTab(event, index())}>
        {value === "subagents" ? `Subagents ${props.data().total ?? props.data().tasks.length}` : value === "shell" ? `Shell ${props.data().shells.length}` : `Side chats ${props.data().sideChats.length}`}
      </button>}</For>
    </div>
    <Show when={error()}>{(message) => <p class="team-view__error" role="alert">{message()}</p>}</Show>
    <div id="team-panel-subagents" role="tabpanel" aria-label="Subagents" aria-busy={props.data().status === "loading"} hidden={tab() !== "subagents"} inert={tab() !== "subagents"}>
        <Show when={props.data().status === "ready"} fallback={props.data().status === "loading" ? <LoadingPlaceholder kind="team" label="Loading subagents…" /> : <p role="status">{props.data().status === "unsupported" ? "Update YCoding on this machine to manage subagents." : "Subagents could not be loaded."}</p>}>
          <Show when={!controlsAvailable()}><p role="status">{props.data().shellStatus === "unsupported" && props.data().sideChatStatus === "unsupported" ? "Update YCoding on this machine to manage subagents." : "Checking Team controls…"}</p></Show>
          <ul class="team-view__list"><For each={rows()}>{(id) => id.startsWith("section:")
            ? <li class="team-view__section"><h3>{id === "section:active" ? "ACTIVE" : "INACTIVE"}</h3></li>
            : <li class="team-view__task" data-session-id={id}>
              <div class="team-view__row"><span class="team-view__state">{working() === id ? "cancelling…" : task(id).state}</span>
                <strong>{task(id).agent ?? "Agent unreported"} · {task(id).description}</strong></div>
              <p class="team-view__meta">{[task(id).modelLabel, id === props.currentSessionID ? "attached" : undefined,
                task(id).tokens === undefined ? undefined : `${task(id).tokens?.toLocaleString("en-US")} tokens`,
                task(id).cost === undefined ? undefined : money.format(task(id).cost!),
                task(id).contextTotal === undefined ? undefined : `Context ${task(id).contextTotal?.toLocaleString("en-US")} / ${task(id).contextLimit === undefined ? "unreported" : task(id).contextLimit?.toLocaleString("en-US")}`,
                formatCacheHit(task(id).cacheHitRatio), formatElapsed(task(id).startedAt, task(id).state === "running" || task(id).state === "waiting" || task(id).state === "starting" || task(id).state === "cancelling" ? props.now() : task(id).updatedAt)].filter(Boolean).join(" · ")}</p>
              <div class="team-view__actions"><button type="button" data-action="open" onClick={() => props.onOpen(id)}>Open</button>
                <Show when={controlsAvailable() && canCancelSubagent(task(id).state)}><button type="button" data-action="cancel" disabled={working() !== undefined} onClick={() => setConfirm({ kind: "cancel", id, label: task(id).description })}>Cancel</button></Show>
                <Show when={controlsAvailable() && task(id).question && task(id).state === "waiting"}><button type="button" data-action="answer" onClick={() => setAnswerID(answerID() === id ? undefined : id)}>Answer</button></Show></div>
              <Show when={controlsAvailable() && answerID() === id ? task(id).question?.id : undefined} keyed><TeamAnswerForm question={task(id).question!} onAnswer={(questionID, text) => props.onAnswer(id, questionID, text)} /></Show>
            </li>}</For></ul>
          <Show when={props.data().next}><button type="button" class="team-view__more" disabled={props.data().pageLoading} onClick={() => runRead(props.onLoadOlder)}>
            {props.data().pageLoading ? "Loading older…" : `+${Math.max(0, (props.data().total ?? props.data().tasks.length) - props.data().tasks.length)} more · Load older`}
          </button></Show>
          <Show when={props.data().pageLoading}><LoadingPlaceholder kind="team" label="Loading older subagents…" /></Show>
        </Show>
    </div>
    <div id="team-panel-shell" role="tabpanel" aria-label="Shell" hidden={tab() !== "shell"} inert={tab() !== "shell"}>
        <Show when={props.data().shellStatus === "ready"} fallback={props.data().shellStatus === "loading" ? <LoadingPlaceholder kind="team" label="Loading shells…" /> : <p role="status">{props.data().shellStatus === "unsupported" ? "Update YCoding on this machine to manage shells." : "Shells could not be loaded."}</p>}>
          <ul class="team-view__list"><For each={shells()}>{(id) => id.startsWith("owner:")
            ? <li class="team-view__owner"><h3>{ownerLabel(id.slice(6))}</h3></li>
            : <li class="team-view__shell" data-shell-id={id}>
            <div class="team-view__row"><span class="team-view__state">{working() === id ? "killing…" : shell(id).status}</span><strong>{shell(id).command}</strong></div>
            <p class="team-view__meta">{formatElapsed(shell(id).startedAt, shell(id).completedAt ?? props.now())}</p>
            <div class="team-view__actions"><button type="button" data-action="output" onClick={() => readOutput(shell(id).ownerID, id)}>View output</button>
              <Show when={shell(id).status === "running"}><button type="button" data-action="kill" disabled={working() !== undefined} onClick={() => setConfirm({ kind: "kill", id, label: shell(id).command })}>Kill</button></Show></div>
          </li>}</For></ul>
          <Show when={props.data().shellTruncated}><p role="status">Showing the first 50 family shells. More are running on this machine.</p></Show>
          <Show when={output()}>{(current) => <section class="team-view__output" aria-label="Shell output"><h3>Output</h3><Show when={current().page?.text} fallback={current().loading ? <LoadingPlaceholder kind="output" label="Loading output…" /> : <pre tabindex="0">No output reported.</pre>}>{(text) => <pre tabindex="0">{text()}</pre>}</Show>
            <Show when={current().page && current().loading}><LoadingPlaceholder kind="history" label="Loading more output…" /></Show>
            <Show when={current().page && current().page!.cursor < current().page!.size}><button type="button" disabled={current().loading} onClick={() => readOutput(current().ownerID, current().shellID, current().page?.cursor)}>Load more output</button></Show>
            <Show when={current().page?.truncated}><p>Output was truncated on the device.</p></Show></section>}</Show>
        </Show>
    </div>
    <div id="team-panel-side-chats" role="tabpanel" aria-label="Side chats" hidden={tab() !== "side-chats"} inert={tab() !== "side-chats"}>
        <Show when={props.data().sideChatStatus === "ready"} fallback={props.data().sideChatStatus === "loading" ? <LoadingPlaceholder kind="team" label="Loading side chats…" /> : <p role="status">{props.data().sideChatStatus === "unsupported" ? "Update YCoding on this machine to use side chats." : "Side chats could not be loaded."}</p>}>
          <button type="button" data-action="new-side-chat" disabled={working() !== undefined} onClick={() => {
            if (working() !== undefined) return
            const rootID = props.data().rootID
            setWorking("new-side-chat")
            setError(undefined)
            void props.onCreateSideChat().then((result) => { if (rootID !== props.data().rootID) return; if (result.status === "ok") props.onOpenSideChat(result.sessionID); else setError(result.message) },
              (cause: unknown) => { if (rootID === props.data().rootID) setError(cause instanceof Error ? cause.message : "Side chat could not be created.") }).finally(() => { if (rootID === props.data().rootID) setWorking(undefined) })
          }}>{working() === "new-side-chat" ? "Creating…" : "New side chat"}</button>
          <ul class="team-view__list"><For each={props.data().sideChats.map((item) => item.id)}>{(id) => <li class="team-view__side-chat" data-session-id={id}>
            <div class="team-view__row"><strong>{sideChat(id).title}</strong><span>{new Date(sideChat(id).updatedAt).toLocaleString()}</span></div>
            <button type="button" data-action="open" onClick={() => props.onOpenSideChat(id)}>Open</button>
          </li>}</For></ul>
          <Show when={props.data().sideChatNext}><button type="button" data-action="older-side-chats" disabled={props.data().sideChatLoading} onClick={() => runRead(props.onLoadOlderSideChats)}>{props.data().sideChatLoading ? "Loading older…" : "Load older side chats"}</button></Show>
          <Show when={props.data().sideChatLoading}><LoadingPlaceholder kind="team" label="Loading older side chats…" /></Show>
        </Show>
    </div>
  </section>
  return <>
    {panel}
    <Show when={confirm()} keyed>{(item) => {
      let close: (() => void) | undefined
      return <Modal class="overlay--dialog" label={item.kind === "cancel" ? "Cancel subagent" : "Kill shell"} onClose={() => { if (confirm()?.id === item.id && confirm()?.kind === item.kind) setConfirm(undefined) }}
        requestClose={(handoff) => { close = handoff }}>
      <div class="team-view__confirmation"><p>{item.kind === "cancel" ? `Cancel ${item.label}?` : `Kill ${item.label}?`}</p>
        <div><button type="button" data-action="keep" onClick={() => close?.()}>Keep running</button>
          <button type="button" data-action="confirm" disabled={working() !== undefined || !canConfirm()} onClick={() => { if (canConfirm()) runAction(item, () => item.kind === "cancel" ? props.onCancel(item.id) : props.onKillShell(item.id), () => close?.()) }}>
            {item.kind === "cancel" ? "Cancel subagent" : "Kill shell"}
          </button></div>
      </div>
    </Modal>
    }}</Show>
  </>
}
