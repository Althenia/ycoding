import { Plugin } from "@ycoding-ai/plugin/tui"
import { createEffect, createMemo, For, Show } from "solid-js"
import { useData } from "../../context/data"
import { useRoute } from "../../context/route"
import { useTheme } from "../../context/theme"
import { RailRow, RailSection } from "../../routes/session/rail-section"
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
  const waiting = createMemo(() => ordered().filter((task) => task.question?.text))
  const summary = createMemo(() => {
    if (waiting().length) return `${waiting().length} awaiting input`
    return ordered().length ? `${ordered().length} subagents` : undefined
  })

  return <SubagentRailContent tasks={ordered().map((task) => ({ ...task, elapsed: formatDuration((Date.now() - task.time.created) / 1000) }))} summary={summary()} onSelect={(sessionID) => route.navigate({ type: "session", sessionID })} />
}

export function SubagentRailContent(props: {
  tasks: ReadonlyArray<{ sessionID: string; description: string; question?: { text: string }; elapsed?: string }>
  summary?: string
  onSelect?: (sessionID: string) => void
}) {
  const { themeV2 } = useTheme()
  const waiting = createMemo(() => props.tasks.filter((task) => task.question?.text))

  return (
    <Show when={props.tasks.length > 0}>
      <RailSection section="subagents" title="SUBAGENTS" summary={props.summary} attention={waiting().length > 0}>
        <For each={props.tasks}>
          {(task) => {
            const blocked = () => Boolean(task.question?.text)
            const glyph = () => getGlyph(blocked() ? "awaitingInput" : "subagent")
            return (
              <box onMouseUp={() => props.onSelect?.(task.sessionID)}>
                <RailRow
                  label={`${glyph().rendered}${task.description}`}
                  value={task.question?.text ?? task.elapsed ?? "running"}
                  valueColor={blocked() ? themeV2.text.feedback.warning.default : themeV2.text.feedback.info.default}
                />
              </box>
            )
          }}
        </For>
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
