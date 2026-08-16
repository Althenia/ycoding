import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid"
import { Global } from "@ycoding-ai/core/global"
import { createMemo, createResource, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { useClient } from "../context/client"
import { useDialog } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useConfig } from "../config"
import { useTuiPaths } from "../context/runtime"
import { errorMessage } from "../util/error"
import { getScrollAcceleration } from "../util/scroll"
import {
  filterSessionSkills,
  groupSessionSkills,
  sessionSkillContent,
  sessionSkillLabel,
  sessionSkillScope,
  type SessionSkill,
} from "../util/session-skills"

export type DialogSessionSkillsProps = {
  sessionID: string
  location?: { directory: string; workspaceID?: string }
}

export function DialogSessionSkills(props: DialogSessionSkillsProps) {
  const client = useClient()
  const dialog = useDialog()
  const { themeV2 } = useTheme()
  const paths = useTuiPaths()
  const [filter, setFilter] = createSignal("")
  const [selected, setSelected] = createSignal<SessionSkill>()
  const [loadError, setLoadError] = createSignal<unknown>()
  onMount(() => dialog.setSize("large"))

  const [skills, { refetch }] = createResource(async () => {
    try {
      const skills = await client.api.session.skills({ sessionID: props.sessionID })
      setLoadError(undefined)
      return skills
    } catch (error) {
      setLoadError(error)
      return []
    }
  })
  const [skillInfo, { refetch: refetchSkillInfo }] = createResource(async () => {
    try {
      return await client.api.skill.list({ location: props.location })
    } catch {
      return undefined
    }
  })

  const scoped = createMemo(() => {
    const locations = new Map((skillInfo()?.data ?? []).map((skill) => [skill.id, skill.location]))
    const projectDirectory = skillInfo()?.location.project.directory
    const globalConfigDirectory = process.env.YCODING_CONFIG_DIR ?? Global.Path.config
    return (skills() ?? []).map((skill) => ({
      ...skill,
      scope: sessionSkillScope({
        location: locations.get(skill.id),
        projectDirectory,
        home: paths.home,
        globalConfigDirectory,
      }),
    }))
  })
  const grouped = createMemo(() => groupSessionSkills(filterSessionSkills(scoped(), filter())))
  const options = createMemo<DialogSelectOption<SessionSkill>[]>(() =>
    [
      ...grouped().active.filter((skill) => !skill.conflicts.length),
      ...grouped().active.filter((skill) => skill.conflicts.length),
      ...grouped().inactive,
    ].map((skill) => ({
      title: skill.name,
      titleView:
        skill.conflicts.length ? (
          <span style={{ fg: themeV2.text.feedback.warning.default }}>{skill.name}</span>
        ) : skill.state === "inactive" ? (
          <span style={{ fg: themeV2.text.subdued }}>{skill.name}</span>
        ) : undefined,
      description: skill.scope,
      footer:
        skill.conflicts.length ? (
          <span style={{ fg: themeV2.text.feedback.warning.default }}>Needs choice</span>
        ) : skill.state === "active" ? (
          <span style={{ fg: themeV2.text.action.primary.focused }}>Active</span>
        ) : (
          <span style={{ fg: themeV2.text.subdued }}>Inactive</span>
        ),
      category: skill.conflicts.length ? "Conflict" : skill.state === "active" ? "Active" : "Available",
      state: skill.conflicts.length ? "failed" : skill.state === "active" ? "connected" : "disabled",
      value: skill,
      onSelect: () => setSelected(skill),
    })),
  )

  return (
    <Show
      when={selected()}
      fallback={
        <DialogSelect
          title="Session skills"
          options={options()}
          renderFilter={!skills.loading && !loadError()}
          locked={skills.loading || Boolean(loadError())}
          onFilter={setFilter}
          footer={<text fg={themeV2.text.hint}>space toggle</text>}
          bindings={[
            {
              bind: "r",
              title: "Retry loading session skills",
              group: "Dialog",
              run: () => {
                if (!loadError()) return
                void refetch()
                void refetchSkillInfo()
              },
            },
          ]}
          emptyView={
            <Switch
              fallback={
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={themeV2.text.subdued}>No loaded skills in this session</text>
                </box>
              }
            >
              <Match when={loadError()}>
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={themeV2.text.feedback.error.default} attributes={TextAttributes.BOLD}>
                    Could not load session skills
                  </text>
                  <text fg={themeV2.text.subdued}>{errorMessage(loadError())}</text>
                  <text fg={themeV2.text.subdued}>Press r to retry.</text>
                </box>
              </Match>
              <Match when={skills.loading}>
                <box paddingLeft={4} paddingRight={4} paddingTop={1}>
                  <text fg={themeV2.text.subdued}>Loading session skills…</text>
                </box>
              </Match>
            </Switch>
          }
          noMatchView={
            <box paddingLeft={4} paddingRight={4} paddingTop={1}>
              <text fg={themeV2.text.subdued}>No skills found</text>
            </box>
          }
        />
      }
    >
      {(skill) => <SessionSkillDetails skill={skill()} onBack={() => setSelected()} />}
    </Show>
  )
}

