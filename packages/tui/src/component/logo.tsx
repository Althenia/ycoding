import { For } from "solid-js"

const MINT = "#67D7A4"
const LANDING_MARK = ["██        ██", "██        ██", "██▄▄▄   ▄▄██", "██▀▀▀   ▀▀██", "██        ██", "     ██     "]
const HEADER_MARK = ["▌▐"]

export function BrandMark(props: { width?: number; height?: number }) {
  const width = props.width ?? 12
  const height = props.height ?? 6
  const rows = width === 2 && height === 1 ? HEADER_MARK : LANDING_MARK
  return (
    <box width={width} height={height} flexShrink={0} flexDirection="column">
      <For each={rows}>{(row) => <text fg={MINT} wrapMode="none">{row}</text>}</For>
    </box>
  )
}
