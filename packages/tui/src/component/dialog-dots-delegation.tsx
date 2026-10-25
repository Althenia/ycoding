import { Dots } from "@ycoding-ai/schema/dots"
import { Schema } from "effect"
import { createSignal, For, onCleanup, onMount } from "solid-js"
import { escapeDisplayText } from "@ycoding-ai/client/tool-display"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"

export type DotsDelegationChoice =
  | {
      kind: "create"
      source: Dots.DelegationStatus["sources"][number]
      task: Dots.DelegationStatus["tasks"][number]
      scope: Dots.DelegationScope
      minutes: number
    }
  | { kind: "revoke"; grant: Dots.DelegationInfo }

const decodeScope = Schema.decodeUnknownOption(Dots.DelegationScope)

export function DialogDotsDelegation(props: {
  load: () => Promise<Dots.DelegationStatus>
  locked: () => "pending" | "unknown" | undefined
  rejected: () => boolean
  onComplete: (choice: DotsDelegationChoice | null) => void
}) {
  const dialog = useDialog()
  const shortcuts = Keymap.useShortcuts()
  const [status, setStatus] = createSignal<Dots.DelegationStatus>()
  const [page, setPage] = createSignal<"edit" | "source" | "task" | "expiry">("edit")
  const [source, setSource] = createSignal<Dots.DelegationStatus["sources"][number]>()
  const [task, setTask] = createSignal<Dots.DelegationStatus["tasks"][number]>()
  const [instruction, setInstruction] = createSignal(false)
  const [format, setFormat] = createSignal<readonly ("prose" | "bullets")[]>([])
  const [detail, setDetail] = createSignal<readonly ("concise" | "standard" | "detailed")[]>([])
  const [minutes, setMinutes] = createSignal<number>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let closed = false
  onCleanup(() => {
    closed = true
  })
  const refresh = async () => {
    if (closed || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await props.load()
      if (closed) return
      setStatus(result)
      setSource(undefined)
      setTask(undefined)
      setPage("edit")
    } catch {
      if (!closed) {
        setStatus(undefined)
        setSource(undefined)
        setTask(undefined)
        setPage("edit")
        setError("Delegation context changed or unavailable. Refresh status.")
      }
    } finally {
      if (!closed) setBusy(false)
    }
  }
  onMount(() => {
    void refresh()
  })
  const scope = () =>
    decodeScope({
      operations: [
        ...(instruction() ? ["continue"] : []),
        ...(format().length || detail().length ? ["presentation"] : []),
      ],
      ...(format().length ? { format: format() } : {}),
      ...(detail().length ? { detail: detail() } : {}),
    })
  const finish = (choice: DotsDelegationChoice) => {
    if (closed || busy() || props.locked()) return
    props.onComplete(choice)
    dialog.clear()
  }
  const options = (): DialogSelectOption<string>[] => {
    const current = status()
    if (!current || props.locked()) return [{ title: "Refresh status", value: "refresh" }]
    if (page() === "source")
      return [
        { title: "Back", value: "back" },
        ...current.sources.map((item) => ({
          title: escapeDisplayText(item.principal.clientID),
          value: item.sourceExchangeID,
          description: escapeDisplayText(item.sourceExchangeID),
        })),
      ]
    if (page() === "task")
      return [
        { title: "Back", value: "back" },
        ...current.tasks.map((item) => ({ title: escapeDisplayText(item.taskInputID), value: item.taskInputID })),
      ]
    if (page() === "expiry")
      return [
        { title: "Back", value: "back" },
        ...[15, 30, 60].map((value) => ({ title: `${value} minutes`, value: String(value) })),
      ]
    return [
      ...current.grants.map((grant) => ({
        title: `${grant.active && grant.expiresAt > Date.now() ? "Revoke delegation" : "Inactive delegation"} · ${escapeDisplayText(grant.id)}`,
        value: `grant:${grant.id}`,
        details: [
          `Grant: ${escapeDisplayText(grant.id)}`,
          `Revision: ${grant.revision}`,
          `Expires: ${delegationExpiry(grant.expiresAt)}`,
        ],
        detailsWrap: true,
      })),
      {
        title: `Source exchange · ${source() ? escapeDisplayText(source()!.principal.clientID) : "not selected"}`,
        value: "source",
      },
      {
        title: `Existing native task · ${task() ? escapeDisplayText(task()!.taskInputID) : "not selected"}`,
        value: "task",
      },
      { title: `Instruction · Continue [${instruction() ? "allowed" : "off"}]`, value: "continue" },
      ...(["prose", "bullets"] as const).map((value) => ({
        title: `Format · ${value} [${format().includes(value) ? "allowed" : "off"}]`,
        value: `format:${value}`,
      })),
      ...(["concise", "standard", "detailed"] as const).map((value) => ({
        title: `Detail · ${value} [${detail().includes(value) ? "allowed" : "off"}]`,
        value: `detail:${value}`,
      })),
      { title: `Expiry · ${minutes() ? `${minutes()} minutes` : "not selected"}`, value: "expiry" },
      ...(source() && task() && minutes() && scope()._tag === "Some"
        ? [{ title: "Request native approval", value: "create" }]
        : []),
      { title: "Refresh status", value: "refresh" },
    ]
  }
  const select = (value: string) => {
    if (busy() || closed) return
    if (value === "refresh") {
      void refresh()
      return
    }
    if (props.locked()) return
    if (value === "back") {
      setPage("edit")
      return
    }
    if (page() === "source") {
      const selected = status()?.sources.find((item) => item.sourceExchangeID === value)
      if (selected) {
        setSource(selected)
        setPage("edit")
      }
      return
    }
    if (page() === "task") {
      const selected = status()?.tasks.find((item) => item.taskInputID === value)
      if (selected) {
        setTask(selected)
        setPage("edit")
      }
      return
    }
    if (page() === "expiry") {
      const selected = [15, 30, 60].find((item) => String(item) === value)
      if (selected) {
        setMinutes(selected)
        setPage("edit")
      }
      return
    }
    if (value === "source" || value === "task" || value === "expiry") {
      setPage(value)
      return
    }
    if (value === "continue") {
      setInstruction(!instruction())
      return
    }
    for (const option of ["prose", "bullets"] as const) {
      if (value === `format:${option}`) {
        setFormat((items) => (items.includes(option) ? items.filter((item) => item !== option) : [...items, option]))
        return
      }
    }
    for (const option of ["concise", "standard", "detailed"] as const) {
      if (value === `detail:${option}`) {
        setDetail((items) => (items.includes(option) ? items.filter((item) => item !== option) : [...items, option]))
        return
      }
    }
    if (value.startsWith("grant:")) {
      const grant = status()?.grants.find((item) => `grant:${item.id}` === value)
      if (grant?.active && grant.expiresAt > Date.now()) finish({ kind: "revoke", grant })
      return
    }
    const selectedSource = source()
    const selectedTask = task()
    const selectedScope = scope()
    const selectedMinutes = minutes()
    if (value === "create" && selectedSource && selectedTask && selectedMinutes && selectedScope._tag === "Some")
      finish({
        kind: "create",
        source: selectedSource,
        task: selectedTask,
        scope: selectedScope.value,
        minutes: selectedMinutes,
      })
  }
  return (
    <DialogSelect
      title={
        page() === "edit"
          ? "Coordinator delegation"
          : page() === "source"
            ? "Choose source exchange"
            : page() === "task"
              ? "Choose existing native task"
              : "Choose expiry"
      }
      options={options()}
      renderFilter={false}
      current={page() === "edit" ? undefined : "back"}
      preserveSelection
      locked={busy()}
      emptyView={<text>{busy() ? "Loading delegation…" : "No eligible choices"}</text>}
      footer={
        <text wrapMode="word">
          {busy()
            ? "Reading delegation status…"
            : props.locked() === "unknown"
              ? "Delegation outcome unknown. Mutations locked; Refresh status only."
              : props.locked() === "pending"
                ? "Delegation pending. Mutations locked; Refresh status only."
                : (error() ??
                  (props.rejected()
                    ? "Native delegation denied. No grant activated. A new proposal requires explicit selection and native approval."
                    : page() === "source" && !status()?.sources.length
                      ? "No authenticated source exchanges. Back to refresh status."
                      : page() === "task" && !status()?.tasks.length
                        ? "No eligible native task. Back to refresh status."
                        : "OAuth client, not a verified Dot/person. Existing task only; native approval required."))}
        </text>
      }
      footerHints={[
        { label: shortcuts.all("dialog.select.submit") ?? "enter", title: "choose" },
        { label: "esc", title: "close", side: "right" },
      ]}
      onSelect={(option) => select(option.value)}
    />
  )
}