function SessionSkillDetails(props: { skill: SessionSkill; onBack: () => void }) {
  const { themeV2 } = useTheme()
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const config = useConfig().data
  const [expanded, setExpanded] = createSignal(false)
  const content = createMemo(() => sessionSkillContent(props.skill.content))
  const height = createMemo(() => Math.max(3, Math.floor(dimensions().height / 2) - 5))
  let scroll: ScrollBoxRenderable | undefined
  const toggle = () => {
    if (!content() || renderer.getSelection()?.getSelectedText()) return
    setExpanded((value) => !value)
  }

  useKeyboard((key) => {
    if (key.name === "up") return scroll?.scrollBy(-1)
    if (key.name === "down") return scroll?.scrollBy(1)
    if (key.name === "pageup") return scroll?.scrollBy(-height())
    if (key.name === "pagedown") return scroll?.scrollBy(height())
    if (key.name === "home") return scroll?.scrollTo(0)
    if (key.name === "end" && scroll) return scroll.scrollTo(scroll.scrollHeight)
  })

  return (
    <DialogSelect
      title={`Session skill: ${props.skill.name}`}
      options={[]}
      renderFilter={false}
      locked
      bindings={[
        {
          bind: "escape",
          title: "Back to session skills",
          group: "Dialog",
          run: props.onBack,
        },
        {
          bind: "return",
          title: "Toggle skill content",
          group: "Dialog",
          run: toggle,
        },
        {
          bind: "space",
          title: "Toggle skill content",
          group: "Dialog",
          run: toggle,
        },
      ]}
      emptyView={
        <scrollbox
          ref={(element: ScrollBoxRenderable) => (scroll = element)}
          height={height()}
          scrollbarOptions={{ visible: false }}
          scrollAcceleration={getScrollAcceleration(config)}
        >
          <box paddingLeft={4} paddingRight={4} paddingTop={1} flexDirection="column">
            <text fg={themeV2.text.default}>{sessionSkillLabel(props.skill)}</text>
            <text fg={themeV2.text.subdued}>Source: {props.skill.activatedBy}</text>
            <text fg={themeV2.text.subdued}>Message: {props.skill.activationMessageID}</text>
            <text fg={themeV2.text.subdued}>Scope: Session</text>
            <text fg={themeV2.text.subdued}>
              Latest boundary: {props.skill.inactiveReason ? props.skill.inactiveReason.replace("_", " ") : "current"}
            </text>
            <Show when={props.skill.conflicts.length}>
              <text fg={themeV2.text.subdued}>Conflicts</text>
              <For each={props.skill.conflicts}>
                {(conflict) => <text fg={themeV2.text.subdued}>  {conflict.type}: {conflict.name}</text>}
              </For>
            </Show>
            <text fg={themeV2.text.subdued}>Declarations: {JSON.stringify(props.skill.declarations)}</text>
            <Show when={content()}>
              <box paddingTop={1} onMouseUp={toggle}>
                <text fg={themeV2.text.subdued}>{expanded() ? "- Skill content" : "+ Skill content"}</text>
                <Show when={expanded()}>
                  <text fg={themeV2.text.default}>{content()}</text>
                </Show>
              </box>
            </Show>
          </box>
        </scrollbox>
      }
    />
  )
}
