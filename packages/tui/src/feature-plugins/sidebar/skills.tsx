import { Plugin } from "@ycoding-ai/plugin/tui"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { useClient } from "../../context/client"
import { Keymap } from "../../context/keymap"
import { useTheme } from "../../context/theme"
import { RailSection } from "../../routes/session/rail-section"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { getGlyph } from "../../ui/glyph"
import { useToast } from "../../ui/toast"
import { sessionSkillLabel, type SessionSkill } from "../../util/session-skills"

const RESOLVE_SKILL_CONFLICT_COMMAND = "session.skill_conflict.resolve"

type SkillConflict = {
  winner: SessionSkill
  loser: SessionSkill
}

export function SkillsRailContent(props: {
  skills: ReadonlyArray<SessionSkill>
  sessionID?: string
  refetch?: () => unknown
}) {
  const { themeV2 } = useTheme()
  const active = createMemo(() => props.skills.filter((skill) => skill.state === "active").length)
  const conflicts = createMemo(() => skillConflicts(props.skills))
  const summary = createMemo(
    () => `${active()} active${conflicts().length > 0 ? `, ${conflicts().length} conflict${conflicts().length === 1 ? "" : "s"}` : ""}`,
  )
  return (
    <Show when={props.skills.length > 0}>
      <RailSection section="skills" title="SKILLS" summary={summary()} attention={conflicts().length > 0}>
        <Show when={conflicts().length > 0}>
          <text wrapMode="none">
            <span style={{ fg: themeV2.text.feedback.error.default }}>{getGlyph("failed").glyph} </span>
            <span style={{ fg: themeV2.text.default }}>
              {conflicts().length} conflict{conflicts().length === 1 ? "" : "s"}
            </span>
            <span style={{ fg: themeV2.text.separator }}> {"\u00b7"} </span>
            <Show when={props.sessionID && props.refetch}>
              <SkillConflictControls
                conflicts={conflicts}
                sessionID={props.sessionID!}
                refetch={props.refetch!}
              />
            </Show>
          </text>
        </Show>
        <For each={props.skills}>
          {(skill) => (
            <text fg={skill.conflicts.length ? themeV2.text.feedback.warning.default : themeV2.text.subdued}>
              {skill.name} {sessionSkillLabel(skill)}
            </text>
          )}
        </For>
      </RailSection>
    </Show>
  )
}

function SkillConflictControls(props: {
  conflicts: () => SkillConflict[]
  sessionID: string
  refetch: () => unknown
}) {
  const dialog = useDialog()
  const { themeV2 } = useTheme()
  const shortcut = Keymap.useShortcut(RESOLVE_SKILL_CONFLICT_COMMAND)

  Keymap.createLayer(() => ({
    commands: [
      {
        id: RESOLVE_SKILL_CONFLICT_COMMAND,
        title: "Resolve skill conflict",
        group: "Session",
        enabled: () => props.conflicts().length > 0,
        run: () => {
          const conflict = props.conflicts()[0]
          if (!conflict) return
          dialog.replace(() => (
            <SkillConflictDialog conflict={conflict} sessionID={props.sessionID} refetch={props.refetch} />
          ))
        },
      },
    ],
  }))

  return (
    <Show when={shortcut()}>
      {(value) => <span style={{ fg: themeV2.text.label }}>{value().replaceAll("ctrl+", "\u2303")}</span>}
    </Show>
  )
}

function SkillConflictDialog(props: {
  conflict: SkillConflict
  sessionID: string
  refetch: () => unknown
}) {
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()
  const [resolving, setResolving] = createSignal(false)

  const resolve = (winner: SessionSkill) => {
    if (resolving()) return
    setResolving(true)
    const loser = winner.id === props.conflict.winner.id ? props.conflict.loser : props.conflict.winner
    void client.api.session.resolveSkillConflict({ sessionID: props.sessionID, winner: winner.id, loser: loser.id }).then(
      () => refresh(),
      (error) => {
        if (isSkillConflictNotFound(error)) {
          toast.show({ message: "Skill conflict was already resolved", variant: "info" })
          refresh()
          return
        }
        setResolving(false)
        toast.error(error)
      },
    )
  }

  const refresh = () => {
    dialog.clear()
    void props.refetch()
  }

  return (
    <DialogSelect
      title="Choose a skill to keep"
      options={[props.conflict.winner, props.conflict.loser].map((skill) => ({
        title: skill.name,
        description: skill.id,
        value: skill,
      }))}
      renderFilter={false}
      locked={resolving()}
      onSelect={(option) => resolve(option.value)}
    />
  )
}

function View(props: { context: Plugin.Context; sessionID: string }) {
  const [skills, { refetch }] = createResource(() => props.sessionID, (sessionID) => props.context.client.session.skills({ sessionID }))
  return <SkillsRailContent skills={skills() ?? []} sessionID={props.sessionID} refetch={refetch} />
}

export default Plugin.define({
  id: "internal:sidebar-skills",
  setup(context) {
    context.ui.slot("sidebar.content", (props) => <View context={context} sessionID={props.sessionID} />)
  },
})

function skillConflicts(skills: ReadonlyArray<SessionSkill>): SkillConflict[] {
  const active = new Map(skills.filter((skill) => skill.state === "active").map((skill) => [skill.id, skill]))
  return skills.flatMap((winner) => {
    if (winner.state !== "active") return []
    return winner.conflicts.flatMap((conflict) => {
      if (conflict.type !== "skill") return []
      const loser = active.get(conflict.id)
      if (!loser) return []
      return [{ winner, loser }]
    })
  })
}

function isSkillConflictNotFound(error: unknown): error is { _tag: "SkillConflictNotFoundError" } {
  return typeof error === "object" && error !== null && "_tag" in error && error._tag === "SkillConflictNotFoundError"
}
