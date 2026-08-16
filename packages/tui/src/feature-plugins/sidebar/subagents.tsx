import type { SessionOrchestrationSummary, SessionOrchestrationTask } from "@ycoding-ai/client"
import { Plugin } from "@ycoding-ai/plugin/tui"
import { createEffect, createMemo, For, Show } from "solid-js"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { RailRow, RailSection, useRail } from "../../routes/session/rail-section"
import { getGlyph } from "../../ui/glyph"
import { formatSubagentElapsed } from "../../util/time"

export function SubagentRail(props: { sessionID: string }) {
  const route = useRoute()
  const data = useData()
  createEffect(() => void data.session.subagent.sync(props.sessionID))
  const page = createMemo(() => data.session.subagent.page(props.sessionID))
  const navigation = createMemo(() => data.session.subagent.navigation(props.sessionID))

  return (
    <SubagentRailContent
      tasks={(page()?.data ?? []).map((task) => ({
        ...task,
        elapsed: formatSubagentElapsed(task),
      }))}
      summary={page()?.summary}
      position={navigation().position}
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
  onSelect?: (sessionID: string) => void
  onLoadOlder?: () => void
  onLoadNewer?: () => void
}) {
  const { themeV2 } = useTheme()
  const rail = useRail()
  const waiting = createMemo(() => props.summary?.waiting ?? props.tasks.filter((task) => task.question?.text).length)
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
            const blocked = () => Boolean(task.question?.text)
            const glyph = () => getGlyph(blocked() ? "awaitingInput" : "subagent")
            return (
              <>
                <box onMouseUp={() => props.onSelect?.(task.sessionID)}>
                  <RailRow
                    label={`${glyph().glyph} ${task.description}`}
                    value={task.question?.text ?? task.elapsed ?? "running"}
                    valueColor={blocked() ? themeV2.text.feedback.warning.default : themeV2.text.feedback.info.default}
                  />
                </box>
                <Show when={rail?.allExpanded() && index() < props.tasks.length - 1}>
                  <box height={1} flexShrink={0} />
                </Show>
              </>
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
