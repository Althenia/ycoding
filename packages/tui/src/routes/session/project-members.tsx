import { createMemo, createSignal, For, onCleanup, Show, type Accessor } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core"
import { useConfig } from "../../config"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { useTuiPaths } from "../../context/runtime"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { DialogAlert } from "../../ui/dialog-alert"
import { useDialog } from "../../ui/dialog"
import { getGlyph } from "../../ui/glyph"
import { SplitBorder } from "../../ui/border"
import { SPINNER_FRAMES } from "../../component/spinner-frames"
import { progressBar } from "../../util/provider-usage"
import { Locale } from "../../util/locale"
import { stringWidth } from "../../util/string-width"
import { errorMessage } from "../../util/error"
import {
  ageLabel,
  concurrencyMeter,
  recentDirectories,
  ProjectCreationError,
  roster,
  stateGlyph,
  updatedLabel,
  type MemberState,
  type ProjectView,
  type ProjectService,
  type ProjectSessionChoice,
} from "../../util/coordination"
import { readableTint } from "../../theme/component"
import { createRowList, infoInk, quietInk, type Row } from "./project-rows"
import { SessionPickerDetail, sessionPickerRows } from "./project-session-picker"

export function useProjectClock() {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 5000)
  onCleanup(() => clearInterval(timer))
  return now
}

type Theme = ReturnType<typeof useTheme>["theme"]

function stateInk(theme: Theme, state: MemberState) {
  return state === "running"
    ? theme.text.feedback.success.default
    : state === "waiting"
      ? theme.text.feedback.warning.default
      : state === "failed"
        ? theme.text.feedback.error.default
        : theme.text.subdued
}

export function memberStateColor(theme: Theme, state: MemberState, selected = false) {
  return selected ? theme.text.action.primary.focused : readableTint(stateInk(theme, state), theme.background.default)
}

export function projectActiveColor(theme: Theme, active: boolean, selected = false) {
  return selected
    ? theme.text.action.primary.focused
    : readableTint(active ? theme.text.feedback.success.default : theme.text.subdued, theme.background.default)
}

export function ProjectState(props: { state: MemberState; word?: boolean; selected?: boolean }) {
  const config = useConfig()
  const { theme } = useTheme()
  const color = () => memberStateColor(theme, props.state, props.selected)
  return (
    <box flexDirection="row" flexShrink={0}>
      <Show
        when={props.state === "running" && config.data.animations !== false}
        fallback={
          <text fg={color()}>
            {props.state === "waiting" ? getGlyph("awaitingInput").glyph : stateGlyph(props.state, false)}
          </text>
        }
      >
        <spinner frames={SPINNER_FRAMES} interval={80} color={color()} />
      </Show>
      <Show when={props.word}>
        <text fg={color()}> {props.state}</text>
      </Show>
    </box>
  )
}

export function ProjectMeter(props: { project: ProjectView; wrap?: boolean }) {
  const { theme } = useTheme()
  const value = () => concurrencyMeter(props.project)
  const bar = () =>
    props.project.concurrency === null
      ? undefined
      : progressBar(
          (props.project.members.filter((member) => member.state === "running").length / props.project.concurrency) *
            100,
          Math.min(props.project.concurrency, 8),
        )
  return (
    <text fg={quietInk(theme)} wrapMode={props.wrap ? "word" : "none"} truncate={!props.wrap}>
      {bar() ? `${bar()} ${value().split(" ").slice(1).join(" ")}` : value()}
    </text>
  )
}

const ROLE_CELLS = 17
const OPEN_CELLS = 9

