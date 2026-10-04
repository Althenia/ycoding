import { RGBA } from "@opentui/core"
import type { Accessor } from "solid-js"
import type { Mode, ResolvedThemeView } from "./index"

export function createComponentTheme(current: Accessor<ResolvedThemeView>, mode: Accessor<Mode>) {
  const textViews = new WeakMap<ResolvedThemeView, ResolvedThemeView["text"]>()
  return {
    get hue() {
      return current().hue
    },
    get categorical() {
      return current().categorical
    },
    get text() {
      const view = current()
      const cached = textViews.get(view)
      if (cached) return cached
      const focused = readableForeground(view.text.action.primary.focused, view.background.action.primary.focused)
      const text = focused === view.text.action.primary.focused
        ? view.text
        : {
            ...view.text,
            action: {
              ...view.text.action,
              primary: { ...view.text.action.primary, focused },
            },
          }
      textViews.set(view, text)
      return text
    },
    get background() {
      return current().background
    },
    get border() {
      return current().border
    },
    get scrollbar() {
      return current().scrollbar
    },
    get diff() {
      return current().diff
    },
    get syntax() {
      return current().syntax
    },
    get markdown() {
      return current().markdown
    },
    source: (color: RGBA) => current().source(color),
    increase: (color: RGBA, amount = 1) => current().increase(color, amount),
    decrease: (color: RGBA, amount = 1) => current().decrease(color, amount),
    raise: (color: RGBA) => (mode() === "light" ? current().increase(color) : current().decrease(color)),
  }
}

export type ComponentTheme = ReturnType<typeof createComponentTheme>

export function readableForeground(preferred: RGBA, background: RGBA): RGBA {
  if (background.a < 1) return preferred
  const fill = luminance(background)
  if (preferred.a === 1) {
    const ink = luminance(preferred)
    if ((Math.max(fill, ink) + 0.05) / (Math.min(fill, ink) + 0.05) >= 4.5) return preferred
  }
  return (fill + 0.05) / 0.05 >= 1.05 / (fill + 0.05)
    ? RGBA.fromInts(0, 0, 0)
    : RGBA.fromInts(255, 255, 255)
}

function luminance(color: RGBA) {
  const linear = (value: number) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b)
}