DialogDotsDelegation.show = (
  dialog: DialogContext,
  props: Omit<Parameters<typeof DialogDotsDelegation>[0], "onComplete">,
) =>
  new Promise<DotsDelegationChoice | null>((resolve) => {
    let settled = false
    const finish = (choice: DotsDelegationChoice | null) => {
      if (settled) return
      settled = true
      resolve(choice)
    }
    dialog.replace(
      () => <DialogDotsDelegation {...props} onComplete={finish} />,
      () => finish(null),
    )
  })

export function DotsDelegationReview(props: { value: Dots.DelegationReview }) {
  const { theme } = useTheme()
  const lines = () => [
    "OAuth client — not a verified Dot or person",
    `Owner: ${props.value.principal.ownerID}`,
    `Device: ${props.value.principal.deviceID}`,
    `OAuth client: ${props.value.principal.clientID}`,
    `OAuth epoch: ${props.value.principal.epoch}`,
    `OAuth grant: ${props.value.principal.grantID}`,
    `Source exchange: ${props.value.sourceExchangeID}`,
    `Target Session: ${props.value.targetSessionID}`,
    `Native task: ${props.value.taskInputID}`,
    ...props.value.task.split("\n"),
    `Allowed operations: ${props.value.scope.operations.join(", ")}`,
    `Allowed formats: ${props.value.scope.format?.join(", ") ?? "unchanged"}`,
    `Allowed detail: ${props.value.scope.detail?.join(", ") ?? "unchanged"}`,
    `Expires: ${delegationExpiry(props.value.expiresAt)}`,
    `Profile: ${props.value.expectedAttachment.profile}`,
    `Dot: ${props.value.expectedAttachment.dotID}`,
    `Conversation: ${props.value.expectedAttachment.threadID}`,
    `Binding generation: ${props.value.expectedAttachment.generation}`,
    `Proposal: ${props.value.proposalID}`,
    `Fingerprint: ${props.value.fingerprint}`,
    "Current binding only. Restart, a new task, owner change, revoke or Unbind/rebind invalidates future admissions and unpromoted delegated inputs.",
    "Already executing native work continues. No new tasks, approval authority or human answers.",
  ]
  return (
    <box paddingLeft={3} paddingRight={3} flexShrink={0}>
      <For each={lines()}>
        {(line) => (
          <text fg={theme.text.default} wrapMode="word">
            {escapeDisplayText(line) || " "}
          </text>
        )}
      </For>
    </box>
  )
}

function delegationExpiry(time: number) {
  const date = new Date(time)
  return Number.isFinite(date.getTime()) ? date.toISOString() : "unavailable"
}
