import { Show } from "solid-js"
import { useTheme } from "../context/theme"
import { useConfig } from "../config"
import type { JSX } from "@opentui/solid"
import type { RGBA } from "@opentui/core"
import { registerYCodingSpinner } from "./register-spinner"
import { SPINNER_FRAMES } from "./spinner-frames"

export { SPINNER_FRAMES } from "./spinner-frames"
export const DOT_TRAIL_FRAMES = ["..●", ".●.", "●.."]

registerYCodingSpinner()

export function Spinner(props: { children?: JSX.Element; color?: RGBA; frames?: string[]; interval?: number }) {
  const { themeV2 } = useTheme()
  const config = useConfig().data
  const color = () => props.color ?? themeV2.text.subdued
  return (
    <Show
      when={config.animations ?? true}
      fallback={<text fg={color()}>{props.children ? <>⋯ {props.children}</> : "⋯"}</text>}
    >
      <box flexDirection="row" gap={1}>
        <spinner frames={props.frames ?? SPINNER_FRAMES} interval={props.interval ?? 80} color={color()} />
        <Show when={props.children}>
          <text fg={color()}>{props.children}</text>
        </Show>
      </box>
    </Show>
  )
}
