import { createMemo, For, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { useRoute, useRouteData } from "../../context/route"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { Keymap } from "../../context/keymap"
import { stringWidth } from "../../util/string-width"
import { Locale } from "../../util/locale"

const SIBLING_GAP = 5
const PARENT_GAP = 11
const MIN_CHIP_WIDTH = 23

export type SubagentSwitcherItem = Pick<SessionOrchestrationTask, "sessionID" | "state" | "question"> & { label: string }

export function subagentSwitcherLayout(input: {
  width: number
  parentTitle?: string
  currentSessionID: string
  offset?: number
  total?: number
  siblings: ReadonlyArray<SubagentSwitcherItem>
}) {
  const localPosition = input.siblings.findIndex((task) => task.sessionID === input.currentSessionID) + 1
  const position = localPosition === 0 ? 0 : (input.offset ?? 0) + localPosition
  const current = input.siblings.find((task) => task.sessionID === input.currentSessionID)
  const siblings = current ? [current, ...input.siblings.filter((task) => task !== current)] : input.siblings
  const right = `${position} of ${input.total ?? input.siblings.length}  ·  ↑ parent  ← prev  → next`
  const siblingWidth = Math.max(0, input.width - stringWidth(right))
  const parentWidth = Math.min(
    stringWidth(input.parentTitle ? `↑ ${input.parentTitle}` : ""),
    Math.max(0, siblingWidth - PARENT_GAP - MIN_CHIP_WIDTH),
  )
  const chipWidth = Math.max(0, siblingWidth - parentWidth - PARENT_GAP)
  const visible: SubagentSwitcherItem[] = []
  // Accumulate the chips already admitted. Comparing each chip's own width against the budget
  // admitted every chip that fitted individually, so the row overran the reserved right block and
  // overprinted it.
  let used = 0
  for (const sibling of siblings) {
    const width = stringWidth(sibling.label) + (visible.length > 0 ? SIBLING_GAP : 0)
    if (used + width > chipWidth) break
    if (visible.length > 0 && used + width + overflowWidth(siblings.slice(visible.length + 1)) > chipWidth) break
    used += width
    visible.push(sibling)
  }
  const hidden = siblings.slice(visible.length)
  const overflow = hidden.length && used + overflowWidth(hidden) <= chipWidth ? overflowLabel(hidden) : undefined
  return {
    parentTitle: Locale.truncateWidth(input.parentTitle ?? "", Math.max(0, parentWidth - 2)),
    parentWidth,
    chipWidth,
    visible,
    overflow,
    right,
  }
}

function overflowWidth(siblings: ReadonlyArray<SubagentSwitcherItem>) {
  if (!siblings.length) return 0
  return stringWidth(overflowLabel(siblings)) + SIBLING_GAP
}

function overflowLabel(siblings: ReadonlyArray<Pick<SessionOrchestrationTask, "state" | "question">>) {
  return `${siblings.some((task) => task.state === "waiting" && !!task.question?.text) ? "? " : ""}+${siblings.length} more`
}

/**
 * Full-width sibling switcher rendered at the top of a child session's content area.
 * Shows each sibling as a row with the active child highlighted.
 */
export function SubagentSiblingSwitcher() {
  const route = useRouteData("session")
  const navigation = useRoute()
  const data = useData()
  const session = createMemo(() => data.session.get(route.sessionID))
  const parentID = createMemo(() => session()?.parentID)

  const page = createMemo(() => {
    const parent = parentID()
    return parent ? data.session.subagent.page(parent) : undefined
  })
  const siblings = createMemo(() => page()?.data ?? [])
  const parent = createMemo(() => (parentID() ? data.session.get(parentID()!) : undefined))
  const { themeV2 } = useTheme().contextual("elevated")
  const keymap = Keymap.use()
  const dimensions = useTerminalDimensions()
  const items = createMemo(() => {
    const labels = siblings().map((task) => subagentSwitcherLabel(task, data.session.get(task.sessionID)?.title))
    return siblings().map((task, index) => {
      const label = labels[index] ?? subagentSwitcherLabel(task)
      const duplicate = labels.filter((item) => item === label).length > 1
      return {
        ...task,
        label: duplicate ? `${label} #${labels.slice(0, index + 1).filter((item) => item === label).length}` : label,
      }
    })
  })
  const layout = createMemo(() =>
    subagentSwitcherLayout({
      // The row starts at content column 3 and reserves the canonical three-column right inset.
      width: Math.max(0, dimensions().width - 6),
      parentTitle: parent()?.title,
      currentSessionID: route.sessionID,
      offset: page()?.offset,
      total: page()?.summary.total,
      siblings: items(),
    }),
  )

  return (
    <Show when={siblings().length > 0}>
      <box
        width="100%"
        height={3}
        paddingTop={1}
        paddingLeft={1}
        paddingRight={1}
        flexDirection="row"
        alignItems="flex-start"
        flexShrink={0}
        flexGrow={0}
        backgroundColor={themeV2.background.surface.offset}
      >
        <Show when={parent()}>
          <box width={layout().parentWidth} height={1} flexShrink={0} onMouseUp={() => keymap.dispatch("session.parent")}>
            <text fg={themeV2.text.subdued} wrapMode="none" truncate>
              ↑ {layout().parentTitle}
            </text>
          </box>
        </Show>
        <box width={11} flexShrink={0} />
        <box width={layout().chipWidth} flexDirection="row" gap={SIBLING_GAP} flexShrink={0}>
          <For each={layout().visible}>
            {(task) => {
              const attached = () => task.sessionID === route.sessionID
              const isBlocked = () => task.state === "waiting" && !!task.question?.text
              return (
                <box
                  height={1}
                  onMouseUp={() => navigation.navigate({ type: "session", sessionID: task.sessionID })}
                >
                <text
                  fg={
                      isBlocked()
                        ? themeV2.text.feedback.warning.default
                        : attached()
                          ? themeV2.text.feedback.info.default
                          : themeV2.text.subdued
                  }
                  wrapMode="none"
                >
                    {task.label}
                </text>
                </box>
              )
            }}
          </For>
          <Show when={layout().overflow}>
            {(label) => (
              <text fg={label().startsWith("?") ? themeV2.text.feedback.warning.default : themeV2.text.subdued} wrapMode="none">
                {label()}
              </text>
            )}
          </Show>
        </box>
        <text fg={themeV2.text.hint} wrapMode="none" flexShrink={0}>
          {layout().right}
        </text>
      </box>
    </Show>
  )
}

export function subagentSwitcherLabel(
  task: Pick<SessionOrchestrationTask, "agent" | "state" | "question">,
  identity?: string,
) {
  // Board 15 chips carry the short sibling identity (`◦ docs-sync`), not the child's title, which is
  // a full task description and would swamp the row. The title is only a fallback.
  return `${task.state === "waiting" && task.question?.text ? "?" : "◦"} ${task.agent || identity || ""}`.trimEnd()
}
