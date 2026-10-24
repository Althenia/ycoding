import { type CliRenderer, type Renderable } from "@opentui/core"
import { Keymap } from "@opentui/keymap"
import { registerDefaultKeys, registerEnabledFields, registerMetadataFields } from "@opentui/keymap/addons"
import { createOpenTuiKeymapHost } from "@opentui/keymap/opentui"

export function createKeymap(renderer: CliRenderer) {
  const host = createOpenTuiKeymapHost(renderer)
  const subscribe = host.onTargetDestroy.bind(host)
  const targets = new WeakMap<Renderable, { listeners: Set<() => void>; dispose: () => void }>()
  host.onTargetDestroy = (target, listener) => {
    const existing = targets.get(target)
    const entry = existing ?? { listeners: new Set<() => void>(), dispose: () => {} }
    if (!existing) {
      targets.set(target, entry)
      entry.dispose = subscribe(target, () => {
        targets.delete(target)
        for (const notify of [...entry.listeners]) notify()
        entry.listeners.clear()
      })
    }
    entry.listeners.add(listener)
    return () => {
      entry.listeners.delete(listener)
      if (entry.listeners.size || targets.get(target) !== entry) return
      targets.delete(target)
      entry.dispose()
    }
  }
  const keymap = new Keymap(host)
  registerDefaultKeys(keymap)
  registerEnabledFields(keymap)
  registerMetadataFields(keymap)
  return keymap
}
