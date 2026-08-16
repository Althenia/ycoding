import { Plugin } from "@ycoding-ai/plugin/tui"
import { createEffect, createMemo, For, Show } from "solid-js"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { RailRow, RailSection, useRail } from "../../routes/session/rail-section"
import { getGlyph } from "../../ui/glyph"
import { subagentSiblingSessionIDs } from "../../routes/session/subagent-footer"
import { formatDuration } from "../../util/format"

export function SubagentRail(props: { sessionID: string }) {
  const route = useRoute()
  const data = useData()
  createEffect(() => void data.session.subagent.sync(props.sessionID))
  const tasks = createMemo(() => data.session.subagent.list(props.sessionID))
  const ordered = createMemo(() => {
    const ids = subagentSiblingSessionIDs(tasks())
    return ids.flatMap((id) => tasks().find((task) => task.sessionID === id) ?? [])
  })

  return <SubagentRailContent tasks={ordered().map((task) => ({ ...task, elapsed: formatDuration((Date.now() - task.time.created) / 1000) }))} onSelect={(sessionID) => route.navigate({ type: "session", sessionID })} />
}

export function SubagentRailContent(props: {
  tasks: ReadonlyArray<{ sessionID: string; description: string; question?: { text: string }; elapsed?: string }>
  onSelect?: (sessionID: string) => void
}) {
  const { themeV2 } = useTheme()
  const rail = useRail()
  const waiting = createMemo(() => props.tasks.filter((task) => task.question?.text))
  const summary = createMemo(() => String(props.tasks.length))

  return (
    <Show when={props.tasks.length > 0}>
      <RailSection section="subagents" title="SUBAGENTS" summary={summary()} attention={waiting().length > 0}>
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
        <Show when={rail?.allExpanded()}>
          <box height={2} flexShrink={0} />
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
