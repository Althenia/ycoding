import { useData } from "../../context/data"
import { createEffect, createMemo, For, Show, type JSX } from "solid-js"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { usePluginRuntime } from "../../plugin/runtime"
import { PluginSlot } from "../../plugin/context"
import type { SessionAutonomyState } from "@ycoding-ai/client"

import { useTerminalDimensions } from "@opentui/solid"
import { getScrollAcceleration } from "../../util/scroll"
import { autonomyModeLabel } from "../../util/session-autonomy"
import { railMetrics, railWidth } from "./rail"
import { RailProvider, RailRow, RailSection } from "./rail-section"

export function Sidebar(props: { sessionID: string; autonomy: SessionAutonomyState; shellSurface?: boolean; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const data = useData()
  const { themeV2 } = useTheme().contextual("elevated")
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const session = createMemo(() => data.session.get(props.sessionID))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))
  const allExpanded = () => props.autonomy.mode === "goal"

  return (
    <Show when={session()}>
      <box
        backgroundColor={themeV2.background.default}
        border={["left"]}
        borderColor={themeV2.border.default}
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
              foregroundColor: themeV2.scrollbar.default,
            },
          }}
        >
          <box flexShrink={0}>
            <RailProvider
              goal={Boolean(props.autonomy.goal)}
              autonomy={props.autonomy.mode !== "normal"}
              shellSurface={props.shellSurface}
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
              <AutonomyRailContent autonomy={props.autonomy} />
              <PluginSlot
                name="sidebar.content"
                input={{ sessionID: props.sessionID, shellSurface: () => Boolean(props.shellSurface) }}
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
                          plugin.active ? themeV2.text.feedback.success.default : themeV2.text.subdued
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
  const { themeV2 } = useTheme().contextual("elevated")

  return (
    <>
      <text fg={themeV2.text.default}>
        <b>{props.title}</b>
      </text>
    </>
  )
}

export function AutonomyRailContent(props: { autonomy: SessionAutonomyState }) {
  const { themeV2 } = useTheme().contextual("elevated")

  return (
    <>
      <Show when={props.autonomy.goal}>
        {/* The no-progress count and its meter are hidden by explicit user instruction: neither
            communicated anything actionable in the rail. */}
        {(goal) => (
          <RailSection section="goal" title="GOAL" summary={goal().status}>
            <text fg={themeV2.text.default}>{goal().text}</text>
            <box height={1} flexShrink={0} />
            <RailRow
              label="Status"
              value={goal().status}
              valueColor={
                goal().status === "active" || goal().status === "completed"
                  ? themeV2.text.feedback.success.default
                  : themeV2.text.feedback.warning.default
              }
            />
          </RailSection>
        )}
      </Show>
      <Show when={props.autonomy.mode !== "normal"}>
        <RailSection section="autonomy" title="AUTONOMY" summary={autonomyModeLabel(props.autonomy)} attention={props.autonomy.mode === "yolo"}>
          <RailRow
            label="Approvals"
            value={props.autonomy.mode === "yolo" ? "auto" : "manual"}
            valueColor={props.autonomy.mode === "yolo" ? themeV2.text.feedback.warning.default : themeV2.text.default}
          />
        </RailSection>
      </Show>
    </>
  )
}
