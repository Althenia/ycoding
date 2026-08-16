import { createEffect, createMemo, createSignal, on, Show } from "solid-js"
import type { SessionCacheDiagnostics, SessionInfo } from "@ycoding-ai/client"
import { useRouteData } from "../../context/route"
import { useData } from "../../context/data"
import { useTheme } from "../../context/theme"
import { SplitBorder } from "../../ui/border"
import { Locale } from "../../util/locale"
import { useTerminalDimensions } from "@opentui/solid"
import { formatCacheDiagnostics, formatDiagnosticsModel } from "../../util/cache-diagnostics"
import { Keymap } from "../../context/keymap"

const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
})

type SubagentFooterUsage = {
  model?: string
  context?: string
  cache?: string
  cost?: string
}

export function subagentFooterData(
  session: Pick<SessionInfo, "agent" | "model" | "cost"> | undefined,
  diagnostics: SessionCacheDiagnostics | null | undefined,
) {
  const formatted = diagnostics ? formatCacheDiagnostics(diagnostics) : undefined
  return {
    title: session?.agent ? Locale.titlecase(session.agent) : "Subagent",
    usage: session
      ? {
          model: formatted?.model ?? formatDiagnosticsModel(session.model),
          context: formatted?.context,
          cache: formatted?.cache,
          cost: session.cost > 0 ? money.format(session.cost) : undefined,
        }
      : undefined,
  }
}

export function SubagentFooterContent(props: { title: string; usage: () => SubagentFooterUsage | undefined }) {
  const { themeV2 } = useTheme().contextual("elevated")
  const keymap = Keymap.use()
  const shortcuts = Keymap.useShortcuts()
  const [hover, setHover] = createSignal<"parent" | "prev" | "next" | null>(null)
  const dimensions = useTerminalDimensions()
  const compact = createMemo(() => dimensions().width < 60)

  return (
    <box flexShrink={0}>
      <box
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={1}
        {...SplitBorder}
        border={["left"]}
        borderColor={themeV2.border.default}
        flexShrink={0}
        backgroundColor={themeV2.background.default}
      >
        <box flexDirection="row" flexWrap="wrap" justifyContent="space-between" gap={1}>
          <box flexDirection="row" flexWrap="wrap" gap={1} flexGrow={1} minWidth={0}>
            <text fg={themeV2.text.default}>
              <b>{props.title}</b>
            </text>
            <Show when={props.usage()}>
              {(item) => (
                <box flexDirection="column" minWidth={0} flexGrow={1}>
                  <text fg={themeV2.text.subdued} wrapMode="none">
                    {[item().model, item().context, item().cache, item().cost].filter(Boolean).join(" · ")}
                  </text>
                </box>
              )}
            </Show>
          </box>
          <box flexDirection="row" flexWrap="wrap" justifyContent="flex-end" gap={1} flexShrink={0}>
            <box
              onMouseOver={() => setHover("parent")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatch("session.parent")}
              backgroundColor={
                hover() === "parent" ? themeV2.background.action.primary.hovered : themeV2.background.default
              }
            >
              <text fg={themeV2.text.default}>
                {compact() ? "↖" : "Parent"}{" "}
                <span style={{ fg: themeV2.text.subdued }}>{shortcuts.get("session.parent")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("prev")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatch("session.child.previous")}
              backgroundColor={
                hover() === "prev" ? themeV2.background.action.primary.hovered : themeV2.background.default
              }
            >
              <text fg={themeV2.text.default}>
                {compact() ? "←" : "Prev"}{" "}
                <span style={{ fg: themeV2.text.subdued }}>{shortcuts.get("session.child.previous")}</span>
              </text>
            </box>
            <box
              onMouseOver={() => setHover("next")}
              onMouseOut={() => setHover(null)}
              onMouseUp={() => keymap.dispatch("session.child.next")}
              backgroundColor={
                hover() === "next" ? themeV2.background.action.primary.hovered : themeV2.background.default
              }
            >
              <text fg={themeV2.text.default}>
                {compact() ? "→" : "Next"}{" "}
                <span style={{ fg: themeV2.text.subdued }}>{shortcuts.get("session.child.next")}</span>
              </text>
            </box>
          </box>
        </box>
      </box>
    </box>
  )
}

export function SubagentFooter() {
  const route = useRouteData("session")
  const data = useData()
  const session = createMemo(() => data.session.get(route.sessionID))

  createEffect(
    on(
      () => route.sessionID,
      (sessionID) => void data.session.diagnostics.sync(sessionID).catch(() => undefined),
    ),
  )

  const footer = createMemo(() => subagentFooterData(session(), data.session.diagnostics.get(route.sessionID)))

  return <SubagentFooterContent title={footer().title} usage={() => footer().usage} />
}
