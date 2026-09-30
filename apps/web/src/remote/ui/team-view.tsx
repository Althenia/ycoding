import { For, Show, createEffect, createMemo, createSignal, type JSX } from "solid-js"
import { Icon, type IconName } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import { TeamAnswerForm } from "./subagent-bar"
import { LoadingPlaceholder } from "./loading"
import { canCancelSubagent, formatElapsed, isActiveSubagent, teamActivityLabel, shellRows, taskRows, usageSlots, type TeamActionOutcome, type TeamPanelData, type TeamShellOutput, type TeamSubagent } from "./team-model"
import "./team-view.css"

type Tab = "subagents" | "shell" | "side-chats"
const tabs: readonly Tab[] = ["subagents", "shell", "side-chats"]
const tabMeta: Readonly<Record<Tab, { readonly label: string; readonly icon: IconName }>> = {
  subagents: { label: "Subagents", icon: "team" },
  shell: { label: "Shell", icon: "terminal" },
  "side-chats": { label: "Side chats", icon: "chat" },
}

function StateMark(props: { readonly state: TeamSubagent["state"] }): JSX.Element {
  const icon = (): IconName | undefined => props.state === "completed" ? "check" : props.state === "failed" || props.state === "lost" ? "alert" : props.state === "cancelled" ? "minus" : undefined
  return <span class={`team-view__mark team-view__mark--${props.state}`} aria-hidden="true">
    <Show when={icon()} fallback={<span class="status-dot" />}>{(name) => <Icon name={name()} size={14} />}</Show>
  </span>
}

const shellMark: Readonly<Record<TeamPanelData["shells"][number]["status"], TeamSubagent["state"]>> = { running: "running", exited: "completed", timeout: "failed", "memory-limit": "failed", killed: "cancelled" }
const usageKeys = ["tokens", "cost", "context", "cache"] as const

function TaskUsage(props: { readonly task: () => TeamSubagent; readonly loading: () => boolean }): JSX.Element {
  const slots = createMemo(() => usageSlots(props.task(), { loading: props.loading() }))
  return <dl class="team-view__usage" aria-busy={props.loading()}>
    <For each={usageKeys}>{(key) => {
      const slot = () => slots().find((entry) => entry.key === key)!
      return <div class="team-view__usage-cell" data-slot={key} data-state={slot().state}>
        <dt>{slot().label}</dt>
        <dd><Show when={slot().state === "loading"} fallback={slot().value}><span class="team-view__skeleton" aria-hidden="true" /><span class="visually-hidden">Loading</span></Show>
          <Show when={slot().meter !== undefined}><span class="team-view__meter" role="img" aria-label={`${Math.round((slot().meter ?? 0) * 100)}% of context used`}><span style={{ "inline-size": `${Math.round((slot().meter ?? 0) * 100)}%` }} /></span></Show></dd>
      </div>
    }}</For>
  </dl>
}

