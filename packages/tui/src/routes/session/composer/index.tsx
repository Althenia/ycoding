import { createEffect, createMemo, For, onCleanup, Show, useContext, createContext } from "solid-js"
import { createStore } from "solid-js/store"
import { TextAttributes } from "@opentui/core"
import { type JSX } from "@opentui/solid"
import { useTheme } from "../../../context/theme"
import { Keymap } from "../../../context/keymap"
import { useData } from "../../../context/data"
import { groupSessionShells } from "../../../util/session"
import { SubagentsTab } from "./subagents-tab"
import { ShellTab } from "./shell-tab"

export interface ComposerHint {
  label: string
  shortcut: string
  gapAfter?: number
}

interface Tab {
  id: string
  label: string
  hints?: () => ComposerHint[]
  onClose?: () => void
}

const ComposerContext = createContext<{
  register: (tab: Tab) => () => void
  active: (id: string) => boolean
  close: () => void
}>()

export function useComposerTab() {
  const ctx = useContext(ComposerContext)
  if (!ctx) throw new Error("useComposerTab must be used within a Composer")
  return ctx
}

export type ComposerProps = {
  sessionID: string
  open: boolean
  defaultTab?: string
  onClose?: () => void
  prompt?: JSX.Element
}

export function Composer(props: ComposerProps) {
  const { themeV2 } = useTheme().contextual("elevated")
  const data = useData()

  const [store, setStore] = createStore({
    tabs: {} as Record<string, Tab>,
    active: "",
  })

  const tabList = createMemo(() => Object.values(store.tabs))
  const activeTab = createMemo(() => tabList().find((t) => t.id === store.active))
  const footerHints = createMemo(() => activeTab()?.hints?.() ?? [])
  const session = createMemo(() => data.session.get(props.sessionID))
  const shells = createMemo(() =>
    groupSessionShells(data.shell.list(session()?.location), data.session.list(), props.sessionID).reduce(
      (count, group) => count + group.shells.length,
      0,
    ),
  )
  const subagents = createMemo(() => data.session.subagent.summary(props.sessionID)?.active ?? 0)

  // Set active tab when opened
  let defaultTabApplied = false

  createEffect(() => {
    if (!props.open) {
      defaultTabApplied = false
      if (store.active) setStore("active", "")
      return
    }
    if (defaultTabApplied) return
    const tabs = tabList()
    if (tabs.length === 0) return
    const match = props.defaultTab && tabs.find((t) => t.id === props.defaultTab)
    if (props.defaultTab && !match) return
    setStore("active", match ? match.id : tabs[0].id)
    defaultTabApplied = true
  })

  function close() {
    const tab = activeTab()
    tab?.onClose?.()
    props.onClose?.()
  }

  const ctx = {
    register(tab: Tab) {
      setStore("tabs", tab.id, tab)
      if (!store.active) setStore("active", tab.id)
      return () => setStore("tabs", tab.id, undefined!)
    },
    active(id: string) {
      return props.open && store.active === id
    },
    close,
  }

  const keymap = Keymap.use()
  createEffect(() => {
    if (!props.open) return
    const popMode = keymap.mode.push("composer")
    onCleanup(popMode)
  })

  const switchTab = (dir: number) => {
    const tabs = tabList()
    if (tabs.length <= 1) return
    const idx = tabs.findIndex((t) => t.id === store.active)
    setStore("active", tabs[(idx + dir + tabs.length) % tabs.length].id)
  }

  Keymap.createLayer(() => ({
    mode: "composer",
    enabled: () => props.open,
    commands: [
      { bind: "left", title: "Previous tab", group: "Composer", run: () => switchTab(-1) },
      { bind: "right", title: "Next tab", group: "Composer", run: () => switchTab(1) },
      { bind: "escape", title: "Close composer", group: "Composer", run: close },
      {
        bind: "<leader>down",
        title: "Toggle composer",
        group: "Composer",
        run: close,
      },
    ],
  }))

  return (
    <ComposerContext.Provider value={ctx}>
      <box flexShrink={0} visible={props.open}>
        <box
          backgroundColor={themeV2.background.default}
          paddingLeft={3}
          paddingRight={4}
          paddingTop={3}
          paddingBottom={1}
        >
          <box gap={1}>
            <box flexDirection="row" paddingLeft={0}>
              <Show
                when={tabList().length > 1}
                fallback={
                  <text fg={themeV2.text.feedback.success.default} attributes={TextAttributes.BOLD}>
                    {tabList()[0]?.label ?? ""}
                  </text>
                }
              >
                <box flexDirection="row">
                  <For each={tabList()}>
                    {(tab, index) => {
                      const isActive = createMemo(() => store.active === tab.id)
                      return (
                        <>
                          <Show when={index() > 0}>
                            <box width={4} />
                          </Show>
                          <text
                            fg={isActive() ? themeV2.text.feedback.success.default : themeV2.text.subdued}
                            attributes={isActive() ? TextAttributes.BOLD : undefined}
                            onMouseUp={() => setStore("active", tab.id)}
                          >
                            {tab.label}
                          </text>
                          <Show when={tab.id === "subagents"}>
                            <box width={2} />
                            <text fg={themeV2.text.feedback.warning.default}>{subagents()}</text>
                          </Show>
                          <Show when={tab.id === "shell"}>
                            <box width={1} />
                            <text fg={themeV2.text.feedback.info.default}>{shells()}</text>
                          </Show>
                        </>
                      )
                    }}
                  </For>
                </box>
              </Show>
            </box>
            <SubagentsTab sessionID={props.sessionID} />
            <ShellTab sessionID={props.sessionID} />
            <box flexDirection="row" flexShrink={0}>
              <For each={footerHints()}>
                {(hint) => (
                  <>
                    <text>
                      <span style={{ fg: themeV2.text.default }}>
                        <b>{hint.label}</b>{" "}
                      </span>
                      <span style={{ fg: themeV2.text.subdued }}>{hint.shortcut}</span>
                    </text>
                    <Show when={hint.gapAfter} keyed>
                      {(gap) => <box width={gap} />}
                    </Show>
                  </>
                )}
              </For>
            </box>
          </box>
        </box>
        <Show when={props.prompt}>{(prompt) => <box width="100%">{prompt()}</box>}</Show>
      </box>
    </ComposerContext.Provider>
  )
}
