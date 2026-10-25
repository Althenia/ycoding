import type { RemoteDotsTarget, RemoteDotsStatus } from "@ycoding-ai/remote"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { escapeDisplayText } from "../../../../../packages/client/src/tool-display"
import { Modal } from "../../ui/modal"

export function DotsDialog(props: {
  returnFocus: HTMLElement
  load: (profile: string) => Promise<readonly RemoteDotsTarget[]>
  confirm: (target: RemoteDotsTarget) => Promise<void>
  status: () => Promise<RemoteDotsStatus>
  pause: (target: RemoteDotsTarget) => Promise<RemoteDotsStatus>
  resume: (target: RemoteDotsTarget) => Promise<RemoteDotsStatus>
  onClose: () => void
}) {
  const [profile, setProfile] = createSignal("")
  const [targets, setTargets] = createSignal<readonly RemoteDotsTarget[]>([])
  const [chosen, setChosen] = createSignal<RemoteDotsTarget>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [status, setStatus] = createSignal<RemoteDotsStatus>()
  const [selecting, setSelecting] = createSignal(false)
  const [stale, setStale] = createSignal(false)
  const [changing, setChanging] = createSignal<"pause" | "resume">()
  let close: (() => void) | undefined
  let generation = 0
  onCleanup(() => {
    generation++
  })
  const binding = () => selecting() ? undefined : status()?.target
  const runtimeAction = () => !stale() && binding() && status()?.state === "connected"
    ? status()?.runtimeState === "unpaused" ? "pause" : status()?.runtimeState === "paused" ? "resume" : undefined
    : undefined
  const runtimeLabel = () => stale() || status()?.state !== "connected" ? "Runtime state unavailable"
    : status()?.runtimeState === "paused" ? "Paused" : status()?.runtimeState === "unpaused" ? "Not paused" : "Runtime state unavailable"
  const refresh = async () => {
    if (busy()) return
    const current = ++generation
    setBusy(true)
    setError(undefined)
    setStale(true)
    try {
      const result = await props.status()
      if (current === generation) { setStatus(result); setStale(false) }
    } catch {
      if (current === generation) setError("Dots status could not be read. Refresh status before controlling the Dot runtime.")
    } finally {
      if (current === generation) setBusy(false)
    }
  }
  onMount(() => { void refresh() })
  const changeRuntime = async () => {
    const action = runtimeAction()
    const target = binding()
    if (!action || !target || busy()) return
    const current = ++generation
    setBusy(true)
    setChanging(action)
    setStale(true)
    setError(undefined)
    try {
      const result = action === "pause" ? await props.pause(target) : await props.resume(target)
      if (current === generation) { setStatus(result); setStale(false) }
    } catch {
      if (current === generation) setError("Runtime control not confirmed. Refresh status; reconfirm the destination before another action.")
    } finally {
      if (current === generation) { setBusy(false); setChanging(undefined) }
    }
  }
  const load = async () => {
    if (!profile().trim() || busy()) return
    const current = ++generation
    setBusy(true)
    setError(undefined)
    setChosen(undefined)
    try {
      const result = await props.load(profile().trim())
      if (current === generation) setTargets(result)
    } catch {
      if (current === generation) setError("Could not read Dots destinations. Keep the draft and try selecting again.")
    } finally {
      if (current === generation) setBusy(false)
    }
  }
  const confirm = async () => {
    const target = chosen()
    if (!target || busy()) return
    const current = ++generation
    setBusy(true)
    setError(undefined)
    try {
      await props.confirm(target)
      if (current === generation) close?.()
    } catch {
      if (current === generation) setError("The Dots destination was not confirmed. Keep the draft and select again.")
    } finally {
      if (current === generation) setBusy(false)
    }
  }
  return (
    <Modal
      class="overlay--confirm"
      label="Select Dots destination"
      returnFocus={props.returnFocus}
      onClose={() => {
        generation++
        props.onClose()
      }}
      requestClose={(handoff) => {
        close = handoff
      }}
    >
      <Show when={binding()}>{(target) => <>
        <p class="field__hint">Dots · {escapeDisplayText(target().label)} · {escapeDisplayText(target().dotID)} · {escapeDisplayText(target().threadID)} · {status()?.state}</p>
        <p class="field__hint" role="status">{changing() ? changing() === "pause" ? "Pausing Dot…" : "Resuming Dot…" : runtimeLabel()}</p>
        <Show when={runtimeAction()}><p class="field__hint">Pause stops the Dot's autonomous runtime until Resume; Resume may continue its work and goals.</p></Show>
        <div class="device-cleanup-actions">
          <Show when={runtimeAction()}>{(action) => <button type="button" class={action() === "pause" ? "button button--danger" : "button button--secondary"} disabled={busy()} onClick={() => { void changeRuntime() }}>{action() === "pause" ? "Pause Dot" : "Resume Dot"}</button>}</Show>
          <button type="button" class="button button--secondary" disabled={busy()} onClick={() => { void refresh() }}>Refresh status</button>
          <button type="button" class="button button--secondary" disabled={busy()} onClick={() => {
            generation++
            setStatus(undefined)
            setSelecting(true)
            setTargets([])
            setChosen(undefined)
            setError(undefined)
          }}>Change destination</button>
        </div>
      </>}</Show>
      <Show when={!binding()}>
      <label class="field">
        <span class="field__label">ChatGPT profile label</span>
        <input
          class="input"
          value={profile()}
          disabled={busy()}
          onInput={(event) => {
            generation++
            setProfile(event.currentTarget.value)
            setTargets([])
            setChosen(undefined)
          }}
        />
      </label>
      <button
        type="button"
        class="button button--secondary"
        disabled={busy() || !profile().trim()}
        onClick={() => {
          void load()
        }}
      >
        Read destinations
      </button>
      <For each={targets()}>
        {(target) => (
          <label class="check">
            <input
              type="radio"
              name="dots-destination"
              checked={chosen() === target}
              disabled={busy()}
              onChange={() => setChosen(target)}
            />
            <span class="check__body">
              <span class="check__title">{escapeDisplayText(target.label)}</span>
              <span class="field__hint">
                {escapeDisplayText(target.dotID)} · {escapeDisplayText(target.threadID)}
              </span>
            </span>
          </label>
        )}
      </For>
      <p class="field__hint">Confirm selects a Dot and conversation only. Explicit Send transmits the draft.</p>
      <Show when={error()}><button type="button" class="button button--secondary" disabled={busy()} onClick={() => { void refresh() }}>Refresh status</button></Show>
      </Show>
      <Show when={error()}>
        {(message) => (
          <p class="composer__attachment-error" role="alert">
            {message()}
          </p>
        )}
      </Show>
      <div class="device-cleanup-actions">
        <button type="button" class="button button--secondary" onClick={() => close?.()}>
          Cancel
        </button>
        <Show when={!binding()}><button
          type="button"
          class="button button--primary"
          disabled={busy() || !chosen()}
          onClick={() => {
            void confirm()
          }}
        >
          Confirm destination
        </button></Show>
      </div>
    </Modal>
  )
}
