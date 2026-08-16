import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onMount, Show, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useData } from "../context/data"
import { useLocation } from "../context/location"
import { FormPrompt } from "./session/form"
import { PluginSlot } from "../plugin/context"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { ModeChips } from "../component/prompt/mode-chips"
import { Header } from "./session/header"
import { useClient } from "../context/client"
import { BrandMark } from "../component/logo"

let once = false
export const landingPlaceholder = { normal: ["Message YCoding…"] }

export function LandingHero() {
  const { themeV2 } = useTheme()

  return (
    <box alignItems="center" flexShrink={0}>
      <box flexDirection="column" alignItems="center" gap={2}>
        <BrandMark />
        <text fg={themeV2.text.default} selectable={false}>
          What should we build?
        </text>
        <text fg={themeV2.text.subdued} selectable={false}>
          Describe a goal, paste an error, or press ^p for commands.
        </text>
      </box>
    </box>
  )
}

export function LandingComposer(props: { children: JSX.Element }) {
  const { themeV2 } = useTheme()
  const dimensions = useTerminalDimensions()
  return (
    <box
      width="100%"
      paddingBottom={Math.max(0, Math.max(1, Math.min(4, Math.floor(dimensions().height / 16))) - 1)}
      border={["top"]}
      borderColor={themeV2.text.feedback.success.default}
    >
      {props.children}
    </box>
  )
}

export function LandingMark(props: { overlay: boolean; children: JSX.Element }) {
  return <Show when={!props.overlay}>{props.children}</Show>
}

export function LandingFooter() {
  const { themeV2 } = useTheme()
  const shortcut = Keymap.useShortcut("command.palette.show")

  return (
    <box
      width="100%"
      flexShrink={0}
      flexDirection="row"
      justifyContent="space-between"
      paddingLeft={3}
      paddingRight={3}
      height={3}
      alignItems="center"
      backgroundColor={themeV2.background.chrome}
    >
      <box flexDirection="row" gap={3}>
        <text fg={themeV2.text.subdued}>main</text>
        <ModeChips />
        <text fg={themeV2.text.subdued}>subagents 0</text>
      </box>
      <Show when={shortcut()}>
        {(value) => <text fg={themeV2.text.feedback.info.default}>{value().replaceAll("ctrl+", "⌃")} commands</text>}
      </Show>
    </box>
  )
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const data = useData()
  const location = useLocation()
  const dialog = useDialog()
  const client = useClient()
  const [promptOverlay, setPromptOverlay] = createSignal(false)
  // Global MCP elicitations can arrive without a session route, so keep them reachable from Home.
  const forms = createMemo(() => data.session.form.list("global", data.location.default()) ?? [])
  const overlay = createMemo(() => dialog.stack.length > 0 || promptOverlay())
  const homeLocation = createMemo(() => data.location.default())
  const [branch, setBranch] = createSignal<string>()
  let sent = false

  createEffect(() => location.set(data.location.default()))

  createEffect(() => {
    const target = homeLocation()
    if (client.connection.status() !== "connected") return
    void client.api.vcs.branch({ location: target }).then(
      (response) => {
        if (homeLocation() !== target) return
        setBranch(response.data.current)
      },
      () => undefined,
    )
  })

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ text: args.prompt, files: [], agents: [], pasted: [] })
    once = true
  }

  // Wait for the model store to be ready before auto-submitting --prompt.
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!local.model.ready) return
    if (!args.prompt) return
    if (r.current.text !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <>
      <Header
        path={homeLocation().directory}
        branch={branch()}
        agent={local.agent.current()?.name}
        model={local.model.parsed().model}
        variant={local.model.variant.current()}
        state={{ type: "ready" }}
      />
      <box flexGrow={1} flexDirection="column">
        {/* Penpot board 01 Landing leaves 262px above the hero and 279px below it, so the lower
            spacer carries 279/262 of the upper one. A ratio rather than a row count keeps the
            reference proportion at any terminal height. */}
        <box flexGrow={1} minHeight={0} />
        <LandingMark overlay={overlay()}>
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <LandingHero />
          </pluginRuntime.Slot>
        </LandingMark>
        <box flexGrow={279 / 262} minHeight={0} />
        <LandingComposer>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt
              ref={bind}
              placeholders={landingPlaceholder}
              landing
              onOverlayChange={setPromptOverlay}
              disabled={forms().length > 0}
            />
          </pluginRuntime.Slot>
        </LandingComposer>
        <PluginSlot name="home.bottom" />
      </box>
      <LandingFooter />
      <Show when={forms()[0]?.id} keyed>
        {(_) => {
          const form = forms()[0]
          return form ? (
            <box position="absolute" zIndex={2000} left={0} right={0} bottom={1} paddingLeft={2} paddingRight={2}>
              <box width="100%">
                <FormPrompt form={form} />
              </box>
            </box>
          ) : null
        }}
      </Show>
    </>
  )
}
