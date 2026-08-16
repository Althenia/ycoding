import { Plugin } from "@ycoding-ai/plugin/tui"
import { createEffect, createMemo, For, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { RailRow, RailSection } from "../../routes/session/rail-section"
import { groupSessionShells, type SessionShellGroup } from "../../util/session"

type ShellRailGroup = Pick<SessionShellGroup, "owner"> & { shells: ReadonlyArray<{ id?: string; status?: string }> }

export function ShellRailContent(props: { groups: ReadonlyArray<ShellRailGroup>; terminalCount: number }) {
  const { themeV2 } = useTheme()
  const running = createMemo(() =>
    props.groups.reduce(
      (total, group) => total + group.shells.filter((shell) => shell.status === undefined || shell.status === "running").length,
      0,
    ),
  )
  const orphaned = createMemo(() =>
    props.groups
      .filter((group) => group.owner.label === "Unknown session")
      .reduce((total, group) => total + group.shells.length, 0),
  )
  const summary = createMemo(() =>
    [
      `${running()} running`,
      ...(props.terminalCount > 0 ? [`${props.terminalCount} terminal`] : []),
    ].join(", "),
  )

  return (
    <Show when={running() > 0 || props.terminalCount > 0}>
      <RailSection section="shells" title="SHELLS" summary={summary()} attention={orphaned() > 0}>
        <For each={props.groups}>
          {(group) => (
            <RailRow
              label={
                group.owner.label === "Unknown session"
                  ? `${group.owner.label} ${group.shells.length}`
                  : group.owner.label
              }
              value={group.owner.label === "Unknown session" ? "orphaned" : String(group.shells.length)}
              valueColor={
                group.owner.label === "Unknown session"
                  ? themeV2.text.feedback.warning.default
                  : group.owner.label === "Main chat"
                    ? themeV2.text.default
                    : themeV2.text.feedback.info.default
              }
            />
          )}
        </For>
      </RailSection>
    </Show>
  )
}

function View(props: { context: Plugin.Context; sessionID: string }) {
  const session = createMemo(() => props.context.data.session.get(props.sessionID))
  const shells = createMemo(() => props.context.data.shell.list(session()?.location))
  const groups = createMemo(() => {
    const sessions = props.context.data.session.list()
    const terminalOrphans = shells().filter((shell) => {
      if (shell.status === "running") return false
      const sessionID = shell.metadata.sessionID
      return typeof sessionID !== "string" || !sessions.some((session) => session.id === sessionID)
    })
    const visible = groupSessionShells(shells(), sessions, props.sessionID)
    const unknown = visible.find((group) => group.owner.label === "Unknown session")

    if (!terminalOrphans.length) return visible
    if (!unknown) return [...visible, { owner: { label: "Unknown session" }, shells: terminalOrphans }]
    return visible.map((group) =>
      group === unknown ? { ...group, shells: [...group.shells, ...terminalOrphans] } : group,
    )
  })
  const terminalCount = createMemo(() => shells().filter((shell) => shell.status !== "running").length)

  createEffect(() => void props.context.data.shell.sync(session()?.location))

  return <ShellRailContent groups={groups()} terminalCount={terminalCount()} />
}

export default Plugin.define({
  id: "internal:sidebar-shells",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => (
      <Show when={!props.shellSurface}>
        <View context={context} sessionID={props.sessionID} />
      </Show>
    ))
    context.ui.slot("sidebar.shells", (props) => (
      <Show when={props.shellSurface}>
        <View context={context} sessionID={props.sessionID} />
      </Show>
    ))
  },
})
