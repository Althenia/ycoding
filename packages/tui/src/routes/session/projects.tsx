import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, Show, type Accessor } from "solid-js"
import { BrandMark } from "../../component/logo"
import { Keymap } from "../../context/keymap"
import { useCoordination } from "../../context/coordination"
import { useRoute, useRouteData } from "../../context/route"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogAlert } from "../../ui/dialog-alert"
import { useDialog } from "../../ui/dialog"
import { errorMessage } from "../../util/error"
import { Locale } from "../../util/locale"
import {
  concurrencyMeter,
  delegatedCategories,
  delegationSummary,
  externalNotificationKinds,
  liveSummary,
  masterChoices,
  narrowingError,
  notificationFilterLabel,
  parseConcurrency,
  parseExpiry,
  parseList,
  projectStatusLabel,
  recentDirectories,
  roster,
  toggleCategory,
  toggleMaster,
  updatedLabel,
  type DelegatedDecisionsView,
  type GlobalDelegationView,
  type NotificationFilter,
  type ProjectView,
  type ProjectService,
  type ProjectSessionChoice,
} from "../../util/coordination"
import { createRowList, Panel, type Row } from "./project-rows"
import { ProjectMembers, ProjectMeter, ProjectState, useProjectClock } from "./project-members"

export function ProjectsScreen() {
  const route = useRouteData("projects")
  const router = useRoute()
  const coordination = useCoordination()
  const now = useProjectClock()
  return (
    <ProjectsScreenContent
      projects={coordination.projects}
      error={coordination.error}
      sessions={coordination.sessions}
      service={coordination.service}
      filter={coordination.filter}
      globalDelegation={coordination.globalDelegation}
      loadedAt={coordination.loadedAt}
      now={now}
      initialSettings={route.projectID}
      onFilterChange={(filter) => coordination.setFilter(filter)}
      onRefresh={() => void coordination.refresh()}
      onOpen={(sessionID) => router.navigate({ type: "session", sessionID })}
      onBack={() =>
        router.navigate(route.sessionID ? { type: "session", sessionID: route.sessionID } : { type: "home" })
      }
    />
  )
}

const sections = ["General", "Members", "Delegation", "Notifications"] as const

