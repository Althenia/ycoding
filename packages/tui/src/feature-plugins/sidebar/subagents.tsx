import type { SessionOrchestrationSummary, SessionOrchestrationTask } from "@ycoding-ai/client"
import { Plugin } from "@ycoding-ai/plugin/tui"
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { RailRow, RailSection, useRail } from "../../routes/session/rail-section"
import { getGlyph } from "../../ui/glyph"
import { Locale } from "../../util/locale"
import { isActiveSubagent } from "../../util/subagent"
import { formatSubagentElapsed } from "../../util/time"

export function SubagentRail(props: { sessionID: string }) {
  const route = useRoute()
  const data = useData()
  createEffect(() => void data.session.subagent.sync(props.sessionID))
  const page = createMemo(() => data.session.subagent.page(props.sessionID))
  const navigation = createMemo(() => data.session.subagent.navigation(props.sessionID))
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    const tasks = page()?.data ?? []
    if (!tasks.some((task) => isActiveSubagent(task.state))) return
    const interval = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(interval))
  })

  return (
    <SubagentRailContent
      tasks={page()?.data ?? []}
      summary={page()?.summary}
      position={navigation().position}
      now={now()}
      onSelect={(sessionID) => route.navigate({ type: "session", sessionID })}
      onLoadOlder={() => void data.session.subagent.loadOlder(props.sessionID)}
      onLoadNewer={() => void data.session.subagent.loadNewer(props.sessionID)}
    />
  )
}

export function SubagentRailContent(props: {
  tasks: ReadonlyArray<Pick<SessionOrchestrationTask, "sessionID" | "description" | "state" | "question"> & { elapsed?: string }>
  summary?: SessionOrchestrationSummary
  position?: "top" | "older"
  now?: number
  onSelect?: (sessionID: string) => void
  onLoadOlder?: () => void
  onLoadNewer?: () => void
}) {
  const { themeV2 } = useTheme()
  const rail = useRail()
  const waiting = createMemo(() => props.summary?.waiting ?? props.tasks.filter((task) => task.question?.text?.trim()).length)
  const summary = createMemo(
    () =>
      `${props.summary?.running ?? props.tasks.filter((task) => task.state === "running").length}/${props.summary?.total ?? props.tasks.length} running${
        waiting() ? ` · ${waiting()} waiting` : ""
      }`,
  )
  const more = createMemo(() => (props.position === "top" ? Math.max(0, (props.summary?.total ?? props.tasks.length) - props.tasks.length) : 0))

  return (
    <Show when={props.tasks.length > 0 || (props.summary?.total ?? 0) > 0}>
      <RailSection section="subagents" title="SUBAGENTS" summary={summary()} attention={waiting() > 0}>
        <For each={props.tasks}>
          {(task, index) => {
            const blocked = () => Boolean(task.question?.text?.trim())
            const glyph = () => getGlyph(blocked() ? "awaitingInput" : "subagent")
            const label = () => {
              const raw = `${glyph().glyph ?? ""} ${String(task.description ?? "").trim()}`.trim() || task.sessionID.slice(0, 8)
              return Locale.truncate(raw, 80)
            }
            const value = () => {
              const q = task.question?.text?.trim()
              if (q) return Locale.truncate(q, 60)
              const elapsed = (task as { elapsed?: string }).elapsed ?? formatSubagentElapsed(task as SessionOrchestrationTask, props.now ?? Date.now())
              return Locale.truncate(String(elapsed ?? "running").trim() || "running", 60)
            }
            return (
              <box width="100%" flexDirection="column" flexShrink={0}>
                <box width="100%" onMouseUp={() => props.onSelect?.(task.sessionID)}>
                  <RailRow
                    label={label()}
                    value={value()}
                    valueColor={blocked() ? themeV2.text.feedback.warning.default : themeV2.text.feedback.info.default}
                  />
                </box>
                <Show when={rail?.allExpanded() && index() < props.tasks.length - 1}>
                  <box height={1} flexShrink={0} />
                </Show>
              </box>
            )
          }}
        </For>
        <Show when={more() > 0}>
          <box onMouseUp={() => props.onLoadOlder?.()}>
            <RailRow label={`+${more()} more`} value="older" />
          </box>
        </Show>
        <Show when={props.position === "older" && props.onLoadNewer}>
          <box onMouseUp={() => props.onLoadNewer?.()}>
            <RailRow label="newer" value="top" />
          </box>
        </Show>
      </RailSection>
    </Show>
  )
}

export default Plugin.define({
  id: "internal:sidebar-subagents",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => <SubagentRail sessionID={props.sessionID} />)
  },
})
