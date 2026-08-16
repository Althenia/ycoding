import { useData } from "../../context/data"
import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { usePluginRuntime } from "../../plugin/runtime"
import { PluginSlot } from "../../plugin/context"
import type { SessionAutonomyState } from "@ycoding-ai/client"
import { InstallationVersion } from "@ycoding-ai/core/installation/version"

import { useTerminalDimensions } from "@opentui/solid"
import { getScrollAcceleration } from "../../util/scroll"
import { autonomyModeLabel } from "../../util/session-autonomy"
import { PromptFooterIdentity } from "../../component/prompt"
import { useClient } from "../../context/client"
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
  const allExpanded = () => props.autonomy.mode === "yolo" && Boolean(props.autonomy.goal)

  return (
    <Show when={session()}>
      <box
        backgroundColor={themeV2.background.default}
        width={railWidth(dimensions().width)}
        height="100%"
        paddingBottom={1}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          marginTop={allExpanded() ? -1 : 0}
          marginBottom={allExpanded() ? -2 : 0}
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
            >
              <Show when={props.shellSurface}>
                <PluginSlot
                  name="sidebar.shells"
                  input={{ sessionID: props.sessionID, shellSurface: () => Boolean(props.shellSurface) }}
                />
              </Show>
              <SessionRailContent sessionID={props.sessionID} title={session().title}>
                <pluginRuntime.Slot
                  name="sidebar_title"
                  mode="single_winner"
                  session_id={props.sessionID}
                  title={session().title}
                >
                  <SessionRailIdentity sessionID={props.sessionID} title={session().title} />
                </pluginRuntime.Slot>
              </SessionRailContent>
              <AutonomyRailContent autonomy={props.autonomy} />
              <PluginSlot
                name="sidebar.content"
                input={{ sessionID: props.sessionID, shellSurface: () => Boolean(props.shellSurface) }}
              />
              <Show when={pluginRuntime.status().length > 0}>
                <RailSection section="plugins" title="PLUGINS" summary={String(pluginRuntime.status().length)}>
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

        <box
          flexShrink={0}
          border={["top"]}
          borderColor={themeV2.border.default}
          paddingTop={1}
          paddingRight={2}
          paddingBottom={1}
          paddingLeft={railMetrics(dimensions().width).paddingLeft}
        >
          <RailFooter directory={session().location.directory} />
        </box>
      </box>
    </Show>
  )
}

function RailFooter(props: { directory: string }) {
  const client = useClient()
  const { themeV2 } = useTheme().contextual("elevated")
  const [branch, setBranch] = createSignal<string>()

  createEffect(() => {
    if (client.connection.status() !== "connected") return
    void client.api.vcs.branch({ location: { directory: props.directory } }).then((response) => setBranch(response.data.current))
  })

  return (
    <box flexDirection="column" gap={0}>
      <text fg={themeV2.text.subdued} wrapMode="none" truncate>
        {props.directory}
        <Show when={branch()}>{(value) => ` · ${value()}`}</Show>
      </text>
      <text fg={themeV2.text.subdued} wrapMode="none">
        YCoding v{InstallationVersion} · {client.connection.status()}
      </text>
    </box>
  )
}

export function SessionRailContent(props: { sessionID: string; title: string; children?: JSX.Element }) {
  const dimensions = useTerminalDimensions()

  return (
    <RailSection section="session" title="SESSION">
      <box
        gap={railMetrics(dimensions().width).sessionGap}
        paddingRight={1}
        paddingBottom={railMetrics(dimensions().width).sessionPaddingBottom}
      >
        <Show when={props.children} fallback={<SessionRailIdentity sessionID={props.sessionID} title={props.title} />}>
          {props.children}
        </Show>
      </box>
    </RailSection>
  )
}

function SessionRailIdentity(props: { sessionID: string; title: string }) {
  const { themeV2 } = useTheme().contextual("elevated")

  return (
    <>
      <text fg={themeV2.text.default}>
        <b>{props.title}</b>
      </text>
      <PromptFooterIdentity sessionID={props.sessionID} />
    </>
  )
}

export function AutonomyRailContent(props: { autonomy: SessionAutonomyState }) {
  const { themeV2 } = useTheme().contextual("elevated")

  return (
    <>
      <Show when={props.autonomy.goal}>
        {(goal) => (
          <RailSection section="goal" title="GOAL" summary={`${goal().noProgress} / ${goal().maxNoProgress}`}>
            <text fg={themeV2.text.default}>{goal().text}</text>
            <box flexDirection="row" gap={1} paddingRight={1}>
              <For each={Array.from({ length: goal().maxNoProgress })}>
                {(_, index) => (
                  <text
                    flexGrow={1}
                    fg={index() < goal().noProgress ? themeV2.text.feedback.success.default : themeV2.border.default}
                  >
                    {"\u2588"}
                  </text>
                )}
              </For>
            </box>
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
            <box height={2} flexShrink={0} />
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
