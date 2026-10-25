import type { Dots } from "@ycoding-ai/schema/dots"
import { useTerminalDimensions } from "@opentui/solid"
import { Show, createSignal, onCleanup, onMount } from "solid-js"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { dialogPanelWidth, useDialog, type DialogContext } from "../ui/dialog"
import { escapeDisplayText } from "@ycoding-ai/client/tool-display"
import { Keymap } from "../context/keymap"
import { stringWidth } from "../util/string-width"

export function DialogDots(props: {
  profiles: readonly string[]
  load: (profile: string) => Promise<readonly Dots.Target[]>
  confirm: (target: Dots.Target) => Promise<void>
  status: () => Promise<Dots.Status>
  pause: (target: Dots.Target) => Promise<Dots.Status>
  resume: (target: Dots.Target) => Promise<Dots.Status>
  onComplete: (target: Dots.Target | null) => void
}) {
  const dialog = useDialog()
  const shortcuts = Keymap.useShortcuts()
  const dimensions = useTerminalDimensions()
  const [profile, setProfile] = createSignal<string>()
  const [targets, setTargets] = createSignal<readonly Dots.Target[]>([])
  const [chosen, setChosen] = createSignal<Dots.Target>()
  const [editingName, setEditingName] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  const [status, setStatus] = createSignal<Dots.Status>()
  const [selecting, setSelecting] = createSignal(false)
  const [stale, setStale] = createSignal(false)
  const [changing, setChanging] = createSignal<"pause" | "resume">()
  let closed = false
  onCleanup(() => {
    closed = true
  })
  const accept = (result: Dots.Status) => {
    if (result.enabled) return true
    props.onComplete(null)
    dialog.clear()
    return false
  }
  const binding = () => selecting() ? undefined : status()?.target
  const runtimeAction = () => !stale() && binding() && status()?.state === "connected"
    ? status()?.runtimeState === "unpaused" ? "pause" : status()?.runtimeState === "paused" ? "resume" : undefined
    : undefined
  const runtimeLabel = () => stale() || status()?.state !== "connected" ? "Runtime state unavailable"
    : status()?.runtimeState === "paused" ? "Paused" : status()?.runtimeState === "unpaused" ? "Not paused" : "Runtime state unavailable"
  const refresh = async () => {
    if (busy() || closed) return
    setBusy(true)
    setError(undefined)
    setStale(true)
    try {
      const result = await props.status()
      if (closed || !accept(result)) return
      setStatus(result)
      setStale(false)
    } catch {
      if (!closed) setError("Dots status could not be read. Refresh status before controlling the Dot runtime.")
    } finally {
      if (!closed) setBusy(false)
    }
  }
  onMount(() => { void refresh() })
  const targetDetails = (target: Dots.Target) => [
    { label: "Dot ID", value: escapeDisplayText(target.dotID) },
    { label: "Conversation", value: escapeDisplayText(target.threadID) },
  ].flatMap((item) => {
    const detail = `${item.label}: ${item.value}`
    return stringWidth(detail) > Math.max(1, dialogPanelWidth(dimensions().width) - 10)
      ? [`${item.label}:`, item.value]
      : [detail]
  })
  const options = () =>
    binding()
      ? [
          ...(runtimeAction() ? [{ title: runtimeAction() === "pause" ? "Pause Dot" : "Resume Dot", value: runtimeAction()!, description: runtimeLabel() }] : []),
          { title: "Refresh status", value: "refresh" },
          { title: "Edit display name", value: "name", details: targetDetails(binding()!), detailsWrap: true },
          { title: "Change destination", value: "change" },
        ]
      : error() && !selecting()
        ? [{ title: "Refresh status", value: "refresh" }, { title: "Change destination", value: "change" }]
      : chosen()
      ? [
          {
            title: `Confirm ${escapeDisplayText(chosen()!.label)}`,
            value: "confirm",
            details: targetDetails(chosen()!),
            detailsWrap: true,
          },
          { title: "Edit display name", value: "name" },
        ]
      : profile()
        ? targets().map((target) => ({
            title: escapeDisplayText(target.label),
            value: JSON.stringify(target),
            details: targetDetails(target),
            detailsWrap: true,
          }))
        : props.profiles.map((name) => ({ title: escapeDisplayText(name), value: name, description: "ChatGPT profile" }))

  const select = async (value: string) => {
    if (busy() || closed) return
    if (value === "name" && (chosen() || binding())) {
      const target = chosen() ?? binding()
      if (!target) return
      setChosen(target)
      setSelecting(true)
      setEditingName(true)
      return
    }
    if (binding() || error() && !selecting()) {
      if (value === "refresh") { await refresh(); return }
      if (value === "change") {
        setStatus(undefined)
        setSelecting(true)
        setProfile(undefined)
        setChosen(undefined)
        setTargets([])
        setError(undefined)
        return
      }
      const action = runtimeAction()
      const target = binding()
      if (!action || value !== action || !target) return
      setBusy(true)
      setChanging(action)
      setStale(true)
      setError(undefined)
      try {
        const result = action === "pause" ? await props.pause(target) : await props.resume(target)
        if (closed || !accept(result)) return
        setStatus(result)
        setStale(false)
      } catch {
        if (!closed) setError("Runtime control not confirmed. Refresh status; reconfirm the destination before another action.")
      } finally {
        if (!closed) { setBusy(false); setChanging(undefined) }
      }
      return
    }
    setBusy(true)
    setError(undefined)
    try {
      const target = chosen()
      if (target) {
        await props.confirm(target)
        if (closed) return
        props.onComplete(target)
        dialog.clear()
        return
      }
      if (profile()) {
        const selected = targets().find((target) => JSON.stringify(target) === value)
        if (selected) setChosen(selected)
        return
      }
      const loaded = await props.load(value)
      if (closed) return
      setTargets(loaded)
      setProfile(value)
    } catch {
      if (!closed) setError("Could not resolve the Dots destination. Keep the draft and select again.")
    } finally {
      if (!closed) setBusy(false)
    }
  }

  return (
    <Show when={!editingName()} fallback={<DialogPrompt
      title="Dot display name"
      description={() => <text>User-chosen display name only; the Dot identity and permissions stay unchanged.</text>}
      value={chosen()?.label}
      placeholder="Optional display name"
      onConfirm={(value) => {
        const target = chosen()
        if (!target || closed) return
        setChosen({ ...target, label: value.trim() || target.label })
        setEditingName(false)
      }}
    />}>
    <DialogSelect
      title={
        binding()
          ? `Dots destination · ${escapeDisplayText(binding()!.label)}`
        : chosen()
          ? "Confirm Dots destination · no message sent"
          : profile()
            ? "Select Dot and conversation"
            : "Select ChatGPT profile for Dots"
      }
      options={options()}
      locked={busy()}
      renderFilter={!binding() && !chosen() && !error() && (profile() ? targets().length > 1 : props.profiles.length > 1)}
      emptyView={<text>{error() ?? (busy() ? "Loading destinations…" : "No destinations available")}</text>}
      footer={error() || binding() ? <text>{error() ?? `${status()?.state} · ${changing() ? changing() === "pause" ? "Pausing Dot…" : "Resuming Dot…" : runtimeLabel()} · Escape closes`}{runtimeAction() ? "\nPause stops the Dot's autonomous runtime until Resume; Resume may continue its work and goals." : ""}</text> : undefined}
      footerHints={error() || binding() ? [] : [
        ...[shortcuts.all("dialog.select.submit")].flatMap((label) => label ? [{ label, title: chosen() ? "confirm only" : "select" }] : []),
        { label: "esc", title: "cancel", side: "right" },
      ]}
      onSelect={(option) => {
        void select(option.value)
      }}
    />
    </Show>
  )
}

DialogDots.show = (dialog: DialogContext, props: Omit<Parameters<typeof DialogDots>[0], "onComplete">) =>
  new Promise<Dots.Target | null>((resolve) => {
    let settled = false
    const finish = (target: Dots.Target | null) => {
      if (settled) return
      settled = true
      resolve(target)
    }
    dialog.replace(
      () => <DialogDots {...props} onComplete={finish} />,
      () => finish(null),
    )
  })