export function ProjectsScreenContent(props: {
  projects: Accessor<readonly ProjectView[] | undefined>
  error?: Accessor<string | undefined>
  sessions: Accessor<readonly ProjectSessionChoice[]>
  service: ProjectService
  filter: Accessor<NotificationFilter>
  globalDelegation: Accessor<GlobalDelegationView | undefined>
  onFilterChange: (filter: NotificationFilter) => void | Promise<void>
  now?: Accessor<number>
  loadedAt?: Accessor<number | undefined>
  initialSettings?: string
  onOpen: (sessionID: string) => void
  onBack?: () => void
  onRefresh?: () => void
}) {
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const config = useConfig()
  const dialog = useDialog()
  const [cursor, setCursor] = createSignal(0)
  const [view, setView] = createSignal<"list" | "new" | "settings">(props.initialSettings ? "settings" : "list")
  const [section, setSection] = createSignal(0)
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [name, setName] = createSignal("")
  const [source, setSource] = createSignal<"existing" | "new">("existing")
  const [masterID, setMasterID] = createSignal<string>()
  const [search, setSearch] = createSignal("")
  const [directory, setDirectory] = createSignal("")
  const [title, setTitle] = createSignal("")
  const now = () => props.now?.() ?? Date.now()
  const project = () =>
    props.projects()?.find((item) => item.id === props.initialSettings) ??
    props.projects()?.[Math.min(cursor(), (props.projects()?.length ?? 1) - 1)]
  const wide = () => dimensions().width >= 120
  const formWidth = () => Math.max(20, dimensions().width - (dimensions().width >= 100 ? 40 : 6))
  const run = async (action: string, call: () => Promise<unknown>, done?: () => void) => {
    if (busy()) return
    setBusy(true)
    setFailure(undefined)
    try {
      await call()
      done?.()
    } catch (error) {
      setFailure(`Failed to ${action}: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }
  const startNew = () => {
    setView("new")
    setName("")
    setMasterID(undefined)
    setSource("existing")
    setDirectory("")
    setTitle("")
    setSearch("")
    setFailure(undefined)
    queueMicrotask(() => {
      form.focusKey("name")
      form.activate(form.cursor())
    })
  }
  const back = () => {
    if (form.editing()) return form.cancel()
    if (view() !== "list") {
      setView("list")
      setFailure(undefined)
      return
    }
    props.onBack?.()
  }
  const create = () => {
    if (!name().trim()) {
      setFailure("Project name is required")
      form.focusKey("name")
      return
    }
    if (source() === "existing" && !masterID()) {
      setFailure("Choose a master Session")
      return
    }
    if (source() === "new" && !directory().trim()) {
      setFailure("Choose a directory")
      form.focusKey("directory")
      return
    }
    const master =
      source() === "existing"
        ? { sessionID: masterID()! }
        : { directory: directory().trim(), ...(title().trim() ? { title: title().trim() } : {}) }
    void run("create project", async () => {
      const id = await props.service.create({ name: name().trim(), master })
      props.onOpen(id)
    })
  }
  const removeProject = () => {
    const selected = project()
    if (!selected || cursor() >= (props.projects()?.length ?? 0)) return
    dialog.replace(() => (
      <DialogConfirm
        title={`Delete ${selected.name}?`}
        label="Delete"
        message="The Sessions keep running and keep their histories."
        onConfirm={() => void run("delete project", () => props.service.deleteProject(selected.id))}
      />
    ))
  }
  const editRow = (key: string, label: string, value: string, commit: (text: string) => void): Row => ({
    key,
    label,
    value,
    marker: "✎",
    kind: "item",
    edit: { initial: value, commit },
  })
  const info = (key: string, label: string, value?: string): Row => ({ key, label, value, kind: "info" })
  const updateDelegation = (next: DelegatedDecisionsView) => {
    const current = project(),
      global = props.globalDelegation()
    if (!current || !global) return
    const error = narrowingError(next, global)
    if (error) return setFailure(error)
    void run("update delegation", () => props.service.setDelegation(current.id, next))
  }
  const changeFilter = (filter: NotificationFilter) =>
    void run("save notifications", async () => {
      await props.onFilterChange(filter)
    })
  const formRows = createMemo<Row[]>(() => {
    if (view() === "new")
      return [
        editRow("name", "Name", name(), (value) => {
          setName(value)
          form.focusKey("source")
        }),
        info("name:help", "required · shown in Projects and chat headers"),
        {
          key: "source",
          kind: "item",
          label: "Master source",
          value: source() === "existing" ? "‹ existing Session ›" : "‹ new Session in a directory ›",
          step: () => setSource((current) => (current === "existing" ? "new" : "existing")),
          activate: () => setSource((current) => (current === "existing" ? "new" : "existing")),
        },
        ...(source() === "existing"
          ? [
              editRow("find", "Find", search(), setSearch),
              ...props
                .sessions()
                .filter((session) => session.title.toLowerCase().includes(search().toLowerCase()))
                .map(
                  (session): Row => ({
                    key: session.sessionID,
                    kind: "item",
                    label: session.title,
                    value: session.projectName
                      ? `in ${session.projectName}`
                      : `${masterID() === session.sessionID ? "● " : ""}${session.directory}`,
                    marker: "›",
                    tone: session.projectName ? "subdued" : undefined,
                    activate: () => {
                      if (!session.projectName) setMasterID(session.sessionID)
                    },
                  }),
                ),
            ]
          : [
              {
                ...editRow("directory", "Directory", directory(), setDirectory),
                step: (direction: 1 | -1) => {
                  const recents = recentDirectories(props.sessions())
                  setDirectory(
                    recents[(recents.indexOf(directory()) + direction + recents.length) % recents.length] ?? "",
                  )
                },
              },
              editRow("title", "Title", title(), setTitle),
              info("title:help", "optional; defaults to the Project name"),
            ]),
        {
          key: "create",
          kind: "item",
          label: "Create project",
          shortcut: { key: "c", available: !busy() },
          activate: create,
        },
        { key: "cancel", kind: "item", label: "Cancel", shortcut: { key: "esc", available: true }, activate: back },
      ]
    const current = project()
    if (!current) return []
    if (section() === 0)
      return [
        editRow("name", "Name", current.name, (text) => {
          if (!text.trim()) return setFailure("Project name is required")
          void run("rename project", () => props.service.rename(current.id, text.trim()))
        }),
        {
          key: "master",
          kind: "item",
          label: "Master",
          value: `‹ ${current.master.title} › MASTER`,
          step: (direction) => {
            const candidates = roster(current)
            const next = candidates[(direction + candidates.length) % candidates.length]
            if (next && next.sessionID !== current.master.sessionID)
              void run("change master", () => props.service.setMaster(current.id, next.sessionID))
          },
        },
        info("master:help", `Choosing another master moves ${current.master.title} to the members.`),
        editRow(
          "concurrency",
          "Concurrency",
          current.concurrency === null ? "no limit" : String(current.concurrency),
          (text) => {
            const parsed = parseConcurrency(text)
            if (parsed.error) return setFailure(parsed.error)
            void run("update concurrency", () => props.service.setConcurrency(current.id, parsed.value!))
          },
        ),
        info("concurrency:help", "whole number ≥ 1, or no limit"),
        info(
          "status",
          "Status",
          `${projectStatusLabel(current.active)}${current.pausedReason ? (current.pausedReason === "restart" ? " · after restart" : " · interrupted") : ""}`,
        ),
        info("running", "Running now", concurrencyMeter(current)),
        info(
          "created",
          "Created",
          new Date(current.created).toLocaleDateString("en", { month: "short", day: "numeric" }),
        ),
        info("save:help", "Edits save on Enter. Status and Running now are read-only."),
      ]
    if (section() === 2) {
      const global = props.globalDelegation(),
        value = current.delegatedDecisions
      const result: Row[] = [
        {
          key: "delegation:mode",
          kind: "item",
          label: "Delegated decisions",
          value: delegationSummary(value, global),
          activate: () => {
            if (!global?.enabled)
              return setFailure(
                global
                  ? "Delegated decisions are disabled by the global policy"
                  : "The global delegation policy is unavailable",
              )
            void run("update delegation", () =>
              props.service.setDelegation(current.id, value ? null : { categories: global.categories }),
            )
          },
        },
      ]
      if (!global?.enabled || !value) return result
      for (const category of delegatedCategories)
        result.push({
          key: `allow:${category}`,
          kind: "item",
          label: `Allow ${category}`,
          value: global.categories.includes(category)
            ? value.categories.includes(category)
              ? "on"
              : "off"
            : "not allowed globally",
          activate: () =>
            updateDelegation({
              ...value,
              categories: delegatedCategories.filter((item) =>
                item === category ? !value.categories.includes(item) : value.categories.includes(item),
              ),
            }),
        })
      for (const field of ["actions", "resources"] as const)
        result.push(
          editRow(field, field === "actions" ? "Actions" : "Resources", value[field]?.join(", ") ?? "", (text) => {
            const parsed = parseList(text, field)
            if (parsed.error) return setFailure(parsed.error)
            const { [field]: _removed, ...rest } = value
            updateDelegation(parsed.value ? { ...rest, [field]: parsed.value } : rest)
          }),
        )
      result.push(
        editRow("expiry", "Expires", "", (text) => {
          const parsed = parseExpiry(text, now())
          if (parsed.error) return setFailure(parsed.error)
          const { expiresAt: _expiresAt, ...rest } = value
          updateDelegation(parsed.value === undefined ? rest : { ...rest, expiresAt: parsed.value })
        }),
      )
      result.push(info("narrow", "Narrows only; never widens the global policy"))
      return result
    }
    if (section() === 3) {
      const value = props.filter(),
        scopes = ["all", "coordinators", "selected"] as const
      const cycle = (direction: 1 | -1) =>
        changeFilter({ ...value, scope: scopes[(scopes.indexOf(value.scope) + direction + 3) % 3]! })
      return [
        {
          key: "scope",
          kind: "item",
          label: "External scope",
          value: notificationFilterLabel(value, masterChoices(props.projects())),
          step: cycle,
          activate: () => cycle(1),
        },
        ...(masterChoices(props.projects()) ?? []).map(
          (master): Row => ({
            key: master.sessionID,
            kind: "item",
            label: `Master: ${master.title}`,
            value: value.scope === "selected" && value.sessionIDs?.includes(master.sessionID) ? "selected" : "off",
            activate: () => changeFilter(toggleMaster(value, master.sessionID)),
          }),
        ),
        ...externalNotificationKinds.map(
          (category): Row => ({
            key: category,
            kind: "item",
            label: `Category: ${category}`,
            value: value.categories === undefined || value.categories.includes(category) ? "on" : "off",
            activate: () => changeFilter(toggleCategory(value, category)),
          }),
        ),
      ]
    }
    return []
  })
  const form = createRowList({
    rows: formRows,
    active: () => view() !== "list",
    labelWidth: () => (view() === "new" ? 20 : 24),
    contentWidth: () => formWidth() - 4,
    busy,
  })
  const openSelected = () =>
    cursor() >= (props.projects()?.length ?? 0) ? startNew() : project() && props.onOpen(project()!.master.sessionID)
  const help = () =>
    dialog.replace(() => (
      <DialogAlert
        title="Project keys"
        message={
          view() === "list"
            ? "↑↓ project · enter open master chat · n new project\nD delete project · r refresh · ? keys · esc back"
            : view() === "new"
              ? "↑↓ field · ←→ master source · enter pick / edit\nc create · esc cancel"
              : "↑↓ field · enter edit · ←→ change choice\nspace toggle · tab section · esc back"
        }
      />
    ))
  Keymap.createLayer(() => ({
    enabled: !form.editing() && !(view() === "settings" && section() === 1),
    commands: [
      {
        bind: "up",
        title: "Previous row",
        run: () => {
          if (view() === "list") setCursor((value) => Math.max(0, value - 1))
          else form.move(-1)
        },
      },
      {
        bind: "down",
        title: "Next row",
        run: () => {
          if (view() === "list") setCursor((value) => Math.min(props.projects()?.length ?? 0, value + 1))
          else form.move(1)
        },
      },
      {
        bind: "home",
        title: "First row",
        run: () => {
          if (view() === "list") setCursor(0)
          else form.moveTo(0)
        },
      },
      {
        bind: "end",
        title: "Last row",
        run: () => {
          if (view() === "list") setCursor(props.projects()?.length ?? 0)
          else form.moveTo(form.selectable().length - 1)
        },
      },
      {
        bind: "return",
        title: "Open or edit",
        run: () => (view() === "list" ? openSelected() : form.activate(form.cursor())),
      },
      { bind: "space", title: "Toggle", run: () => form.activate(form.cursor()) },
      { bind: "left", title: "Previous choice", run: () => form.cursor()?.step?.(-1) },
      { bind: "right", title: "Next choice", run: () => form.cursor()?.step?.(1) },
      { bind: "n", title: "New project", enabled: view() === "list", run: startNew },
      { bind: "c", title: "Create project", enabled: view() === "new", run: create },
      { bind: "shift+d", title: "Delete project", enabled: view() === "list", run: removeProject },
      { bind: "r", title: "Refresh Projects", enabled: view() === "list", run: () => props.onRefresh?.() },
      {
        bind: "s",
        title: "Project settings",
        enabled: view() === "list" && !!project(),
        run: () => {
          setView("settings")
        },
      },
      { bind: "escape", title: "Back", run: back },
      { bind: "?", title: "Project keys", run: help },
    ],
  }))
  Keymap.createLayer(() => ({
    enabled: view() === "settings" && !form.editing(),
    priority: 5,
    commands: [
      {
        bind: "tab",
        title: "Next section",
        run: () => {
          setSection((value) => (value + 1) % 4)
          form.moveTo(0)
        },
      },
      {
        bind: "shift+tab",
        title: "Previous section",
        run: () => {
          setSection((value) => (value + 3) % 4)
          form.moveTo(0)
        },
      },
    ],
  }))
  const hint = () =>
    form.editing()
      ? view() === "new" && form.cursor()?.key === "name"
        ? "enter next field · esc cancel"
        : `editing ${form.cursor()?.label} · enter save · esc cancel`
      : view() === "list"
        ? "↑↓ project · enter open master chat · n new project · D delete · r refresh · ? keys · esc back"
        : view() === "new"
          ? "↑↓ field · ←→ master source · enter pick / edit · c create · esc cancel"
          : "↑↓ field · enter edit · ←→ change choice · space toggle · tab section · ? keys · esc back"
  function List() {
    return (
      <Panel title={`PROJECTS ${props.projects()?.length ?? 0}`} active={view() === "list"} flexGrow={1}>
        <text fg={theme.text.subdued} height={1} wrapMode="none" truncate>
          {view() !== "list"
            ? "PROJECT                   MEMBERS"
            : "PROJECT              STATUS    MASTER      MEMBERS LIVE"}
        </text>
        <scrollbox flexGrow={1} minHeight={0}>
          <Show when={props.error?.()}>
            <text fg={theme.text.feedback.error.default}>{props.error?.()}</text>
            <text onMouseUp={props.onRefresh}>[r] Retry</text>
          </Show>
          <Show when={!props.error?.() && props.projects() === undefined}>
            <text>Loading projects…</text>
          </Show>
          <Show when={props.projects()?.length === 0}>
            <text>No projects</text>
          </Show>
          <For each={props.projects()}>
            {(item, index) => (
              <box
                height={1}
                flexDirection="row"
                flexShrink={0}
                backgroundColor={cursor() === index() ? theme.background.action.primary.focused : undefined}
                onMouseUp={() => {
                  setCursor(index())
                  props.onOpen(item.master.sessionID)
                }}
              >
                <text
                  fg={cursor() === index() ? theme.text.action.primary.focused : theme.text.default}
                  wrapMode="none"
                  truncate
                  flexGrow={1}
                  minWidth={0}
                >
                  {cursor() === index() ? "▸ " : "  "}
                  {view() !== "list"
                    ? `${Locale.truncateWidth(item.name, 22).padEnd(22)} ${roster(item).length}`
                    : `${Locale.truncateWidth(item.name, 16).padEnd(16)} ${projectStatusLabel(item.active).padEnd(9)} ${Locale.truncateWidth(item.master.title, 8).padEnd(8)} ${String(roster(item).length).padEnd(3)} ${liveSummary(item, config.data.animations !== false)} ›`}
                </text>
                <Show when={view() === "list" && cursor() === index()}>
                  <text
                    flexShrink={0}
                    fg={theme.text.action.primary.focused}
                    onMouseUp={(event) => {
                      event.stopPropagation()
                      removeProject()
                    }}
                  >
                    {" "}
                    [D] Delete
                  </text>
                </Show>
              </box>
            )}
          </For>
          <box
            height={1}
            flexShrink={0}
            marginTop={1}
            backgroundColor={
              cursor() === (props.projects()?.length ?? 0) ? theme.background.action.primary.focused : undefined
            }
            onMouseUp={startNew}
          >
            <text fg={theme.text.feedback.info.default}>
              {cursor() === (props.projects()?.length ?? 0) ? "▸ " : "  "}[n] + New project
            </text>
          </box>
        </scrollbox>
        <Show when={view() === "list" && project()}>
          <box flexDirection="row" gap={2}>
            <text fg={theme.text.feedback.info.default} onMouseUp={openSelected}>
              [Enter] Open master
            </text>
            <text fg={theme.text.feedback.info.default} onMouseUp={removeProject}>
              [D] Delete
            </text>
            <text fg={theme.text.feedback.info.default} onMouseUp={() => setView("settings")}>
              [s] Settings
            </text>
          </box>
        </Show>
      </Panel>
    )
  }
  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={theme.background.default}>
      <box height={3} flexShrink={0} alignItems="center" flexDirection="row" paddingLeft={3} paddingRight={3}>
        <BrandMark width={2} height={1} />
        <text>
          {" "}
          Projects
          {view() === "new" ? " › New project" : view() === "settings" ? ` › ${project()?.name ?? ""} › Settings` : ""}
        </text>
        <box flexGrow={1} />
        <Show when={view() !== "new" && dimensions().width >= 120}>
          <text fg={theme.text.subdued}>
            {updatedLabel(props.loadedAt?.() === undefined ? undefined : now() - props.loadedAt!()!)}
          </text>
        </Show>
        <text onMouseUp={back}> esc {view() === "new" ? "cancel" : "back"}</text>
      </box>
      <box flexGrow={1} minHeight={0} paddingLeft={3} paddingRight={3} gap={2}>
        <Show when={view() === "list"}>
          <box flexDirection="row" flexGrow={1} minHeight={0} gap={2}>
            <box flexGrow={1} minHeight={0} gap={1}>
              <List />
              <Panel title="LEGEND" height={7}>
                <text>LIVE ● running ○ idle ? waiting on you ✗ failed</text>
                <text>STATUS ● active ○ paused</text>
                <text>[k] action · (k) unavailable · › opens · ✎ editable</text>
                <text>▸ filled band = cursor · ● = this Session</text>
              </Panel>
            </box>
            <Show when={wide() && project()}>
              {(selected) => (
                <Panel title={`${selected().name} · preview`} width={42}>
                  <text>{selected().name}</text>
                  <text>Master {selected().master.title}</text>
                  <text wrapMode="none" truncate>
                    {selected().master.directory}
                  </text>
                  <text>Status {projectStatusLabel(selected().active)}</text>
                  <ProjectMeter project={selected()} />
                  <text> </text>
                  <text>MEMBERS {roster(selected()).length}</text>
                  <For each={roster(selected())}>
                    {(member) => (
                      <box marginTop={1}>
                        <box flexDirection="row" gap={1}>
                          <text>
                            {member.role === "master" ? "MASTER" : "MEMBER"} {member.title}
                          </text>
                          <ProjectState state={member.state} word />
                        </box>
                        <Show when={member.drivenBy}>
                          <text fg={theme.text.subdued}>↳ driven by {member.drivenBy}</text>
                        </Show>
                      </box>
                    )}
                  </For>
                  <box flexGrow={1} />
                  <text fg={theme.text.feedback.info.default} onMouseUp={openSelected}>
                    [Enter] Open master chat
                  </text>
                </Panel>
              )}
            </Show>
          </box>
        </Show>
        <Show when={view() !== "list"}>
          <box flexDirection="row" flexGrow={1} minHeight={0} gap={2}>
            <Show when={dimensions().width >= 100}>
              <box width={32}>
                <Show
                  when={view() === "new"}
                  fallback={
                    <Panel title="SECTIONS" width={32} height={9}>
                      <For each={sections}>
                        {(label, index) => (
                          <box
                            height={1}
                            backgroundColor={
                              section() === index() ? theme.background.action.primary.focused : undefined
                            }
                            onMouseUp={() => setSection(index())}
                          >
                            <text>
                              {section() === index() ? "▸ " : "  "}
                              {label}
                            </text>
                          </box>
                        )}
                      </For>
                      <text>tab switch section</text>
                    </Panel>
                  }
                >
                  <List />
                </Show>
              </box>
            </Show>
            <Panel title={view() === "new" ? "NEW PROJECT" : sections[section()]!.toUpperCase()} active flexGrow={1}>
              <Show when={view() === "settings" && section() === 1 && project()} fallback={<form.Rows />}>
                {(current) => (
                  <ProjectMembers
                    project={current()}
                    focused
                    currentSessionID={undefined}
                    onFocus={() => {}}
                    onBack={back}
                    onOpen={props.onOpen}
                    service={props.service}
                    sessions={props.sessions}
                    now={now}
                    loadedAt={() => props.loadedAt?.()}
                    compact
                    settings
                  />
                )}
              </Show>
            </Panel>
          </box>
          <Show when={view() === "settings" && project()}>
            {(current) => (
              <Panel title="OTHER SECTIONS" height={8}>
                <text>
                  Members MASTER {current().master.title} ·{" "}
                  {current()
                    .members.map((member) => member.title)
                    .join(", ")}
                </text>
                <text> [a] Add [n] New session [x] Remove [D] Delete</text>
                <text>Delegation {delegationSummary(current().delegatedDecisions, props.globalDelegation())}</text>
                <text>Notifications {notificationFilterLabel(props.filter(), masterChoices(props.projects()))}</text>
                <text> question · permission · review · failure · completion</text>
              </Panel>
            )}
          </Show>
        </Show>
        <Show when={busy()}>
          <text>Saving…</text>
        </Show>
        <Show when={failure()}>
          <text fg={theme.text.feedback.error.default}>{failure()}</text>
        </Show>
      </box>
      <box height={1} flexShrink={0} paddingLeft={3}>
        <text fg={theme.text.subdued} wrapMode="none" truncate>
          {hint()}
        </text>
      </box>
    </box>
  )
}
