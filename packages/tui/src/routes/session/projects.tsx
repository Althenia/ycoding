import { InputRenderable, ScrollBoxRenderable, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Index, Show, type Accessor } from "solid-js"
import { BrandMark } from "../../component/logo"
import { Keymap } from "../../context/keymap"
import { useCoordination } from "../../context/coordination"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useDialog } from "../../ui/dialog"
import { useToast } from "../../ui/toast"
import {
  assignRole,
  capacitySummary,
  coordinatorChoices,
  delegatedCategories,
  delegationSummary,
  externalNotificationKinds,
  formatBudget,
  leaseLine,
  lifecycleActions,
  narrowingError,
  notificationFilterLabel,
  parseBudget,
  parseConcurrency,
  parseExpiry,
  parseList,
  parseQueueCapacity,
  queueReasonLabel,
  receiptLine,
  selectionLine,
  relativeAge,
  relativeFuture,
  removeMember,
  rosterError,
  statusLabel,
  toggleCategory,
  toggleCoordinator,
  type CoordinationGroupView,
  type CoordinationRole,
  type CoordinationService,
  type CoordinationSessionChoice,
  type DelegatedCategory,
  type DelegatedDecisionsView,
  type GlobalDelegationView,
  type NotificationFilter,
} from "../../util/coordination"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"

type Tone = "success" | "warning" | "error" | "subdued"

type Row = {
  key: string
  kind: "heading" | "info" | "item"
  label: string
  value?: string
  tone?: Tone
  indent?: number
  fit?: boolean
  activate?: () => void
  step?: (direction: 1 | -1) => void
  edit?: { initial: string; commit: (text: string) => void }
}

const roles: readonly CoordinationRole[] = ["coordinator", "worker", "observer"]
const scopes = ["all", "coordinators", "selected"] as const
const receiptLimit = 5

export function ProjectsScreen() {
  const route = useRouteData("projects")
  const router = useRoute()
  const coordination = useCoordination()
  const toast = useToast()
  return (
    <ProjectsScreenContent
      groups={coordination.groups}
      error={coordination.error}
      sessions={coordination.sessions}
      service={coordination.service}
      filter={coordination.filter}
      globalDelegation={coordination.globalDelegation}
      onFilterChange={(next) => void coordination.setFilter(next).catch(toast.error)}
      onRefresh={() => void coordination.refresh()}
      onBack={() => router.navigate(route.sessionID ? { type: "session", sessionID: route.sessionID } : { type: "home" })}
    />
  )
}