export function TeamHeading(props: { readonly data: () => TeamPanelData }): JSX.Element {
  return <div class="team-view__heading"><h2>Team</h2><span>{teamActivityLabel(props.data())}</span></div>
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
  const [confirm, setConfirm] = createSignal<{ readonly kind: "cancel" | "kill"; readonly id: string; readonly label: string; readonly trigger: HTMLButtonElement }>()
  const [working, setWorking] = createSignal<string>()
  const [error, setError] = createSignal<string>()
  const [answerID, setAnswerID] = createSignal<string>()
  const [output, setOutput] = createSignal<{ readonly ownerID: string; readonly shellID: string; readonly page?: TeamShellOutput; readonly loading: boolean }>()
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
  const firstLoad = () => props.data().status === "loading" && props.data().tasks.length === 0
  const hasRows = () => props.data().tasks.length > 0 && props.data().status !== "unsupported"
  const controlsUnsupported = () => !controlsAvailable() && props.data().shellStatus === "unsupported" && props.data().sideChatStatus === "unsupported"
  const controlsChecking = () => !controlsAvailable() && (props.data().shellStatus === "loading" || props.data().sideChatStatus === "loading")
  const canControl = () => controlsAvailable() && props.data().status === "ready"
  const sectionCount = (id: string) => props.data().tasks.filter((entry) => isActiveSubagent(entry.state) === (id === "section:active")).length
  const tabCount = (value: Tab) => value === "subagents" ? props.data().total ?? props.data().tasks.length : value === "shell" ? props.data().shells.length : props.data().sideChats.length
  const panel = <section class="team-view" ref={section} aria-label="Team">
    <Show when={!props.sheet}><div class="team-view__header"><TeamHeading data={props.data} /><button type="button" class="team-view__close" aria-label="Close Team" onClick={props.onClose}><Icon name="close" size={18} /></button></div></Show>
    <div class="team-view__tabs" role="tablist" aria-label="Team sections">
      <For each={tabs}>{(value, index) => <button type="button" role="tab" data-tab={value} aria-selected={tab() === value} aria-controls={`team-panel-${value}`}
        tabIndex={tab() === value ? 0 : -1} onClick={() => selectTab(value)} onKeyDown={(event) => moveTab(event, index())}>
        <Icon name={tabMeta[value].icon} size={16} /><span class="team-view__tab-label">{tabMeta[value].label}</span>{" "}<span class="team-view__count">{tabCount(value)}</span>
      </button>}</For>
    </div>
    <Show when={error()}>{(message) => <p class="team-view__error" role="alert">{message()}</p>}</Show>
    <div id="team-panel-subagents" role="tabpanel" aria-label="Subagents" aria-busy={props.data().status === "loading" || props.data().refreshing === true || controlsChecking()} hidden={tab() !== "subagents"} inert={tab() !== "subagents"}>
        <Show when={!firstLoad()} fallback={<LoadingPlaceholder kind="team" label="Loading subagents…" />}>
          <Show when={props.data().status === "unsupported" || props.data().status === "error"}><p class="team-view__note" role="status">{props.data().status === "unsupported" ? "Update YCoding on this machine to view subagents." : "Subagents could not be loaded."}</p></Show>
          <Show when={props.data().status === "ready" && controlsUnsupported()}><p class="team-view__note" role="status">Update YCoding on this machine to manage subagents.</p></Show>
          <Show when={props.data().status === "ready" && !controlsAvailable() && !controlsChecking() && !controlsUnsupported()}><p class="team-view__note" role="status">Team controls could not be checked.</p></Show>
          <Show when={props.data().status === "ready" && props.data().tasks.length === 0}><p class="team-view__note" role="status">No subagents have been launched.</p></Show>
          <Show when={hasRows()}>
          <ul class="team-view__list"><For each={rows()}>{(id) => id.startsWith("section:")
            ? <li class="team-view__section"><h3>{id === "section:active" ? "ACTIVE" : "INACTIVE"}</h3><span class="team-view__count">{sectionCount(id)}</span></li>
            : <li class="team-view__task" data-session-id={id} data-state={task(id).state} data-attached={id === props.currentSessionID ? "true" : undefined}>
              <div class="team-view__row">
                <span class="team-view__state"><StateMark state={task(id).state} /><span>{working() === id ? "cancelling…" : task(id).state}</span></span>
                <strong class="team-view__title" title={`${task(id).agent ?? "Agent unreported"} · ${task(id).description}`}>{task(id).agent ?? "Agent unreported"} · {task(id).description}</strong>
                <div class="team-view__actions">
                  <button type="button" class="team-view__icon" data-action="open" aria-label={`Open ${task(id).description}`} title="Open" onClick={() => props.onOpen(id)}><Icon name="external" size={16} /></button>
                  <Show when={!controlsUnsupported() && canCancelSubagent(task(id).state)}><button type="button" class="team-view__icon team-view__icon--danger" data-action="cancel" aria-label={`Cancel ${task(id).description}`} title={controlsChecking() ? "Checking Team controls…" : "Cancel"}
                    disabled={!canControl() || working() !== undefined} onClick={(event) => setConfirm({ kind: "cancel", id, label: task(id).description, trigger: event.currentTarget })}><Icon name="stop" size={16} /></button></Show>
                  <Show when={!controlsUnsupported() && task(id).question && task(id).state === "waiting"}><button type="button" class="team-view__answer" data-action="answer" aria-expanded={answerID() === id} disabled={!canControl()} onClick={() => setAnswerID(answerID() === id ? undefined : id)}><Icon name="chat" size={14} /><span>Answer</span></button></Show>
                </div>
              </div>
              <p class="team-view__meta">{[task(id).modelLabel, id === props.currentSessionID ? "attached" : undefined,
                formatElapsed(task(id).startedAt, isActiveSubagent(task(id).state) ? props.now() : task(id).updatedAt)].filter((item) => item !== undefined).join(" · ")}</p>
              <TaskUsage task={() => task(id)} loading={() => props.data().economicsLoading === true} />
              <Show when={!controlsUnsupported() && answerID() === id ? task(id).question?.id : undefined} keyed><TeamAnswerForm question={task(id).question!} onAnswer={(questionID, text) => props.onAnswer(id, questionID, text)} /></Show>
            </li>}</For></ul>
          <Show when={props.data().next}><button type="button" class="team-view__more" disabled={props.data().pageLoading} onClick={() => runRead(props.onLoadOlder)}>
            {props.data().pageLoading ? "Loading older…" : `+${Math.max(0, (props.data().total ?? props.data().tasks.length) - props.data().tasks.length)} more · Load older`}
          </button></Show>
          </Show>
        </Show>
    </div>
    <div id="team-panel-shell" role="tabpanel" aria-label="Shell" hidden={tab() !== "shell"} inert={tab() !== "shell"}>
        <Show when={props.data().shellStatus !== "unsupported" && (props.data().shellStatus === "ready" || props.data().shells.length > 0)} fallback={props.data().shellStatus === "loading" ? <LoadingPlaceholder kind="team" label="Loading shells…" /> : <p role="status">{props.data().shellStatus === "unsupported" ? "Update YCoding on this machine to manage shells." : "Shells could not be loaded."}</p>}>
          <ul class="team-view__list"><For each={shells()}>{(id) => id.startsWith("owner:")
            ? <li class="team-view__owner"><h3>{ownerLabel(id.slice(6))}</h3></li>
            : <li class="team-view__shell" data-shell-id={id}>
            <div class="team-view__row"><span class="team-view__state"><StateMark state={shellMark[shell(id).status]} /><span>{working() === id ? "killing…" : shell(id).status}</span></span><strong class="team-view__title team-view__title--code" title={shell(id).command}>{shell(id).command}</strong></div>
            <p class="team-view__meta">{formatElapsed(shell(id).startedAt, shell(id).completedAt ?? props.now())}</p>
            <div class="team-view__actions"><button type="button" class="team-view__button" data-action="output" onClick={() => readOutput(shell(id).ownerID, id)}>View output</button>
              <Show when={shell(id).status === "running"}><button type="button" class="team-view__button team-view__button--danger" data-action="kill" disabled={working() !== undefined} onClick={(event) => setConfirm({ kind: "kill", id, label: shell(id).command, trigger: event.currentTarget })}>Kill</button></Show></div>
          </li>}</For></ul>
          <Show when={props.data().shellTruncated}><p role="status">Showing the first 50 family shells. More are running on this machine.</p></Show>
          <Show when={output()}>{(current) => <section class="team-view__output" aria-label="Shell output"><h3>Output</h3><Show when={current().page?.text} fallback={current().loading ? <LoadingPlaceholder kind="output" label="Loading output…" /> : <pre tabindex="0">No output reported.</pre>}>{(text) => <pre tabindex="0">{text()}</pre>}</Show>
            <Show when={current().page && current().loading}><LoadingPlaceholder kind="history" label="Loading more output…" /></Show>
            <Show when={current().page && current().page!.cursor < current().page!.size}><button type="button" disabled={current().loading} onClick={() => readOutput(current().ownerID, current().shellID, current().page?.cursor)}>Load more output</button></Show>
            <Show when={current().page?.truncated}><p>Output was truncated on the device.</p></Show></section>}</Show>
        </Show>
    </div>
    <div id="team-panel-side-chats" role="tabpanel" aria-label="Side chats" hidden={tab() !== "side-chats"} inert={tab() !== "side-chats"}>
        <Show when={props.data().sideChatStatus !== "unsupported" && (props.data().sideChatStatus === "ready" || props.data().sideChats.length > 0)} fallback={props.data().sideChatStatus === "loading" ? <LoadingPlaceholder kind="team" label="Loading side chats…" /> : <p role="status">{props.data().sideChatStatus === "unsupported" ? "Update YCoding on this machine to use side chats." : "Side chats could not be loaded."}</p>}>
          <button type="button" class="team-view__button team-view__button--primary" data-action="new-side-chat" disabled={working() !== undefined} onClick={() => {
            if (working() !== undefined) return
            const rootID = props.data().rootID
            setWorking("new-side-chat")
            setError(undefined)
            void props.onCreateSideChat().then((result) => { if (rootID !== props.data().rootID) return; if (result.status === "ok") props.onOpenSideChat(result.sessionID); else setError(result.message) },
              (cause: unknown) => { if (rootID === props.data().rootID) setError(cause instanceof Error ? cause.message : "Side chat could not be created.") }).finally(() => { if (rootID === props.data().rootID) setWorking(undefined) })
          }}>{working() === "new-side-chat" ? "Creating…" : "New side chat"}</button>
          <ul class="team-view__list"><For each={props.data().sideChats.map((item) => item.id)}>{(id) => <li class="team-view__side-chat" data-session-id={id}>
            <div class="team-view__row"><strong class="team-view__title">{sideChat(id).title}</strong><span class="team-view__time">{new Date(sideChat(id).updatedAt).toLocaleString()}</span>
            <div class="team-view__actions"><button type="button" class="team-view__icon" data-action="open" aria-label={`Open ${sideChat(id).title}`} title="Open" onClick={() => props.onOpenSideChat(id)}><Icon name="external" size={16} /></button></div></div>
          </li>}</For></ul>
          <Show when={props.data().sideChatNext}><button type="button" class="team-view__more" data-action="older-side-chats" disabled={props.data().sideChatLoading} onClick={() => runRead(props.onLoadOlderSideChats)}>{props.data().sideChatLoading ? "Loading older…" : "Load older side chats"}</button></Show>
          <Show when={props.data().sideChatLoading}><LoadingPlaceholder kind="team" label="Loading older side chats…" /></Show>
        </Show>
    </div>
  </section>
  return <>
    {panel}
    <Show when={confirm()} keyed>{(item) => {
      let close: (() => void) | undefined
      return <Modal class="overlay--dialog" label={item.kind === "cancel" ? "Cancel subagent" : "Kill shell"} returnFocus={item.trigger} onClose={() => { if (confirm()?.id === item.id && confirm()?.kind === item.kind) setConfirm(undefined) }}
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
