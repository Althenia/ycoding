import type { JSX } from "solid-js"

export type IconName =
  | "terminal"
  | "package"
  | "target"
  | "shield"
  | "bell"
  | "devices"
  | "menu"
  | "close"
  | "sun"
  | "moon"
  | "monitor"
  | "search"
  | "copy"
  | "check"
  | "check-all"
  | "chevron-right"
  | "chevron-down"
  | "chat"
  | "sessions"
  | "settings"
  | "send"
  | "stop"
  | "alert"
  | "refresh"
  | "external"
  | "file"
  | "user"
  | "key"
  | "plus"
  | "minus"
  | "maximize"
  | "crosshair"
  | "arrow-left"
  | "arrow-up"
  | "folder"
  | "sparkles"
  | "cpu"
  | "usage"
  | "zap"
  | "reset"
  | "arrow-down"
  | "steer"
  | "queue"
  | "panel-left"
  | "at"
  | "hash"
  | "slash"

const paths: Record<IconName, readonly string[]> = {
  terminal: ["M4 7l4 5-4 5", "M12 17h8"],
  package: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M12 12l8-4.5", "M12 12v9", "M12 12L4 7.5"],
  target: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  shield: ["M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z", "M9 12l2 2 4-4"],
  bell: ["M6 10a6 6 0 1 1 12 0c0 4 2 5 2 5H4s2-1 2-5z", "M10 20a2 2 0 0 0 4 0"],
  devices: ["M3 6h10v10H3z", "M15 9h6v11h-6z", "M6 19h4"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  sun: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M12 2v2", "M12 20v2", "M2 12h2", "M20 12h2", "M5 5l1.5 1.5", "M17.5 17.5L19 19", "M19 5l-1.5 1.5", "M6.5 17.5L5 19"],
  moon: ["M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"],
  monitor: ["M3 5h18v11H3z", "M9 20h6", "M12 16v4"],
  search: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M16.5 16.5L21 21"],
  copy: ["M9 9h11v11H9z", "M5 15V4h11"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  "check-all": ["M2 12.5l4.5 4.5L15 8", "M11 16.5l1 1L22 8"],
  "chevron-right": ["M9 6l6 6-6 6"],
  "chevron-down": ["M6 9l6 6 6-6"],
  chat: ["M4 5h16v11H9l-5 4z"],
  sessions: ["M4 6h16", "M4 11h16", "M4 16h10"],
  settings: ["M4 7h10", "M18 7h2", "M4 12h4", "M12 12h8", "M4 17h12", "M20 17h0.5", "M16 5v4", "M10 10v4", "M18 15v4"],
  send: ["M4 12l16-8-6 16-3-7z"],
  stop: ["M7 7h10v10H7z"],
  alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17h.01"],
  refresh: ["M20 12a8 8 0 1 1-2.5-5.8", "M20 4v4h-4"],
  external: ["M14 4h6v6", "M20 4l-8 8", "M18 14v6H4V6h6"],
  file: ["M6 3h8l4 4v14H6z", "M14 3v4h4"],
  user: ["M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M4 21c0-4 3.6-6 8-6s8 2 8 6"],
  key: ["M15 5a5 5 0 1 1-4.6 7L9 13.5H6.5L5 15v2H3v-2l7.4-7.4A5 5 0 0 1 15 5z", "M16.5 8h.01"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  maximize: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"],
  crosshair: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4"],
  "arrow-left": ["M19 12H5", "M11 6l-6 6 6 6"],
  "arrow-up": ["M12 19V5", "M6 11l6-6 6 6"],
  folder: ["M3 6h6l2 2h10v11H3z"],
  sparkles: ["M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8z", "M18.5 14.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z"],
  cpu: ["M7 7h10v10H7z", "M10 10h4v4h-4z", "M9 3v4", "M15 3v4", "M9 17v4", "M15 17v4", "M3 9h4", "M3 15h4", "M17 9h4", "M17 15h4"],
  at: ["M16 12a4 4 0 1 0-1.2 2.8", "M16 8v5.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.6 7.2"],
  hash: ["M5 9h14", "M4 15h14", "M10 4L8 20", "M16 4l-2 16"],
  slash: ["M16 4L8 20"],
  usage: ["M4 17a8 8 0 1 1 16 0", "M12 17l4-5", "M12 17h.01"],
  zap: ["M13 3L4 14h7l-1 7 9-11h-7z"],
  reset: ["M4 5v5h5", "M5.2 15a8 8 0 1 0 1.6-8.4L4 10"],
  "arrow-down": ["M12 5v14", "M6 13l6 6 6-6"],
  steer: ["M5 4v7a4 4 0 0 0 4 4h10", "M15 11l4 4-4 4"],
  queue: ["M4 6h12", "M4 11h12", "M4 16h7", "M17 13v7", "M14 17l3 3 3-3"],
  "panel-left": ["M4 5h16v14H4z", "M9.5 5v14"],
}

export function Icon(props: { readonly name: IconName; readonly size?: number; readonly class?: string }): JSX.Element {
  return (
    <svg
      class={props.class}
      width={props.size ?? 20}
      height={props.size ?? 20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      {paths[props.name].map((d) => (
        <path d={d} />
      ))}
    </svg>
  )
}
