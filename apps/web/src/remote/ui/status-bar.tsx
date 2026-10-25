import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import { Icon } from "../../ui/icon"
import { Modal } from "../../ui/modal"
import { useRemote } from "../context"
import { autonomyCategories, autonomyLabels, autonomyModeLabel, autonomySummary, type AutonomyModes } from "../autonomy"
import { reviewItemsInScope, sessionExecutionLabel, sessionStatusTimed } from "../projection"
import { createRemoteQuery } from "../query"
import { AutonomousDialog, autonomousDialogRequests } from "./autonomous-dialog"
import { DotTrail } from "./dot-trail"
import "./status-bar.css"

export function autonomyPhoneWord(modes: AutonomyModes) {
  const first = modes[autonomyCategories[0]]
  return autonomyCategories.every((category) => modes[category] === first) ? autonomyModeLabel(first) : "Mixed"
}

export function goalControlExpanded(state: { readonly popover: boolean; readonly leaving: boolean; readonly sheet: boolean }) {
  return state.sheet || state.popover && !state.leaving
}

export function ComposerStatus() {
  const remote = useRemote()
  const [now, setNow] = createSignal(Date.now())
  const [open, setOpen] = createSignal<"goal">()
  const [autonomousOpen, setAutonomousOpen] = createSignal(false)
  const [phone, setPhone] = createSignal(false)
  const [goalSheet, setGoalSheet] = createSignal(false)
  const [leaving, setLeaving] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [position, setPosition] = createSignal({ left: 8, top: 8, width: 320 })
  let autonomousTrigger: HTMLButtonElement | undefined
  let goalTrigger: HTMLButtonElement | undefined
  let popover: HTMLDivElement | undefined
  let closeGoalSheet: (() => void) | undefined
  const view = () => remote.state().view
  const current = () => {
    const selected = view()
    if (!selected) return undefined
    const running = remote.state().sessionStatus?.running.has(selected.id) ?? remote.state().selectedSessionInfo?.running ?? false
    return running && selected.status === "idle" ? { ...selected, status: "running" as const } : selected
  }
  const waiting = () => remote.state().team?.tasks.filter((task) => task.state === "starting" || task.state === "running" || task.state === "waiting").length ?? 0
  const timed = () => current() !== undefined && sessionStatusTimed(current()!, waiting())
  createEffect(() => {
    if (!timed()) return
    const timer = setInterval(() => setNow(Date.now()), 100)
    onCleanup(() => clearInterval(timer))
  })
  const label = () => current() ? sessionExecutionLabel(current()!, now(), waiting()) : "ready"
  const stateText = () => label().replace(/\? awaiting input/i, "Waiting for your decision").replace(/cooking/i, "Running")
  const elapsed = () => current()?.executionStarted === undefined ? "" : `${Math.floor(Math.max(0, now() - current()!.executionStarted!) / 60_000)}:${String(Math.floor(Math.max(0, now() - current()!.executionStarted!) / 1000) % 60).padStart(2, "0")}`
  const visible = () => current()?.status === "running" || current()?.status === "failed" || review() > 0
  const goal = () => view()?.autonomy?.goal
  const goalActive = () => goal()?.status === "active"
  const goalSetting = () => remote.state().mutations.some((mutation) => mutation.sessionID === view()?.id && mutation.operation === "session.goal.set" && mutation.state === "sending")
  const modes = () => view()?.autonomy?.effective ?? view()?.autonomy
  const summary = () => autonomySummary(modes()!)
  const asleep = () => view()?.autonomy?.effective?.asleep ?? view()?.autonomy?.sleep !== undefined
  const reachable = () => remote.state().transport.kind === "open" && remote.state().connection.kind === "connected"
  const keepAwake = createRemoteQuery(remote.store.queryClient, () => remote.queries.keepAwake(remote.scope(), asleep() && reachable()))
  const machineMaySleep = () => {
    const read = keepAwake().data
    return read?.read === "ready" && read.status !== undefined && read.status.state !== "on"
  }
  const review = () => { const selected = view(); return selected === undefined ? 0 : reviewItemsInScope(selected).length }
  const statusModes = () => [
    ...(modes() === undefined ? [] : summary().chips.filter((chip) => chip.mode !== "manual").map((chip) => ({ key: chip.key, label: chip.label, tone: chip.mode === "yolo" ? "attention" : chip.mode === "auto" ? "on" : "neutral" }))),
    ...(asleep() ? [machineMaySleep() ? { key: "sleep", label: "asleep · machine may sleep", tone: "attention" } : { key: "sleep", label: "asleep", tone: "on" }] : []),
    ...(review() > 0 ? [{ key: "review", label: `review ${review()}`, tone: "attention" }] : []),
  ]
  const close = (focus = false) => {
    if (!open() || leaving()) return
    const trigger = goalTrigger
    if (focus || popover?.contains(document.activeElement)) trigger?.focus()
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setOpen(undefined)
    else setLeaving(true)
  }
  const finish = (event: AnimationEvent) => {
    if (event.target !== event.currentTarget || event.animationName !== "session-status-out" || !leaving()) return
    setOpen(undefined)
    setLeaving(false)
  }
  let sessionID = view()?.id
  createEffect(() => {
    const next = view()
    if (sessionID === next?.id && next?.autonomy) return
    sessionID = next?.id
    close()
    setGoalSheet(false)
    setDraft("")
  })
  const reposition = () => {
    const trigger = goalTrigger
    if (!trigger || !popover) return
    const rect = trigger.getBoundingClientRect()
    const width = Math.min(320, window.innerWidth - 16)
    const height = popover.offsetHeight
    setPosition({ left: Math.min(Math.max(8, rect.left), window.innerWidth - width - 8), top: rect.top - height >= 8 ? rect.top - height - 8 : Math.min(rect.bottom + 8, window.innerHeight - height - 8), width })
  }
  const dismissGoal = (focus = true) => { if (phone()) closeGoalSheet?.(); else close(focus) }
  const toggle = () => {
    if (phone()) { setGoalSheet(true); return }
    if (open() === "goal" && !leaving()) { close(true); return }
    setLeaving(false)
    setOpen("goal")
    queueMicrotask(() => {
      reposition()
      const input = popover?.querySelector<HTMLInputElement>("input")
      if (input) input.focus()
      else popover?.querySelector<HTMLButtonElement>("button")?.focus()
    })
  }
  createEffect(on(autonomousDialogRequests, () => { if (view()?.autonomy !== undefined) setAutonomousOpen(true) }, { defer: true }))
  onMount(() => {
    const media = window.matchMedia("(max-width: 767px)")
    const follow = () => {
      setPhone(media.matches)
      if (media.matches) close()
      else setGoalSheet(false)
    }
    setPhone(media.matches)
    media.addEventListener("change", follow)
    onCleanup(() => media.removeEventListener("change", follow))
  })
  onMount(() => {
    const outside = (event: PointerEvent) => {
      if (open() && !leaving() && event.target instanceof Node && !popover?.contains(event.target) && !goalTrigger?.contains(event.target)) close()
    }
    document.addEventListener("pointerdown", outside)
    window.addEventListener("resize", reposition)
    window.addEventListener("scroll", reposition, true)
    onCleanup(() => {
      document.removeEventListener("pointerdown", outside)
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
    })
  })
  const goalPanel = () => <Show when={goal()?.status === "active"} fallback={<form onSubmit={(event) => { event.preventDefault(); if (!draft().trim()) return; void remote.store.setGoal(draft().trim()).then((accepted) => { if (!accepted) return; setDraft(""); dismissGoal() }) }}><label for="session-status-goal">Goal</label><input id="session-status-goal" type="text" aria-label="Goal" placeholder="Describe the objective" autofocus value={draft()} onInput={(event) => setDraft(event.currentTarget.value)} /><button type="submit" disabled={!draft().trim() || goalSetting()}>Set goal</button></form>}><p>{goal()?.text}</p><span>{goal()?.status} · iteration {goal()?.iteration} · no progress {goal()?.noProgress}/{goal()?.maxNoProgress}</span><button type="button" onClick={() => { dismissGoal(); void remote.store.stopGoal() }}>Stop goal</button></Show>
  return <div class="session-status" role="group" aria-label="Session status and autonomy">
    <span class="session-status__slot" role="status" classList={{ "session-status__slot--empty": !visible(), "session-status__slot--attention": /awaiting input|failed|provider error/i.test(label()), "session-status__slot--setting": goalSetting() }}>
      <Show when={goalSetting()}><span class="session-status__goal-setting" aria-hidden="true"><DotTrail /><span class="session-status__goal-setting-label">Setting goal…</span><span class="session-status__goal-setting-compact">Setting…</span></span></Show>
      <Show when={visible()}><Show when={timed()}><DotTrail /></Show><span class="session-status__label">{stateText()}</span><span class="session-status__mobile" aria-hidden="true">{elapsed() || (/awaiting input/i.test(label()) ? "Wait" : stateText().split(" · ")[0])}</span></Show>
    </span>
    <Show when={view()?.autonomy}>
    <button ref={autonomousTrigger} type="button" class="session-status__autonomous-trigger" aria-label={`Autonomous: ${autonomyLabels(modes()!).join(", ")}`} title={`Autonomous: ${autonomyLabels(modes()!).join(", ")}`} aria-haspopup="dialog" aria-expanded={autonomousOpen()} onClick={() => setAutonomousOpen(true)}><span class="session-status__autonomous-icon"><Icon name="shield" size={16} /></span><span class="session-status__autonomous-full">{summary().label}</span><span class="session-status__autonomous-word">{autonomyPhoneWord(modes()!)}</span></button>
    <button ref={goalTrigger} type="button" class="session-status__goal-trigger" classList={{ "session-status__goal-trigger--active": goalActive() || goalSetting() }} aria-label={goalSetting() ? "Setting goal" : goalActive() ? "Goal active" : "Goal off"} aria-busy={goalSetting() ? "true" : undefined} aria-haspopup="dialog" aria-expanded={goalControlExpanded({ popover: open() === "goal", leaving: leaving(), sheet: goalSheet() })} onClick={toggle}><span class="session-status__goal-label">Goal</span><Show when={goalActive()}>{" "}<span class="session-status__goal-count" aria-hidden="true">{goal()?.iteration}</span></Show><Show when={goalSetting()}><span class="session-status__goal-progress" aria-hidden="true"><span>Goal…</span><DotTrail /></span></Show></button>
    <Show when={statusModes().length > 0}><span class="session-status__modes"><For each={statusModes()}>{(mode) => <span class={`session-status__mode session-status__mode--${mode.tone}`} data-mode={mode.key} title={mode.label}><span class="session-status__mode-full">{mode.label}</span></span>}</For></span></Show>
    <Show when={goalActive()}><span class="session-status__active-goal" role="status" title={goal()?.text}>Goal active · {goal()?.text}</span></Show>
    <Show when={open()}><Portal><div ref={popover} class="session-status__popover" classList={{ "session-status__goal-popover": open() === "goal", "session-status__popover--leaving": leaving() }} role="dialog" aria-label="Goal details" aria-hidden={leaving() ? "true" : undefined} inert={leaving()} style={{ left: `${position().left}px`, top: `${position().top}px`, width: `${position().width}px` }} onAnimationEnd={finish} onAnimationCancel={finish} onKeyDown={(event) => { if (event.key === "Escape" && !leaving()) { event.preventDefault(); close(true) } }}>
      <Show when={open() === "goal"}>{goalPanel()}</Show>
    </div></Portal></Show>
    <Show when={goalSheet()}><Modal class="overlay--confirm" label="Goal" returnFocus={goalTrigger!} onClose={() => setGoalSheet(false)} requestClose={(handoff) => { closeGoalSheet = handoff }}><div class="session-status__goal-sheet">{goalPanel()}</div></Modal></Show>
    <Show when={autonomousOpen()}><AutonomousDialog returnFocus={autonomousTrigger!} onClose={() => setAutonomousOpen(false)} /></Show>
    </Show>
    <span class="visually-hidden session-status__announce" role="status">{goalSetting() ? "Setting goal…" : ""}</span>
  </div>
}
