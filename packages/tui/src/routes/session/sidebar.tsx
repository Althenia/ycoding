import { useData } from "../../context/data"
import { createEffect, createMemo, For, Show, type JSX } from "solid-js"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { usePluginRuntime } from "../../plugin/runtime"
import { PluginSlot } from "../../plugin/context"
import type { SessionAutonomyState } from "@ycoding-ai/client"

import { useTerminalDimensions } from "@opentui/solid"
import { getScrollAcceleration } from "../../util/scroll"
import { autonomyModeLabel, yoloLevel } from "../../util/session-autonomy"
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
  const allExpanded = () => props.autonomy.goal?.status === "active"

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
              goal={props.autonomy.goal?.status === "active"}
              autonomy={yoloLevel(props.autonomy) > 0 || props.autonomy.goal?.status === "active"}
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
  const level = createMemo(() => yoloLevel(props.autonomy))

  return (
    <>
      <Show when={props.autonomy.goal?.status === "active" ? props.autonomy.goal : undefined}>
        {(goal) => (
          <RailSection section="goal" title="GOAL" summary={goal().status}>
            <text fg={themeV2.text.default}>{goal().text}</text>
            <box height={1} flexShrink={0} />
            <RailRow
              label="Status"
              value={goal().status}
              valueColor={themeV2.text.feedback.success.default}
            />
          </RailSection>
        )}
      </Show>
      <Show when={true}>
        <RailSection section="autonomy" title="AUTONOMY" summary={autonomyModeLabel(props.autonomy)} attention={level() > 0}>
          <RailRow
            label="Approvals"
            value={level() > 0 ? `auto · YOLO ${level()}` : "manual"}
            valueColor={level() > 0 ? themeV2.text.feedback.warning.default : themeV2.text.default}
          />
          <RailRow
            label="Guardrails"
            value={level() === 3 ? "auto · YOLO 3" : "enforced"}
            valueColor={
              level() === 3 ? themeV2.text.feedback.warning.default : themeV2.text.feedback.success.default
            }
          />
          <RailRow label="Hard reviews" value="human only" valueColor={themeV2.text.feedback.success.default} />
        </RailSection>
      </Show>
    </>
  )
}
