import { createEffect, createMemo, For, on, Show } from "solid-js"
import type { SessionOrchestrationTask } from "@ycoding-ai/client"
import { useRoute, useRouteData } from "../../context/route"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { Locale } from "../../util/locale"
import { formatDiagnosticsModel } from "../../util/cache-diagnostics"
import { Keymap } from "../../context/keymap"
import { subagentSiblingSessionIDs, subagentSiblingEconomics } from "./subagent-footer"

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
  const siblingEconomics = createMemo(() =>
    Object.fromEntries(siblings().map((task) => [task.sessionID, subagentSiblingEconomics(data.session.get(task.sessionID))])),
  )
  const currentTask = createMemo(() => siblings().find((task) => task.sessionID === route.sessionID))
  const blocked = createMemo(() => currentTask()?.state === "waiting" && !!currentTask()?.question)
  const { themeV2 } = useTheme().contextual("elevated")
  const keymap = Keymap.use()

  return (
    <Show when={siblings().length > 0}>
      <box flexShrink={0} flexGrow={0}>
        <Show when={parent()}>
          {(parentInfo) => (
            <box
              height={1}
              paddingLeft={2}
              paddingRight={1}
              flexDirection="row"
              alignItems="center"
              onMouseUp={() => keymap.dispatch("session.parent")}
            >
              <text fg={themeV2.text.subdued} wrapMode="none">
                ↑ {parentInfo().title}
              </text>
            </box>
          )}
        </Show>
        <For each={siblings()}>
          {(task) => {
            const attached = () => task.sessionID === route.sessionID
            const question = () => task.question?.text
            const isBlocked = () => task.state === "waiting" && !!question()
            return (
              <box
                height={1}
                paddingLeft={2}
                paddingRight={1}
                flexDirection="row"
                alignItems="center"
                backgroundColor={
                  attached()
                    ? isBlocked()
                      ? themeV2.background.feedback.warning.default
                      : themeV2.background.action.primary.focused
                    : themeV2.background.default
                }
                onMouseUp={() => navigation.navigate({ type: "session", sessionID: task.sessionID })}
              >
                <Show when={attached() && isBlocked()}>
                  <text fg={themeV2.text.feedback.warning.default} wrapMode="none">
                    {"\u25CF "}
                  </text>
                </Show>
                <Show when={question()}>
                  <text fg={themeV2.text.feedback.warning.default} wrapMode="none">
                    ?{" "}
                  </text>
                </Show>
                <text
                  fg={
                    attached()
                      ? isBlocked()
                        ? themeV2.text.feedback.warning.default
                        : themeV2.text.action.primary.focused
                      : themeV2.text.default
                  }
                  wrapMode="none"
                >
                  ◦ {Locale.titlecase(task.agent)}
                  <Show when={siblingEconomics()?.[task.sessionID]}>
                    {(economics) => <span style={{ fg: themeV2.text.subdued }}> {economics()}</span>}
                  </Show>
                  <Show when={formatDiagnosticsModel(task.model)}>
                    {(model) => <span style={{ fg: themeV2.text.subdued }}> · {model()}</span>}
                  </Show>
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}