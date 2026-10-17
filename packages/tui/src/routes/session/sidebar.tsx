import { useData } from "../../context/data"
import { createMemo, For, Show, type JSX } from "solid-js"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { usePluginRuntime } from "../../plugin/runtime"
import { PluginSlot } from "../../plugin/context"
import type { SessionAutonomyView } from "@ycoding-ai/client"

import { useTerminalDimensions } from "@opentui/solid"
import { getScrollAcceleration } from "../../util/scroll"
import {
  autoAnswerOn,
  autonomyDecisionKind,
  autonomyDecisionLabel,
  autonomyModeLabel,
} from "../../util/session-autonomy"
import { railMetrics, railWidth } from "./rail"
import { RailProvider, RailRow, RailSection } from "./rail-section"

export function Sidebar(props: { sessionID: string; autonomy?: SessionAutonomyView; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const data = useData()
  const { theme } = useTheme().contextual("elevated")
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const session = createMemo(() => data.session.get(props.sessionID))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))
  const allExpanded = () => props.autonomy?.goal?.status === "active"

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.background.default}
        border={["left"]}
        borderColor={theme.border.default}
        width={railWidth(dimensions().width)}
        height="100%"
        paddingBottom={1}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          marginTop={0}
          marginBottom={0}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            position: "absolute",
            right: 0,
            trackOptions: {
              backgroundColor: "transparent",
              foregroundColor: theme.scrollbar.default,
            },
          }}
        >
          <box flexShrink={0}>
            <RailProvider
              goal={props.autonomy?.goal?.status === "active"}
              autonomy={(props.autonomy?.effective?.yolo ?? 0) > 0 || props.autonomy?.goal?.status === "active"}
              allExpanded={allExpanded()}
              leftRule
            >
              <SessionRailContent sessionID={props.sessionID} title={session().title}>
                <pluginRuntime.Slot
                  name="sidebar_title"
                  mode="single_winner"
                  session_id={props.sessionID}
                  title={session().title}
                >
                  <SessionRailIdentity title={session().title} />
                </pluginRuntime.Slot>
              </SessionRailContent>
              <AutonomyRailContent autonomy={props.autonomy} reviewCount={data.session.review.list(props.sessionID).length} />
              <PluginSlot
                name="sidebar.content"
                input={{ sessionID: props.sessionID }}
              />
              <Show when={pluginRuntime.status().length > 0}>
                <RailSection
                  section="plugins"
                  title="PLUGINS"
                  summary={`${pluginRuntime.status().filter((plugin) => plugin.active).length}/${pluginRuntime.status().length} active`}
                >
                  <For each={pluginRuntime.status()}>
                    {(plugin) => (
                      <RailRow
                        label={plugin.id}
                        value={plugin.active ? "active" : "inactive"}
                        valueColor={
                          plugin.active ? theme.text.feedback.success.default : theme.text.subdued
                        }
                      />
                    )}
                  </For>
                </RailSection>
              </Show>
            </RailProvider>
          </box>
        </scrollbox>
      </box>
    </Show>
  )
}

export function SessionRailContent(props: { sessionID: string; title: string; children?: JSX.Element }) {
  const dimensions = useTerminalDimensions()

  return (
    <RailSection section="session" title="SESSION">
      <box
        gap={railMetrics(dimensions().width).sessionGap}
        paddingRight={1}
      >
        <Show when={props.children} fallback={<SessionRailIdentity title={props.title} />}>
          {props.children}
        </Show>
      </box>
    </RailSection>
  )
}

function SessionRailIdentity(props: { title: string }) {
  const { theme } = useTheme().contextual("elevated")

  return (
    <>
      <text fg={theme.text.default}>
        <b>{props.title}</b>
      </text>
    </>
  )
}

export function AutonomyRailContent(props: { autonomy?: SessionAutonomyView; reviewCount?: number }) {
  const { theme } = useTheme().contextual("elevated")
  const level = createMemo(() => props.autonomy?.effective?.yolo)

  return (
    <>
      <Show when={props.autonomy?.goal?.status === "active" ? props.autonomy.goal : undefined}>
        {(goal) => (
          <RailSection section="goal" title="GOAL" summary={goal().status}>
            <text fg={theme.text.default}>{goal().text}</text>
            <box height={1} flexShrink={0} />
            <RailRow
              label="Status"
              value={goal().status}
              valueColor={theme.text.feedback.success.default}
            />
          </RailSection>
        )}
      </Show>
      <Show when={true}>
        <RailSection
          section="autonomy"
          title="AUTONOMY"
          summary={autonomyModeLabel(props.autonomy)}
          attention={
            (level() ?? 0) > 0 || props.autonomy?.goal?.status === "active" || props.autonomy?.effective?.asleep === true || autoAnswerOn(props.autonomy)
          }
        >
          <For each={[
            ["Permissions", "permissions"],
            ["Guardrails", "guardrails"],
            ["Questions", "questions"],
          ] as const}>
            {([label, action]) => {
              const decision = () => autonomyDecisionKind(props.autonomy, action)
              return (
                <RailRow
                  label={label}
                  value={autonomyDecisionLabel(props.autonomy, action)}
                  valueColor={
                    decision() === "you"
                      ? theme.text.feedback.success.default
                      : decision() === "unknown"
                        ? theme.text.subdued
                        : theme.text.feedback.warning.default
                  }
                />
              )
            }}
          </For>
          <Show when={props.reviewCount}>
            {(count) => (
              <RailRow
                label="Review"
                value={`${count()} waiting`}
                valueColor={theme.text.feedback.warning.default}
              />
            )}
          </Show>
        </RailSection>
      </Show>
    </>
  )
}
