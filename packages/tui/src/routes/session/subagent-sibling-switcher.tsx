import { createEffect, createMemo, For, Show } from "solid-js"
import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { useRoute, useRouteData } from "../../context/route"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { Keymap } from "../../context/keymap"
import { subagentSiblingSessionIDs } from "./subagent-footer"

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

  createEffect(() => {
    const id = parentID()
    if (!id) return
    void data.session.subagent.sync(id).catch(() => undefined)
  })

  const siblings = createMemo(() => {
    const parent = parentID()
    if (!parent) return []
    const tasks = data.session.subagent.list(parent)
    return subagentSiblingSessionIDs(tasks).flatMap((id) => tasks.find((task) => task.sessionID === id) ?? [])
  })
  const parent = createMemo(() => (parentID() ? data.session.get(parentID()!) : undefined))
  const currentTask = createMemo(() => siblings().find((task) => task.sessionID === route.sessionID))
  const blocked = createMemo(() => currentTask()?.state === "waiting" && !!currentTask()?.question)
  const { themeV2 } = useTheme().contextual("elevated")
  const keymap = Keymap.use()

  return (
    <Show when={siblings().length > 0}>
      <box
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
          {(parentInfo) => (
            <box height={1} onMouseUp={() => keymap.dispatch("session.parent")}>
              <text fg={themeV2.text.subdued} wrapMode="none">
                ↑ {parentInfo().title}
              </text>
            </box>
          )}
        </Show>
        <box width={11} flexShrink={0} />
        <box flexDirection="row" gap={5} flexShrink={0}>
          <For each={siblings()}>
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
                    {subagentSwitcherLabel(task)}
                </text>
                </box>
              )
            }}
          </For>
        </box>
        <Show when={!blocked()}>
          <box flexGrow={1} />
          <text fg={themeV2.text.hint} wrapMode="none">
            {siblings().findIndex((task) => task.sessionID === route.sessionID) + 1} of {siblings().length}
            {"  ·  ↑ parent  ← prev  → next"}
          </text>
        </Show>
      </box>
    </Show>
  )
}

export function subagentSwitcherLabel(
  task: Pick<SessionOrchestrationTask, "agent" | "state" | "question">,
) {
  return `${task.state === "waiting" && task.question?.text ? "?" : "◦"} ${task.agent}`
}