export function ProjectMembers(props: {
  project: ProjectView
  currentSessionID?: string
  focused: boolean
  onFocus: () => void
  onBack: () => void
  onOpen: (sessionID: string) => void
  onSettings?: () => void
  sessions: Accessor<readonly ProjectSessionChoice[]>
  service: ProjectService
  now: Accessor<number>
  loadedAt: Accessor<number | undefined>
  compact?: boolean
  settings?: boolean
  keymapMode?: string
  tab?: boolean
  initialMode?: "members" | "add"
}) {
  const dimensions = useTerminalDimensions()
  const paths = useTuiPaths()
  const { theme } = useTheme()
  const dialog = useDialog()
  const [index, setIndex] = createSignal(
    Math.max(
      0,
      roster(props.project).findIndex((member) => member.sessionID === props.currentSessionID),
    ),
  )
  const [mode, setMode] = createSignal<"members" | "add" | "new">(props.initialMode ?? "members")
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<string>()
  const [recovery, setRecovery] = createSignal<ProjectCreationError>()
  const [search, setSearch] = createSignal("")
  const [directory, setDirectory] = createSignal("")
  const [title, setTitle] = createSignal("")
  let memberScroll: ScrollBoxRenderable | undefined
  let pane: BoxRenderable | undefined
  const members = () => roster(props.project)
  const current = () => members()[Math.min(index(), members().length - 1)]!
  const moveMember = (next: number) => {
    setIndex(Math.max(0, Math.min(members().length - 1, next)))
    requestAnimationFrame(() => {
      const scroll = memberScroll
      if (!scroll || scroll.isDestroyed) return
      const child = scroll.getChildren()[index()]
      if (!child) return
      const top = child.y - scroll.viewport.y + scroll.scrollTop
      if (top < scroll.scrollTop) scroll.scrollTo(top)
      else if (top + child.height > scroll.scrollTop + scroll.viewport.height)
        scroll.scrollTo(top + child.height - scroll.viewport.height)
    })
  }
  const canRemove = () => current()?.role === "member"
  const inlineActions = () => props.tab === true && dimensions().width >= 70
  const width = () => (props.compact || props.settings ? dimensions().width - (props.settings ? 34 : 0) : 32)
  const [measured, setMeasured] = createSignal(0)
  const inner = () => Math.max(20, (measured() || width()) - 2 - (props.compact || props.settings ? 0 : 1))
  const lead = (member: { sessionID: string }) => 2 + (member.sessionID === props.currentSessionID ? 2 : 0)
  const ageText = (member: { lastActivity: number }) => ageLabel(props.now() - member.lastActivity)
  const showPath = () => !props.compact || (measured() || width()) >= 80
  const pathNeed = () =>
    Math.max(...members().map((member) => 2 + stringWidth(path(member.directory)) + 3 + stringWidth(ageText(member))))
  const titleNeed = () => Math.max(...members().map((member) => lead(member) + stringWidth(member.title))) + 2
  const spare = () => inner() - ROLE_CELLS - OPEN_CELLS
  const titleCells = () => {
    if (!props.compact) return inner() - OPEN_CELLS
    if (!showPath() || titleNeed() + pathNeed() <= spare()) return Math.min(titleNeed(), Math.max(14, spare()))
    return Math.min(titleNeed(), Math.max(20, Math.floor(spare() * 0.55)))
  }
  const pathCells = () => (props.compact ? Math.max(14, spare() - titleCells()) : inner())
  const path = (value: string) => (value.startsWith(paths.home + "/") ? "~" + value.slice(paths.home.length) : value)
  const run = async (name: string, call: () => Promise<unknown>, done?: () => void) => {
    if (busy()) return
    setBusy(true)
    setFailure(undefined)
    try {
      await call()
      done?.()
    } catch (error) {
      if (error instanceof ProjectCreationError) {
        setRecovery(error)
        return
      }
      setFailure(`Failed to ${name}: ${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }
  const add = () => {
    if (busy()) return
    setMode("add")
    setSearch("")
    setFailure(undefined)
    queueMicrotask(() => form.focusKey("find"))
  }
  const newSession = () => {
    if (busy()) return
    setMode("new")
    if (recovery()) return
    setDirectory("")
    setTitle("")
    setFailure(undefined)
    queueMicrotask(() => form.activate(form.selectable()[0]))
  }
  const remove = (deleting: boolean) => {
    if (!canRemove() || busy()) return
    const member = current()
    dialog.replace(() => (
      <DialogConfirm
        title={deleting ? `Delete ${member.title}?` : `Remove ${member.title} from ${props.project.name}?`}
        label={deleting ? "Delete" : "Remove"}
        message={
          deleting
            ? "This deletes the Session and its history. It cannot be undone."
            : "The Session keeps running and keeps its history."
        }
        onConfirm={() =>
          void run(
            deleting ? "delete Session" : "remove Session",
            () =>
              deleting
                ? props.service.deleteMember(props.project.id, member.sessionID)
                : props.service.removeMember(props.project.id, member.sessionID),
            () => {
              if (deleting && member.sessionID === props.currentSessionID) props.onOpen(props.project.master.sessionID)
            },
          )
        }
      />
    ))
  }
  const create = () => {
    if (recovery() && !recovery()!.sessionID) return
    if (!directory().trim()) {
      setFailure("Choose a directory")
      form.focusKey("directory")
      return
    }
    void run(
      "create Session",
      () => props.service.newMember(props.project.id, directory().trim(), title().trim() || undefined),
      () => {
        setRecovery(undefined)
        setMode("members")
      },
    )
  }
  const rows = createMemo<Row[]>(() =>
    mode() === "add"
      ? [
          ...sessionPickerRows({
            sessions: props.sessions(),
            query: search(),
            setQuery: setSearch,
            assigned: "hide",
            choose: (session) =>
              void run(
                "add Session",
                () => props.service.addMember(props.project.id, session.sessionID),
                () => setMode("members"),
              ),
          }),
          {
            key: "cancel",
            kind: "item",
            label: "Cancel",
            shortcut: { key: "esc", available: true },
            activate: () => setMode("members"),
          },
        ]
      : [
          {
            key: "directory",
            kind: "item",
            label: "Directory",
            value: directory() || "Enter to edit a path",
            disabled: recovery() !== undefined,
            marker: "✎",
            edit: { initial: directory(), commit: setDirectory },
            step: (direction) => {
              if (busy() || recovery()) return
              const recent = recentDirectories(props.sessions())
              const index = recent.indexOf(directory())
              setDirectory(recent[(index + direction + recent.length) % recent.length] ?? "")
            },
          },
          { key: "directory:help", kind: "info", label: "Enter to edit · ←/→ recent directories" },
          {
            key: "title",
            kind: "item",
            label: "Title",
            value: title() || "optional",
            marker: "✎",
            edit: { initial: title(), commit: setTitle },
            disabled: recovery() !== undefined,
          },
          {
            key: "create",
            kind: "item",
            label: recovery()?.sessionID ? "Retry attachment" : "Create Session",
            shortcut: { key: "c", available: !busy() && (!recovery() || !!recovery()!.sessionID) },
            activate: create,
          },
          {
            key: "cancel",
            kind: "item",
            label: "Cancel",
            shortcut: { key: "esc", available: true },
            activate: () => setMode("members"),
          },
        ],
  )
  const form = createRowList({
    mode: props.keymapMode,
    rows,
    active: () => props.focused,
    labelWidth: () => 12,
    contentWidth: () => inner() - 1,
    busy,
  })
  const help = () =>
    dialog.replace(() => (
      <DialogAlert
        title="Member keys"
        message={
          mode() === "members"
            ? "↑↓ member · o/enter open · a add · n new session\nx remove · D delete · s settings · esc chat"
            : "↑↓ field · enter pick / edit · ←→ recent directory\nc create · esc cancel"
        }
      />
    ))
  const back = () => (mode() === "members" ? props.onBack() : setMode("members"))
  const open = () => {
    if (current()) props.onOpen(current().sessionID)
  }
  const hint = () =>
    form.editing()
      ? "enter save · esc cancel"
      : mode() !== "members"
        ? "↑↓ field · enter pick / edit · c create · esc cancel"
        : `↑↓ member · o/enter open · a add · n new session${canRemove() ? " · x remove · D delete" : ""} · s settings · ? keys · esc chat`
  Keymap.createLayer(() => ({
    mode: props.keymapMode,
    enabled: props.focused && !form.editing(),
    priority: 3,
    commands: [
      {
        bind: "up",
        title: "Previous member",
        run: () => {
          if (mode() === "members") moveMember(index() - 1)
          else form.move(-1)
        },
      },
      {
        bind: "down",
        title: "Next member",
        run: () => {
          if (mode() === "members") moveMember(index() + 1)
          else form.move(1)
        },
      },
      {
        bind: "home",
        title: "First row",
        run: () => {
          if (mode() === "members") moveMember(0)
          else form.moveTo(0)
        },
      },
      {
        bind: "end",
        title: "Last row",
        run: () => {
          if (mode() === "members") moveMember(members().length - 1)
          else form.moveTo(form.selectable().length - 1)
        },
      },
      {
        bind: "return",
        title: "Open member",
        run: () => (mode() === "members" ? open() : form.activate(form.cursor())),
      },
      { bind: "left", title: "Previous choice", run: () => form.cursor()?.step?.(-1), enabled: mode() !== "members" },
      { bind: "right", title: "Next choice", run: () => form.cursor()?.step?.(1), enabled: mode() !== "members" },
      { bind: "o", title: "Open member", run: open, enabled: mode() === "members" },
      { bind: "a", title: "Add member", run: add, enabled: mode() === "members" },
      { bind: "n", title: "New Session", run: newSession, enabled: mode() === "members" },
      { bind: "x", title: "Remove member", run: () => remove(false), enabled: mode() === "members" },
      { bind: "shift+d", title: "Delete member", run: () => remove(true), enabled: mode() === "members" },
      {
        bind: "c",
        title: "Create Session",
        run: () => {
          create()
        },
        enabled: mode() === "new",
      },
      { bind: "s", title: "Project settings", run: () => props.onSettings?.(), enabled: mode() === "members" },
      {
        bind: "escape",
        title: "Back to chat",
        run: () => {
          back()
        },
      },
      { bind: "?", title: "Member keys", run: help },
    ],
  }))
  return (
    <box
      width={props.compact || props.settings ? "100%" : 32}
      height={props.compact && !props.settings ? undefined : "100%"}
      flexGrow={props.compact || props.settings ? 1 : undefined}
      flexBasis={props.compact ? 0 : undefined}
      minHeight={0}
      border={props.compact || props.settings ? [] : ["left"]}
      customBorderChars={SplitBorder.customBorderChars}
      borderColor={props.focused ? infoInk(theme) : theme.border.default}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={props.onFocus}
      ref={(value: BoxRenderable) => {
        pane = value
      }}
      onSizeChange={() => setMeasured(pane?.width ?? 0)}
    >
      <box flexDirection="row" flexShrink={0}>
        <text fg={props.focused ? infoInk(theme) : quietInk(theme)}>
          {props.focused ? "▸ " : "  "}
          {mode() === "members"
            ? `MEMBERS ${props.project.members.length} + MASTER`
            : mode() === "add"
              ? "ADD SESSION"
              : "NEW SESSION"}
        </text>
        <Show when={props.compact}>
          <box flexGrow={1} />
          <ProjectMeter project={props.project} />
        </Show>
      </box>
      <Show when={!props.compact}>
        <ProjectMeter project={props.project} wrap />
      </Show>
      <Show
        when={mode() === "members"}
        fallback={
          <>
            <form.Rows />
            <Show when={mode() === "add"}>
              <SessionPickerDetail
                session={() => props.sessions().find((session) => session.sessionID === form.cursor()?.key)}
              />
            </Show>
          </>
        }
      >
        <scrollbox
          scrollbarOptions={props.tab ? { visible: false } : undefined}
          ref={(value: ScrollBoxRenderable) => {
            memberScroll = value
          }}
          flexGrow={1}
          flexBasis={0}
          minHeight={0}
        >
          <For each={members()}>
            {(member, position) => (
              <box flexShrink={0} marginTop={props.compact ? 0 : 1}>
                <box
                  height={props.compact ? 1 : undefined}
                  flexShrink={0}
                  backgroundColor={index() === position() ? theme.background.action.primary.focused : undefined}
                  flexDirection={props.compact ? "row" : "column"}
                  onMouseUp={() => {
                    setIndex(position())
                    props.onOpen(member.sessionID)
                  }}
                >
                  <box flexDirection="row" flexShrink={0} width={props.compact ? titleCells() : undefined}>
                    <text
                      fg={index() === position() ? theme.text.action.primary.focused : theme.text.default}
                      wrapMode="none"
                      truncate
                    >
                      {index() === position() ? "▸ " : "  "}
                      {member.sessionID === props.currentSessionID ? "● " : ""}
                      {Locale.truncateWidth(member.title, titleCells() - lead(member) - (props.compact ? 2 : 1))}
                    </text>
                    <Show when={!props.compact && index() === position() && props.focused}>
                      <box flexGrow={1} />
                      <text fg={theme.text.action.primary.focused}>[o] Open</text>
                    </Show>
                  </box>
                  <box
                    flexDirection="row"
                    paddingLeft={props.compact ? 0 : 2}
                    gap={1}
                    width={props.compact ? ROLE_CELLS : undefined}
                    flexShrink={0}
                  >
                    <text fg={index() === position() ? theme.text.action.primary.focused : quietInk(theme)}>
                      {member.role === "master" ? "MASTER" : "MEMBER"}
                    </text>
                    <ProjectState state={member.state} word selected={index() === position()} />
                  </box>
                  <Show when={showPath()}>
                    <text
                      flexShrink={props.compact ? 1 : 0}
                      height={1}
                      paddingLeft={2}
                      fg={index() === position() ? theme.text.action.primary.focused : quietInk(theme)}
                      wrapMode="none"
                      truncate
                    >
                      {Locale.truncateLeft(
                        path(member.directory),
                        Math.max(8, pathCells() - 5 - stringWidth(ageText(member))),
                      )}{" "}
                      · {ageText(member)}
                    </text>
                  </Show>
                  <Show when={props.compact && index() === position() && props.focused}>
                    <box flexGrow={1} />
                    <text fg={theme.text.action.primary.focused}>[o] Open</text>
                  </Show>
                </box>
                <Show when={member.drivenBy}>
                  <text fg={quietInk(theme)} paddingLeft={2} wrapMode="none" truncate>
                    ↳ driven by {member.drivenBy}
                  </text>
                </Show>
              </box>
            )}
          </For>
        </scrollbox>
        <box
          flexShrink={0}
          border={props.tab ? [] : ["top"]}
          borderColor={theme.border.default}
          flexDirection={inlineActions() ? "row" : "column"}
          gap={inlineActions() ? 2 : 0}
        >
          <box flexDirection="row" gap={2} flexShrink={0}>
            <text selectable={false} fg={infoInk(theme)} onMouseUp={add}>
              [a] Add
            </text>
            <text selectable={false} fg={infoInk(theme)} onMouseUp={newSession}>
              [n] New session
            </text>
          </box>
          <box flexDirection="row" gap={2} flexShrink={0}>
            <text
              selectable={false}
              fg={canRemove() ? infoInk(theme) : quietInk(theme)}
              onMouseUp={() => remove(false)}
            >
              {canRemove() ? "[x]" : "(x)"} Remove
            </text>
            <text selectable={false} fg={canRemove() ? infoInk(theme) : quietInk(theme)} onMouseUp={() => remove(true)}>
              {canRemove() ? "[D]" : "(D)"} Delete
            </text>
          </box>
          <Show when={props.onSettings}>
            <text selectable={false} fg={infoInk(theme)} flexShrink={0} onMouseUp={props.onSettings}>
              [s] Settings
            </text>
          </Show>
          <Show when={!canRemove() && !props.tab}>
            <text fg={quietInk(theme)} height={1} wrapMode="none" truncate>
              master: change it in Settings
            </text>
          </Show>
        </box>
      </Show>
      <box flexShrink={0}>
        <Show when={busy()}>
          <text height={1} fg={quietInk(theme)}>
            Saving…
          </text>
        </Show>
        <Show when={failure()}>
          <text fg={theme.text.feedback.error.default}>{failure()}</text>
        </Show>
        <Show when={recovery()}>
          <text fg={theme.text.feedback.warning.default} wrapMode="word">
            {recovery()!.message}
          </text>
        </Show>
        <Show when={!props.tab && (props.compact || props.settings || dimensions().width >= 120)}>
          <text height={1} fg={quietInk(theme)}>
            {updatedLabel(props.loadedAt() === undefined ? undefined : props.now() - props.loadedAt()!)}
          </text>
        </Show>
        <Show when={props.focused && props.settings}>
          <text height={1} fg={quietInk(theme)} wrapMode="none" truncate>
            {hint()}
          </text>
        </Show>
      </box>
    </box>
  )
}
