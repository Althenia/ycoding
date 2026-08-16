import { useData } from "../../context/data"
import { createMemo, Show } from "solid-js"
import { useTheme } from "../../context/theme"
import { useConfig } from "../../config"
import { usePluginRuntime } from "../../plugin/runtime"
import { PluginSlot } from "../../plugin/context"
import type { SessionAutonomyState } from "@ycoding-ai/client"

import { useTerminalDimensions } from "@opentui/solid"
import { getScrollAcceleration } from "../../util/scroll"
import { autonomyModeLabel, autonomyProgressLabel } from "../../util/session-autonomy"
import { railWidth } from "./rail"
import { RailProvider, RailSection } from "./rail-section"

export function Sidebar(props: { sessionID: string; autonomy: SessionAutonomyState; overlay?: boolean }) {
  const pluginRuntime = usePluginRuntime()
  const data = useData()
  const { themeV2 } = useTheme().contextual("elevated")
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const session = createMemo(() => data.session.get(props.sessionID))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(config))

  return (
    <Show when={session()}>
      <box
        backgroundColor={themeV2.background.default}
        width={railWidth(dimensions().width)}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          scrollAcceleration={scrollAcceleration()}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: themeV2.background.default,
              foregroundColor: themeV2.scrollbar.default,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <RailProvider goal={Boolean(props.autonomy.goal)} autonomy={props.autonomy.mode !== "normal"}>
              <RailSection section="session" title="SESSION" summary={session()!.title}>
                <pluginRuntime.Slot
                  name="sidebar_title"
                  mode="single_winner"
                  session_id={props.sessionID}
                  title={session()!.title}
                >
                  <box paddingRight={1}>
                    <text fg={themeV2.text.default}>
                      <b>{session()!.title}</b>
                    </text>
                    <Show when={session()!.location.workspaceID}>
                      <text fg={themeV2.text.subdued}>{session()!.location.workspaceID}</text>
                    </Show>
                  </box>
                </pluginRuntime.Slot>
              </RailSection>
              <RailSection section="autonomy" title="AUTONOMY" summary={autonomyModeLabel(props.autonomy)}>
                <box paddingRight={1}>
                  <text fg={themeV2.text.default}>
                    <b>{autonomyModeLabel(props.autonomy)}</b>
                  </text>
                  <Show when={props.autonomy.goal}>
                    {(goal) => (
                      <box>
                        <text fg={themeV2.text.default}>{goal().text}</text>
                        <text fg={themeV2.text.subdued}>{autonomyProgressLabel(props.autonomy)}</text>
                        <text fg={themeV2.text.subdued}>Status: {goal().status}</text>
                      </box>
                    )}
                  </Show>
                </box>
              </RailSection>
              <PluginSlot name="sidebar.content" input={{ sessionID: props.sessionID }} />
            </RailProvider>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <PluginSlot name="sidebar.footer" />
        </box>
      </box>
    </Show>
  )
}