export function ProjectsScreenContent(props: {
  groups: Accessor<CoordinationGroupView[] | undefined>
  error?: Accessor<string | undefined>
  sessions: Accessor<readonly CoordinationSessionChoice[]>
  service: CoordinationService
  filter: Accessor<NotificationFilter>
  globalDelegation: Accessor<GlobalDelegationView | undefined>
  onFilterChange: (filter: NotificationFilter) => void
  now?: Accessor<number>
  onBack?: () => void
  onRefresh?: () => void
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const dialog = useDialog()
  const toast = useToast()
  const backShortcut = Keymap.useShortcut("projects.back")
  const refreshShortcut = Keymap.useShortcut("projects.refresh")
  const now = () => props.now?.() ?? Date.now()
  const [selectedID, setSelectedID] = createSignal<string>()
  const [expanded, setExpanded] = createSignal<string>()
  const [addIndex, setAddIndex] = createSignal(0)
  const [creating, setCreating] = createSignal<{ name: string; coordinatorIndex: number }>()
  const [busy, setBusy] = createSignal(false)
  const [cursorKey, setCursorKey] = createSignal<string>()
  const [lastIndex, setLastIndex] = createSignal(0)
  const [editing, setEditing] = createSignal<{ key: string; draft: string }>()
  let scroll: ScrollBoxRenderable | undefined

  const project = createMemo(() => {
    const groups = props.groups() ?? []
    return groups.find((group) => group.id === selectedID()) ?? groups[0]
  })

  function run(failure: string, call: () => Promise<void>, success?: string) {
    if (busy()) return
    setBusy(true)
    void call()
      .then(() => {
        if (success) toast.show({ message: success, variant: "success", duration: 3000 })
      })
      .catch((error) => toast.show({ message: `${failure}: ${errorMessage(error)}`, variant: "error", duration: 5000 }))
      .finally(() => setBusy(false))
  }

  const refuse = (message: string) => toast.show({ message, variant: "error", duration: 5000 })

  function confirm(title: string, message: string, onConfirm: () => void) {
    dialog.replace(() => <DialogConfirm title={title} message={message} onConfirm={onConfirm} />)
  }

  const rows = createMemo<Row[]>(() => {
    const groups = props.groups()
    const failure = props.error?.()
    const open = project()
    const form = creating()
    const choices = coordinatorChoices(groups)
    const filter = props.filter()
    const global = props.globalDelegation()
    const heading = (text: string): Row => ({ key: `heading:${text}`, kind: "heading", label: text })
    const info = (key: string, label: string, value?: string, tone?: Tone, indent?: number, fit?: boolean): Row => ({ key, kind: "info", label, value, tone, indent, fit })
    const result: Row[] = [heading("Projects")]
    if (groups === undefined) result.push(info("loading", failure ?? "Loading projects…", undefined, failure ? "error" : "subdued"))
    else if (groups.length === 0) result.push(info("empty", "No projects", undefined, "subdued"))
    else
      groups.forEach((group) =>
        result.push({
          key: `project:${group.id}`,
          kind: "item",
          label: `${group.id === open?.id && !form ? "● " : "  "}${group.name}`,
          value: `${statusLabel(group.status)} · ${capacitySummary(group.capacity, group.policy)}`,
          tone: group.status === "armed" ? "success" : group.status === "completed" ? "subdued" : group.status === "disarmed" ? undefined : "warning",
          activate: () => {
            setSelectedID(group.id)
            setExpanded(undefined)
            setCreating(undefined)
          },
        }),
      )
    result.push({
      key: "new",
      kind: "item",
      label: "+ New project",
      activate: () => setCreating({ name: "", coordinatorIndex: 0 }),
    })
    if (form) result.push(...createRows(form))
    else if (open) result.push(...projectRows(open, global))
    result.push(...notificationRows(choices, filter, groups))
    return result

    function createRows(draft: { name: string; coordinatorIndex: number }): Row[] {
      const available = props.sessions()
      const coordinator = available[Math.min(draft.coordinatorIndex, available.length - 1)]
      return [
        heading("New project"),
        {
          key: "create:name",
          kind: "item",
          label: "Name",
          value: draft.name || "—",
          edit: { initial: draft.name, commit: (text) => setCreating({ ...draft, name: text.trim() }) },
        },
        {
          key: "create:coordinator",
          kind: "item",
          label: "Coordinator session",
          value: coordinator?.title ?? "no sessions available",
          step: (direction) => {
            if (available.length > 0)
              setCreating({ ...draft, coordinatorIndex: (draft.coordinatorIndex + direction + available.length) % available.length })
          },
          activate: () => {
            if (available.length > 0) setCreating({ ...draft, coordinatorIndex: (draft.coordinatorIndex + 1) % available.length })
          },
        },
        {
          key: "create:submit",
          kind: "item",
          label: "Create project",
          activate: () => {
            if (!draft.name) return refuse("Project name is required")
            if (!coordinator) return refuse("Choose a coordinator session")
            run(
              "Failed to create project",
              () => props.service.create({ name: draft.name, roster: [{ sessionID: coordinator.sessionID, role: "coordinator" }] }),
              "Project created",
            )
            setCreating(undefined)
          },
        },
        { key: "create:cancel", kind: "item", label: "Cancel", activate: () => setCreating(undefined) },
      ]
    }

    function projectRows(group: CoordinationGroupView, policy: GlobalDelegationView | undefined): Row[] {
      const out: Row[] = [heading("Project")]
      out.push({
        key: "project:name",
        kind: "item",
        label: "Name",
        value: group.name,
        edit: {
          initial: group.name,
          commit: (text) => {
            const name = text.trim()
            if (!name) return refuse("Project name is required")
            if (name !== group.name) run("Failed to rename project", () => props.service.rename(group.id, name))
          },
        },
      })
      out.push(info("project:status", "Status", `${statusLabel(group.status)} · ${capacitySummary(group.capacity, group.policy)}`))
      lifecycleActions(group.status).forEach((action) =>
        out.push({
          key: `lifecycle:${action.id}`,
          kind: "item",
          label: action.title,
          activate: () => {
            if (action.id === "complete")
              return confirm(`Complete ${group.name}?`, "Completing ends this project. The backend decides whether it can complete.", () =>
                run("Failed to complete project", () => props.service.complete(group.id), "Project completed"),
              )
            const call = action.id === "stop" ? () => props.service.stop(group.id) : () => props.service.arm(group.id)
            run(`Failed to ${action.id === "rearm" ? "re-arm" : action.id} project`, call)
          },
        }),
      )
      out.push(heading("Sessions"))
      group.roster.forEach((member) => {
        const open = expanded() === member.sessionID
        out.push({
          key: `member:${member.sessionID}`,
          kind: "item",
          label: member.title,
          value: `${member.role} · tools ${member.allowedTools?.join(", ") ?? "all"} · scopes ${member.resourceScopes?.join(", ") ?? "all"}`,
          activate: () => setExpanded(open ? undefined : member.sessionID),
        })
        if (!open) return
        const changeRole = (role: CoordinationRole) => {
          if (role === member.role) return
          const next = assignRole(group.roster, member, role)
          const error = rosterError(next)
          if (error) return refuse(error)
          run("Failed to change role", () => props.service.setMemberRole(group.id, member.sessionID, role))
        }
        const shift = (direction: 1 | -1) => changeRole(roles[(roles.indexOf(member.role) + direction + roles.length) % roles.length]!)
        out.push({ key: `member:${member.sessionID}:role`, kind: "item", label: "Role", value: member.role, indent: 2, step: shift, activate: () => shift(1) })
        out.push({
          key: `member:${member.sessionID}:tools`,
          kind: "item",
          label: "Allowed tools",
          value: member.allowedTools?.join(", ") ?? "all tools",
          indent: 2,
          edit: {
            initial: member.allowedTools?.join(", ") ?? "",
            commit: (text) => {
              const parsed = parseList(text, "tools")
              if (parsed.error !== undefined) return refuse(parsed.error)
              run("Failed to update tools", () => props.service.setMemberAccess(group.id, member.sessionID, { allowedTools: parsed.value }))
            },
          },
        })
        out.push({
          key: `member:${member.sessionID}:scopes`,
          kind: "item",
          label: "Resource scopes",
          value: member.resourceScopes?.join(", ") ?? "all scopes",
          indent: 2,
          edit: {
            initial: member.resourceScopes?.join(", ") ?? "",
            commit: (text) => {
              const parsed = parseList(text, "scopes")
              if (parsed.error !== undefined) return refuse(parsed.error)
              run("Failed to update scopes", () => props.service.setMemberAccess(group.id, member.sessionID, { resourceScopes: parsed.value }))
            },
          },
        })
        out.push({
          key: `member:${member.sessionID}:remove`,
          kind: "item",
          label: "Remove from project",
          indent: 2,
          activate: () => {
            const removed = removeMember(group.roster, member.sessionID)
            if (removed.error !== undefined) return refuse(removed.error)
            confirm(`Remove ${member.title} from ${group.name}?`, "The session keeps running; it only leaves this project.", () =>
              run("Failed to remove session", () => props.service.removeMember(group.id, member.sessionID)),
            )
          },
        })
      })
      const candidates = props.sessions().filter((session) => !group.roster.some((member) => member.sessionID === session.sessionID))
      const candidate = candidates[Math.min(addIndex(), candidates.length - 1)]
      if (candidate)
        out.push({
          key: "member:add",
          kind: "item",
          label: "Add session",
          value: candidate.title,
          step: (direction) => setAddIndex((addIndex() + direction + candidates.length) % candidates.length),
          activate: () => run("Failed to add session", () => props.service.addMember(group.id, candidate.sessionID, "worker")),
        })
      else out.push(info("member:add", "Add session", "no other sessions", "subdued"))

      out.push(heading("Policy"))
      const policyEdit = (key: string, label: string, value: string, initial: string, commit: (text: string) => void): Row => ({
        key,
        kind: "item",
        label,
        value,
        edit: { initial, commit },
      })
      const patch = (failure: string, change: Parameters<CoordinationService["updatePolicy"]>[1]) =>
        run(failure, () => props.service.updatePolicy(group.id, change))
      out.push(
        policyEdit(
          "policy:concurrency",
          "Concurrency",
          group.policy.concurrency === null
            ? `uncapped policy · hard limit ${group.capacity.hardLimit ?? "unreported"} applies`
            : String(group.policy.concurrency),
          group.policy.concurrency === null ? "uncapped" : String(group.policy.concurrency),
          (text) => {
            const parsed = parseConcurrency(text)
            if (parsed.error !== undefined) return refuse(parsed.error)
            patch("Failed to update concurrency", { concurrency: parsed.value })
          },
        ),
        policyEdit("policy:queue", "Queue capacity", String(group.policy.queueCapacity), String(group.policy.queueCapacity), (text) => {
          const parsed = parseQueueCapacity(text)
          if (parsed.error !== undefined) return refuse(parsed.error)
          patch("Failed to update queue capacity", { queueCapacity: parsed.value })
        }),
        policyEdit(
          "policy:budget",
          "Budget",
          group.policy.budget === undefined ? "none" : formatBudget(group.policy.budget),
          group.policy.budget === undefined ? "" : String(group.policy.budget),
          (text) => {
            const parsed = parseBudget(text)
            if (parsed.error !== undefined) return refuse(parsed.error)
            patch("Failed to update budget", { budget: parsed.value ?? null })
          },
        ),
      )
      out.push(...delegationRows(group, policy, patch))
      out.push(heading("Work"))
      if (group.queue.length === 0) out.push(info("work:queue", "Nothing queued", undefined, "subdued"))
      group.queue.forEach((item) => {
        out.push(info(`queue:${item.id}`, item.title, queueReasonLabel(item.reason), undefined, undefined, true))
        if (item.selection) out.push(info(`queue:${item.id}:selection`, selectionLine(item.selection), undefined, "subdued", 2))
      })
      if (group.leases.length === 0) out.push(info("work:leases", "No active leases", undefined, "subdued"))
      group.leases.forEach((lease) => out.push(info(`lease:${lease.id}`, leaseLine(lease, now()))))
      if (group.receipts.length === 0) out.push(info("work:receipts", "No dispatches yet", undefined, "subdued"))
      group.receipts.slice(0, receiptLimit).forEach((receipt) => {
        out.push(info(`receipt:${receipt.id}`, receiptLine(receipt), relativeAge(now() - receipt.time), undefined, undefined, true))
        if (receipt.selection) out.push(info(`receipt:${receipt.id}:selection`, selectionLine(receipt.selection), undefined, "subdued", 2))
      })
      if (group.receipts.length > receiptLimit) out.push(info("work:more", `+${group.receipts.length - receiptLimit} more receipts`, undefined, "subdued"))
      return out
    }

    function delegationRows(
      group: CoordinationGroupView,
      policy: GlobalDelegationView | undefined,
      patch: (failure: string, change: Parameters<CoordinationService["updatePolicy"]>[1]) => void,
    ): Row[] {
      const current = group.policy.delegatedDecisions
      const summary = delegationSummary(current, policy)
      const out: Row[] = [
        {
          key: "delegation:mode",
          kind: "item",
          label: "Delegated decisions",
          value: summary,
          tone: policy?.enabled ? undefined : "warning",
          activate: () => {
            if (policy === undefined) return refuse("The global delegation policy is unavailable")
            if (!policy.enabled) return refuse("Delegated decisions are disabled by the global policy")
            patch("Failed to update delegated decisions", { delegatedDecisions: current ? null : { categories: policy.categories } })
          },
        },
      ]
      if (!policy?.enabled || !current) return out
      const change = (next: DelegatedDecisionsView) => {
        const error = narrowingError(next, policy)
        if (error) return refuse(error)
        patch("Failed to update delegated decisions", { delegatedDecisions: next })
      }
      delegatedCategories.forEach((category: DelegatedCategory) => {
        const allowed = policy.categories.includes(category)
        out.push({
          key: `delegation:${category}`,
          kind: "item",
          label: `Allow ${category}`,
          value: current.categories.includes(category) ? "on" : allowed ? "off" : "not allowed globally",
          indent: 2,
          activate: () =>
            change({
              ...current,
              categories: delegatedCategories.filter((item) => (item === category ? !current.categories.includes(item) : current.categories.includes(item))),
            }),
        })
      })
      const listRow = (field: "actions" | "resources", label: string): Row => ({
        key: `delegation:${field}`,
        kind: "item",
        label,
        value: current[field]?.join(", ") ?? "any",
        indent: 2,
        edit: {
          initial: current[field]?.join(", ") ?? "",
          commit: (text) => {
            const parsed = parseList(text, field)
            if (parsed.error !== undefined) return refuse(parsed.error)
            const { [field]: _removed, ...rest } = current
            change(parsed.value === undefined ? rest : { ...rest, [field]: parsed.value })
          },
        },
      })
      out.push(listRow("actions", "Actions"), listRow("resources", "Resources"), {
        key: "delegation:expires",
        kind: "item",
        label: "Expires",
        value: current.expiresAt === undefined ? "never" : relativeFuture(current.expiresAt - now()),
        indent: 2,
        edit: {
          initial: "",
          commit: (text) => {
            const parsed = parseExpiry(text, now())
            if (parsed.error !== undefined) return refuse(parsed.error)
            const { expiresAt: _removed, ...rest } = current
            change(parsed.value === undefined ? rest : { ...rest, expiresAt: parsed.value })
          },
        },
      })
      out.push(info("delegation:note", "Narrow only", "cannot widen the global policy", "subdued", 2))
      return out
    }

    function notificationRows(
      choices: ReturnType<typeof coordinatorChoices>,
      current: NotificationFilter,
      groups: CoordinationGroupView[] | undefined,
    ): Row[] {
      const withheld = current.scope === "coordinators" && groups === undefined ? " — delivery withheld" : ""
      const categories = current.categories === undefined ? {} : { categories: current.categories }
      const cycle = (direction: 1 | -1) => {
        const next = scopes[(scopes.indexOf(current.scope) + direction + scopes.length) % scopes.length]!
        props.onFilterChange(next === "selected" ? { scope: next, sessionIDs: current.sessionIDs ?? [], ...categories } : { scope: next, ...categories })
      }
      const out: Row[] = [
        { key: "heading:Notifications", kind: "heading", label: "Notifications" },
        {
          key: "notify:scope",
          kind: "item",
          label: "External scope",
          value: `${notificationFilterLabel(current, choices)}${withheld}`,
          step: cycle,
          activate: () => cycle(1),
        },
      ]
      ;(choices ?? []).forEach((choice) =>
        out.push({
          key: `notify:coordinator:${choice.sessionID}`,
          kind: "item",
          label: `Coordinator: ${choice.title}`,
          value: current.scope === "selected" && current.sessionIDs?.includes(choice.sessionID) ? "selected" : "off",
          indent: 2,
          activate: () => props.onFilterChange(toggleCoordinator(current, choice.sessionID)),
        }),
      )
      externalNotificationKinds.forEach((kind) =>
        out.push({
          key: `notify:category:${kind}`,
          kind: "item",
          label: `Category: ${kind}`,
          value: current.categories === undefined || current.categories.includes(kind) ? "on" : "off",
          indent: 2,
          activate: () => props.onFilterChange(toggleCategory(current, kind)),
        }),
      )
      return out
    }
  })

  const selectable = createMemo(() => rows().filter((row) => row.kind === "item"))
  const cursor = createMemo(() => selectable().find((row) => row.key === cursorKey()) ?? selectable()[Math.min(lastIndex(), selectable().length - 1)])

  function moveTo(index: number) {
    const target = selectable()[Math.max(0, Math.min(index, selectable().length - 1))]
    if (!target) return
    setCursorKey(target.key)
    setLastIndex(selectable().indexOf(target))
    requestAnimationFrame(reveal)
  }
  const move = (delta: number) => moveTo(selectable().indexOf(cursor()!) + delta)

  function reveal() {
    if (!scroll || scroll.isDestroyed || !cursor()) return
    const index = rows().findIndex((row) => row.key === cursor()!.key)
    const line = index + rows().slice(0, index).filter((row) => row.kind === "heading").length + 1
    const top = scroll.scrollTop
    const height = Math.max(1, scroll.viewport.height)
    if (line < top) scroll.scrollTo(line)
    else if (line >= top + height) scroll.scrollTo(line - height + 1)
  }

  function startEdit(row: Row) {
    if (!row.edit || busy()) return
    setEditing({ key: row.key, draft: row.edit.initial })
  }

  function activate(row: Row | undefined) {
    if (row?.edit) return startEdit(row)
    row?.activate?.()
  }

  function commit() {
    const current = editing()
    const row = rows().find((item) => item.key === current?.key)
    setEditing(undefined)
    if (current && row?.edit) row.edit.commit(current.draft)
  }

  const cancel = () => setEditing(undefined)
  const back = () => {
    if (creating()) return setCreating(undefined)
    props.onBack?.()
  }
  const refresh = () => props.onRefresh?.()

  Keymap.createLayer(() => ({
    mode: "base",
    enabled: editing() === undefined,
    commands: [
      { id: "projects.back", title: "Back", group: "Projects", bind: "escape", run: back },
      { id: "projects.refresh", title: "Refresh projects", group: "Projects", bind: "r", run: refresh },
      { id: "projects.up", title: "Previous row", group: "Projects", bind: "up", run: () => move(-1) },
      { id: "projects.down", title: "Next row", group: "Projects", bind: "down", run: () => move(1) },
      { id: "projects.home", title: "First row", group: "Projects", bind: "home", run: () => moveTo(0) },
      { id: "projects.end", title: "Last row", group: "Projects", bind: "end", run: () => moveTo(selectable().length - 1) },
      { id: "projects.page-up", title: "Rows up", group: "Projects", bind: "pageup", run: () => move(-10) },
      { id: "projects.page-down", title: "Rows down", group: "Projects", bind: "pagedown", run: () => move(10) },
      { id: "projects.activate", title: "Edit, toggle, or run the row", group: "Projects", bind: "return", run: () => activate(cursor()) },
      { id: "projects.previous", title: "Previous choice", group: "Projects", bind: "left", run: () => cursor()?.step?.(-1) },
      { id: "projects.next", title: "Next choice", group: "Projects", bind: "right", run: () => cursor()?.step?.(1) },
    ],
    bindings: ["projects.back", "projects.refresh"],
  }))

  const labelWidth = () => Math.max(14, Math.min(28, Math.floor(dimensions().width * 0.32)))
  const contentWidth = () => Math.max(20, dimensions().width - 6)
  const toneColor = (tone: Tone | undefined) =>
    tone === "success"
      ? theme.text.feedback.success.default
      : tone === "warning"
        ? theme.text.feedback.warning.default
        : tone === "error"
          ? theme.text.feedback.error.default
          : tone === "subdued"
            ? theme.text.subdued
            : theme.text.default

  function RowView(input: { row: Row }) {
    const row = () => input.row
    const active = () => cursor()?.key === row().key
    const column = () => (row().fit ? Math.min(stringWidth(row().label) + (row().indent ?? 0), contentWidth() - 2 - stringWidth(row().value ?? "") - 1) : labelWidth())
    const labelText = () => {
      const indent = " ".repeat(row().indent ?? 0)
      const width = row().value === undefined && row().kind !== "heading" ? contentWidth() - 2 : column()
      const text = Locale.truncateWidth(`${indent}${row().label}`, width)
      return text + " ".repeat(Math.max(0, column() - stringWidth(text)))
    }
    const valueText = () => Locale.truncateWidth(row().value ?? "", Math.max(1, contentWidth() - 2 - column() - 1))
    return (
      <Show
        when={row().kind !== "heading"}
        fallback={
          <box marginTop={1} height={1} flexShrink={0}>
            <text fg={theme.text.subdued} attributes={TextAttributes.BOLD}>{row().label}</text>
          </box>
        }
      >
        <box
          flexDirection="row"
          height={1}
          flexShrink={0}
          onMouseUp={() => {
            if (row().kind !== "item") return
            setCursorKey(row().key)
            setLastIndex(selectable().findIndex((item) => item.key === row().key))
            activate(row())
          }}
        >
          <text flexShrink={0} fg={active() ? theme.text.feedback.info.default : theme.text.subdued}>{active() ? "▸ " : "  "}</text>
          <text
            flexShrink={0}
            fg={active() ? theme.text.default : theme.text.subdued}
            attributes={active() ? TextAttributes.BOLD : undefined}
          >
            {labelText()}
          </text>
          <Show
            when={editing()?.key === row().key}
            fallback={<text fg={toneColor(row().tone)}>{" " + valueText()}</text>}
          >
            <input
              ref={(value: InputRenderable) => {
                setTimeout(() => {
                  if (value.isDestroyed) return
                  value.focus()
                  value.gotoLineEnd()
                }, 1)
              }}
              value={editing()?.draft ?? ""}
              onInput={(text: string) => setEditing((current) => (current ? { ...current, draft: text } : current))}
              onSubmit={commit}
              onKeyDown={(event: { name: string; preventDefault(): void }) => {
                if (event.name !== "escape") return
                event.preventDefault()
                cancel()
              }}
              flexGrow={1}
              focusedBackgroundColor="transparent"
              focusedTextColor={theme.text.default}
              cursorColor={theme.text.feedback.info.default}
            />
          </Show>
        </box>
      </Show>
    )
  }

  const hint = () =>
    editing() ? "enter save · esc cancel" : "↑↓ move · enter edit or run · ←→ change · esc back"

  return (
    <box width={dimensions().width} height={dimensions().height} flexDirection="column" backgroundColor={theme.background.default}>
      <box height={3} flexShrink={0} alignItems="center" flexDirection="row" paddingLeft={3} paddingRight={3} backgroundColor={theme.background.chrome}>
        <BrandMark width={2} height={1} />
        <text> Projects</text>
        <box flexGrow={1} />
        <box flexDirection="row" gap={2}>
          <text fg={theme.text.feedback.info.default} onMouseUp={refresh}>
            {refreshShortcut() ? `${refreshShortcut()} ` : ""}refresh
          </text>
          <text fg={theme.text.feedback.info.default} onMouseUp={back}>
            {backShortcut() ? `${backShortcut()} ` : ""}back
          </text>
        </box>
      </box>
      <scrollbox
        ref={(value: ScrollBoxRenderable) => {
          scroll = value
        }}
        flexGrow={1}
        minHeight={0}
        paddingLeft={3}
        paddingRight={3}
        horizontalScrollbarOptions={{ visible: false }}
        verticalScrollbarOptions={{ trackOptions: { backgroundColor: theme.background.default, foregroundColor: theme.scrollbar.default } }}
      >
        <Index each={rows()}>{(row) => <RowView row={row()} />}</Index>
      </scrollbox>
      <box height={1} flexShrink={0} paddingLeft={3} paddingRight={3} backgroundColor={theme.background.chrome}>
        <text fg={theme.text.subdued}>{Locale.truncateWidth(hint(), contentWidth())}</text>
      </box>
    </box>
  )
}
