export * as Config from "."

import { createBindingLookup } from "@opentui/keymap/extras"
import { createContext, type JSX, useContext } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { TuiKeybind } from "./keybind"
import type { AttentionSoundPaths, CoordinationNotifications, Info } from "./schema"

export { AttentionSoundName, CoordinationNotifications, Info, Plugin } from "./schema"
export type { AttentionSoundPaths } from "./schema"

export interface Interface {
  readonly path?: string
  readonly get: () => Promise<Info>
  readonly update: (update: (draft: any) => void) => Promise<Info>
}

export type Resolved = Omit<Info, "attention" | "keybinds" | "leader" | "mouse"> & {
  attention: {
    enabled: boolean
    notifications: boolean
    sound: boolean
    volume: number
    sound_pack: string
    sounds: AttentionSoundPaths
    coordination: CoordinationNotifications
  }
  keybinds: TuiKeybind.BindingLookupView
  leader: { timeout: number }
  mouse: boolean
}

export function resolve(input: Info, options: { terminalSuspend: boolean }): Resolved {
  const keybinds: TuiKeybind.KeybindOverrides = { ...input.keybinds }
  if (!options.terminalSuspend) {
    keybinds.terminal_suspend = "none"
    if (keybinds.input_undo === undefined) {
      const inputUndo = TuiKeybind.defaultValue("input_undo")
      keybinds.input_undo = ["ctrl+z", ...(typeof inputUndo === "string" ? inputUndo.split(",") : [])]
        .filter((value, index, values) => values.indexOf(value) === index)
        .join(",")
    }
  }

  return {
    ...input,
    attention: {
      enabled: input.attention?.enabled ?? true,
      notifications: input.attention?.notifications ?? true,
      sound: input.attention?.sound ?? true,
      volume: input.attention?.volume ?? 0.4,
      sound_pack: input.attention?.sound_pack ?? "ycoding.default",
      sounds: input.attention?.sounds ?? {},
      coordination: input.attention?.coordination ?? { scope: "all" },
    },
    keybinds: createBindingLookup(TuiKeybind.toBindingConfig(TuiKeybind.parse(keybinds)), {
      commandMap: TuiKeybind.CommandMap,
      bindingDefaults: TuiKeybind.bindingDefaults(),
    }),
    leader: { timeout: input.leader?.timeout ?? 2000 },
    mouse: input.mouse ?? true,
  }
}

const ConfigContext = createContext<{
  data: Resolved
  path?: string
  update: Interface["update"]
}>()

export function ConfigProvider(props: {
  config: Resolved
  service?: Interface
  options?: { terminalSuspend: boolean }
  children: JSX.Element
}) {
  const [config, setConfig] = createStore(props.config)
  const host = props.service
  const update = async (update: (draft: any) => void) => {
    if (!host) throw new Error("Config updates are not available")
    const info = await host.update(update)
    setConfig(reconcile(resolve(info, props.options ?? { terminalSuspend: true })))
    return info
  }
  return (
    <ConfigContext.Provider value={{ data: config, path: host?.path, update }}>{props.children}</ConfigContext.Provider>
  )
}

export function useConfig() {
  const value = useContext(ConfigContext)
  if (!value) throw new Error("ConfigProvider is missing")
  return value
}

export function useConfigOptional() {
  return useContext(ConfigContext)
}
