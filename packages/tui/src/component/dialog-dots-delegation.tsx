import { Dots } from "@ycoding-ai/schema/dots"
import { createSignal, For, onCleanup, onMount } from "solid-js"
import { escapeDisplayText } from "@ycoding-ai/client/tool-display"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"


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

export function DotsSessionDelegationReview(props: { value: Dots.SessionDelegationReview }) {
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
    `Allowed operations: ${props.value.scope.operations.join(", ")}`,
    `Expires: ${delegationExpiry(props.value.expiresAt)}`,
    `Profile: ${props.value.expectedAttachment.profile}`,
    `Dot: ${props.value.expectedAttachment.dotID}`,
    `Conversation: ${props.value.expectedAttachment.threadID}`,
    `Binding generation: ${props.value.expectedAttachment.generation}`,
    `Proposal: ${props.value.proposalID}`,
    `Fingerprint: ${props.value.fingerprint}`,
    "Current binding only. Restart, owner change, revoke or Unbind/rebind invalidates future admissions and unpromoted delegated inputs.",
    "Client-delegated, not human. Tasks, and ordinary decisions only when allowed, within the approved scope; already executing native work continues.",
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

export type DotsBindingTarget = {
  sessionID: string
  title: string
  sources: Dots.DelegationStatus["sources"]
  grants: readonly Dots.DelegationInfo[]
  unavailable?: string
}

export type DotsBindingsChoice =
  | {
      kind: "bind"
      targets: readonly {
        sessionID: string
        sourceExchangeID: string
        principal: Dots.SessionDelegationInfo["principal"]
      }[]
      operations: Dots.SessionDelegationScope["operations"]
      minutes: 15 | 30 | 60
    }
  | { kind: "unbind"; grant: Dots.DelegationInfo }

export function DialogDotsBindings(props: {
  load: () => Promise<readonly DotsBindingTarget[]>
  locked: () => "pending" | "unknown" | undefined
  onComplete: (choice: DotsBindingsChoice | null) => void
}) {
  const dialog = useDialog()
  const shortcuts = Keymap.useShortcuts()
  const [targets, setTargets] = createSignal<readonly DotsBindingTarget[]>()
  const [page, setPage] = createSignal<"sessions" | "source" | "expiry" | "summary">("sessions")
  const [checked, setChecked] = createSignal<readonly string[]>([])
  const [chosen, setChosen] = createSignal<ReadonlyMap<string, string>>(new Map())
  const [sourceSession, setSourceSession] = createSignal<string>()
  const [operations, setOperations] = createSignal<readonly ("task" | "decision")[]>([])
  const [minutes, setMinutes] = createSignal<15 | 30 | 60>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string>()
  let closed = false
  onCleanup(() => {
    closed = true
  })
  const sourceFor = (target: DotsBindingTarget) => {
    if (target.sources.length === 1) return target.sources[0]
    const exchangeID = chosen().get(target.sessionID)
    return target.sources.find((source) => source.sourceExchangeID === exchangeID)
  }
  const sessionGrant = (target: DotsBindingTarget) =>
    target.grants.find((grant) => "basis" in grant && grant.active && grant.expiresAt > Date.now())
  const eligible = (target: DotsBindingTarget) => sourceFor(target) !== undefined && !sessionGrant(target)
  const refresh = async () => {
    if (closed || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await props.load()
      if (closed) return
      setTargets(result)
      setChecked((ids) => ids.filter((id) => result.some((target) => target.sessionID === id && eligible(target))))
      setPage("sessions")
    } catch {
      if (!closed) {
        setTargets(undefined)
        setPage("sessions")
        setError("Binding context changed or unavailable. Refresh status.")
      }
    } finally {
      if (!closed) setBusy(false)
    }
  }
  onMount(() => {
    void refresh()
  })
  const finish = (choice: DotsBindingsChoice) => {
    if (closed || busy() || props.locked()) return
    props.onComplete(choice)
    dialog.clear()
  }
  const selected = () => (targets() ?? []).filter((target) => checked().includes(target.sessionID) && eligible(target))
  const ready = () => selected().length > 0 && operations().includes("task") && minutes() !== undefined
  const options = (): DialogSelectOption<string>[] => {
    if (!targets() || props.locked()) return [{ title: "Refresh status", value: "refresh" }]
    if (page() === "source") {
      const target = targets()?.find((item) => item.sessionID === sourceSession())
      return [
        { title: "Back", value: "back" },
        ...(target?.sources.map((source) => ({
          title: escapeDisplayText(source.principal.clientID),
          value: source.sourceExchangeID,
          description: escapeDisplayText(source.sourceExchangeID),
        })) ?? []),
      ]
    }
    if (page() === "expiry")
      return [
        { title: "Back", value: "back" },
        ...([15, 30, 60] as const).map((value) => ({ title: `${value} minutes`, value: String(value) })),
      ]
    if (page() === "summary")
      return [
        { title: "Back", value: "back" },
        ...selected().map((target) => {
          const source = sourceFor(target)!
          return {
            title: `${escapeDisplayText(target.title)} · ${escapeDisplayText(target.sessionID)}`,
            value: `summary:${target.sessionID}`,
            details: [
              `Owner: ${escapeDisplayText(source.principal.ownerID)}`,
              `Device: ${escapeDisplayText(source.principal.deviceID)}`,
              `OAuth client: ${escapeDisplayText(source.principal.clientID)}`,
              `OAuth epoch: ${escapeDisplayText(source.principal.epoch)}`,
              `OAuth grant: ${escapeDisplayText(source.principal.grantID)}`,
              `Authority: ${operations().join(", ")}`,
              `Expiry: ${minutes()} minutes`,
              "Ends on restart, rebind, unbind, revoke or expiry.",
              "Client-delegated, not human instructions.",
            ],
            detailsWrap: true,
          }
        }),
        { title: "Bind", value: "bind" },
      ]
    return [
      ...(targets() ?? []).flatMap((target) => {
        const bound = sessionGrant(target)
        const main = bound
          ? {
              title: `Bound · ${escapeDisplayText(target.title)}`,
              value: `bound:${target.sessionID}`,
              details: [escapeDisplayText(target.sessionID), `Grant: ${escapeDisplayText(bound.id)}`],
              detailsWrap: true,
            }
          : {
              title: `${checked().includes(target.sessionID) ? "[x]" : "[ ]"} ${escapeDisplayText(target.title)}`,
              value: `target:${target.sessionID}`,
              details: [
                escapeDisplayText(target.sessionID),
                target.sources.length === 0
                  ? (target.unavailable ?? "No authenticated source exchange")
                  : sourceFor(target)
                    ? `OAuth client: ${escapeDisplayText(sourceFor(target)!.principal.clientID)}`
                    : "Choose source exchange",
              ],
              detailsWrap: true,
            }
        return [
          main,
          ...target.grants
            .filter((grant) => grant.active && grant.expiresAt > Date.now())
            .map((grant) => ({
              title: "Unbind",
              value: `grant:${JSON.stringify([target.sessionID, grant.id, grant.revision])}`,
              details: [
                `${escapeDisplayText(target.title)} · ${escapeDisplayText(target.sessionID)}`,
                `Grant: ${escapeDisplayText(grant.id)}`,
                `Revision: ${grant.revision}`,
                `Authority: ${grant.scope.operations.join(", ")}`,
                `Expires: ${delegationExpiry(grant.expiresAt)}`,
              ],
              detailsWrap: true,
            })),
        ]
      }),
      { title: `Tasks [${operations().includes("task") ? "allowed" : "off"}]`, value: "scope:task" },
      { title: `Ordinary decisions [${operations().includes("decision") ? "allowed" : "off"}]`, value: "scope:decision" },
      { title: `Expiry · ${minutes() ? `${minutes()} minutes` : "not selected"}`, value: "expiry" },
      ...(ready() ? [{ title: "Review binding", value: "review" }] : []),
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
      setPage("sessions")
      return
    }
    if (page() === "source") {
      const sessionID = sourceSession()
      const target = targets()?.find((item) => item.sessionID === sessionID)
      if (sessionID && target?.sources.some((source) => source.sourceExchangeID === value)) {
        setChosen((map) => new Map(map).set(sessionID, value))
        setPage("sessions")
      }
      return
    }
    if (page() === "expiry") {
      const selectedMinutes = ([15, 30, 60] as const).find((item) => String(item) === value)
      if (selectedMinutes) {
        setMinutes(selectedMinutes)
        setPage("sessions")
      }
      return
    }
    if (page() === "summary") {
      const selectedMinutes = minutes()
      if (value !== "bind" || !selectedMinutes || !ready()) return
      finish({
        kind: "bind",
        targets: selected().map((target) => {
          const source = sourceFor(target)!
          return { sessionID: target.sessionID, sourceExchangeID: source.sourceExchangeID, principal: source.principal }
        }),
        operations: operations().includes("decision") ? ["task", "decision"] : ["task"],
        minutes: selectedMinutes,
      })
      return
    }
    if (value.startsWith("target:")) {
      const target = targets()?.find((item) => `target:${item.sessionID}` === value)
      if (!target || sessionGrant(target)) return
      if (target.sources.length > 1 && !sourceFor(target)) {
        setSourceSession(target.sessionID)
        setPage("source")
        return
      }
      if (!eligible(target)) return
      setChecked((ids) =>
        ids.includes(target.sessionID) ? ids.filter((id) => id !== target.sessionID) : [...ids, target.sessionID],
      )
      return
    }
    if (value.startsWith("grant:")) {
      const grant = (targets() ?? [])
        .flatMap((target) => target.grants.map((item) => ({ target, grant: item })))
        .find(({ target, grant }) => value === `grant:${JSON.stringify([target.sessionID, grant.id, grant.revision])}`)
        ?.grant
      if (grant) finish({ kind: "unbind", grant })
      return
    }
    if (value === "scope:task" || value === "scope:decision") {
      const operation = value === "scope:task" ? "task" : "decision"
      setOperations((items) =>
        items.includes(operation) ? items.filter((item) => item !== operation) : [...items, operation],
      )
      return
    }
    if (value === "expiry") {
      setPage("expiry")
      return
    }
    if (value === "review" && ready()) setPage("summary")
  }
  return (
    <DialogSelect
      title={
        page() === "sessions"
          ? "Coordinator bindings"
          : page() === "source"
            ? "Choose source exchange"
            : page() === "expiry"
              ? "Choose expiry"
              : "Bind coordinator"
      }
      options={options()}
      renderFilter={false}
      current={page() === "sessions" ? undefined : "back"}
      preserveSelection
      locked={busy()}
      emptyView={<text>{busy() ? "Loading bindings…" : "No eligible choices"}</text>}
      footer={
        <text wrapMode="word">
          {busy()
            ? "Reading binding status…"
            : props.locked() === "unknown"
              ? "Delegation outcome unknown. Mutations locked; Refresh status only."
              : props.locked() === "pending"
                ? "Delegation pending. Mutations locked; Refresh status only."
                : (error() ??
                  (operations().includes("decision") && !operations().includes("task")
                    ? "Ordinary decisions require Tasks: a decision-only grant can never admit its own task."
                    : "OAuth client, not a verified Dot/person. Ends on restart, rebind, unbind, revoke or expiry; native approval required per Session."))}
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

DialogDotsBindings.show = (
  dialog: DialogContext,
  props: Omit<Parameters<typeof DialogDotsBindings>[0], "onComplete">,
) =>
  new Promise<DotsBindingsChoice | null>((resolve) => {
    let settled = false
    const finish = (choice: DotsBindingsChoice | null) => {
      if (settled) return
      settled = true
      resolve(choice)
    }
    dialog.replace(
      () => <DialogDotsBindings {...props} onComplete={finish} />,
      () => finish(null),
    )
  })
