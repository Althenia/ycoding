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
  | "team"
  | "key"
  | "plus"
  | "minus"
  | "maximize"
  | "crosshair"
  | "arrow-left"
  | "arrow-right"
  | "office"
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
  | "pin"
  | "plug"
  | "server"
  | "git-fork"
  | "git-branch"
  | "undo"
  | "redo"
  | "archive"
  | "download"
  | "globe"
  | "folder-plus"
  | "help"
  | "bookmark"
  | "list"

const paths: Record<IconName, readonly string[]> = {
  terminal: ["M4 7l4 5-4 5", "M12 17h8"],
  package: ["M12 3l8 4.5v9L12 21l-8-4.5v-9z", "M12 12l8-4.5", "M12 12v9", "M12 12L4 7.5"],
  target: ["M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"],
  shield: ["M12 3l7 3v6c0 4-3 7-7 9-4-2-7-5-7-9V6z", "M9 12l2 2 4-4"],
  bell: ["M6 9a6 6 0 1 1 12 0c0 4 2 5 2 5H4s2-1 2-5z", "M10 19a2 2 0 0 0 4 0"],
  devices: ["M3 5h10v10H3z", "M15 8h6v11h-6z", "M6 18h4"],
  menu: ["M4 7h16", "M4 12h16", "M4 17h16"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  sun: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M12 2v2", "M12 20v2", "M2 12h2", "M20 12h2", "M5 5l1.5 1.5", "M17.5 17.5L19 19", "M19 5l-1.5 1.5", "M6.5 17.5L5 19"],
  moon: ["M20.35 14.15A8.5 8.5 0 1 1 9.85 3.65a7 7 0 0 0 10.5 10.5z"],
  monitor: ["M3 4.5h18v11H3z", "M9 19.5h6", "M12 15.5v4"],
  search: ["M10.5 3.5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M16 16L20.5 20.5"],
  copy: ["M8.5 9h11v11H8.5z", "M4.5 15V4h11"],
  check: ["M5 12.5l4.5 4.5L19 7"],
  "check-all": ["M2 11.75l4.5 4.5L15 7.25", "M11 15.75l1 1L22 7.25"],
  "chevron-right": ["M9 6l6 6-6 6"],
  "chevron-down": ["M6 9l6 6 6-6"],
  chat: ["M4 4.5h16v11H9l-5 4z"],
  sessions: ["M4 7h16", "M4 12h16", "M4 17h10"],
  settings: ["M3.75 7h10", "M17.75 7h2", "M3.75 12h4", "M11.75 12h8", "M3.75 17h12", "M19.75 17h.5", "M15.75 5v4", "M9.75 10v4", "M17.75 15v4"],
  send: ["M4 12l16-8-6 16-3-7z"],
  stop: ["M7 7h10v10H7z"],
  alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17h.01"],
  refresh: ["M20 12a8 8 0 1 1-2.5-5.8", "M20 4v4h-4"],
  external: ["M14 4h6v6", "M20 4l-8 8", "M18 14v6H4V6h6"],
  file: ["M6 3h8l4 4v14H6z", "M14 3v4h4"],
  team: ["M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z", "M3 19c0-3 2.7-5 6-5s6 2 6 5", "M16 6.2a2.8 2.8 0 0 1 0 5.2", "M17.5 14.3c2 .5 3.5 2 3.5 4.7"],
  user: ["M12 3.5a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M4 20.5c0-4 3.6-6 8-6s8 2 8 6"],
  key: ["M15.5 6a5 5 0 1 1-4.6 7L9.5 14.5H7L5.5 16v2H3.5v-2l7.4-7.4A5 5 0 0 1 15.5 6z", "M17 9h.01"],
  plus: ["M12 5v14", "M5 12h14"],
  minus: ["M5 12h14"],
  maximize: ["M4 9V4h5", "M20 9V4h-5", "M4 15v5h5", "M20 15v5h-5"],
  crosshair: ["M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", "M12 3v4", "M12 17v4", "M3 12h4", "M17 12h4"],
  "arrow-left": ["M19 12H5", "M11 6l-6 6 6 6"],
  "arrow-right": ["M5 12h14", "M13 6l6 6-6 6"],
  office: ["M5 20.5V5.5l7-2 7 2v15", "M3 20.5h18", "M9 8.5h2", "M13 8.5h2", "M9 12.5h2", "M13 12.5h2", "M10 20.5v-4h4v4"],
  "arrow-up": ["M12 19V5", "M6 11l6-6 6 6"],
  folder: ["M3 5.5h6l2 2h10v11H3z"],
  sparkles: ["M10.5 3.75l1.8 4.2L16.5 9.75l-4.2 1.8L10.5 15.75l-1.8-4.2L4.5 9.75l4.2-1.8z", "M17 15.25l.8 1.7 1.7 .8-1.7 .8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z"],
  cpu: ["M7 7h10v10H7z", "M10 10h4v4h-4z", "M9 3v4", "M15 3v4", "M9 17v4", "M15 17v4", "M3 9h4", "M3 15h4", "M17 9h4", "M17 15h4"],
  at: ["M16 12a4 4 0 1 0-1.2 2.8", "M16 8v5.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.6 7.2"],
  hash: ["M5.5 9h14", "M4.5 15h14", "M10.5 4L8.5 20", "M16.5 4l-2 16"],
  slash: ["M16 4L8 20"],
  pin: ["M16 3l5 5-4 1-4 4-1 4-5-5 4-1 4-4z", "M9 15l-6 6"],
  usage: ["M4 16a8 8 0 1 1 16 0", "M12 16l4-5", "M12 16h.01"],
  zap: ["M13.5 3L4.5 14h7l-1 7 9-11h-7z"],
  reset: ["M3.7 5v5h5", "M4.9 15a8 8 0 1 0 1.6-8.4L3.7 10"],
  "arrow-down": ["M12 5v14", "M6 13l6 6 6-6"],
  steer: ["M5 4.5v7a4 4 0 0 0 4 4h10", "M15 11.5l4 4-4 4"],
  queue: ["M4 5h12", "M4 10h12", "M4 15h7", "M17 12v7", "M14 16l3 3 3-3"],
  "panel-left": ["M4 5h16v14H4z", "M9.5 5v14"],
  plug: ["M9 3v5", "M15 3v5", "M6 8h12v3a6 6 0 0 1-12 0z", "M12 17v4"],
  server: ["M4 4h16v7H4z", "M4 13h16v7H4z", "M8 7.5h.01", "M8 16.5h.01"],
  "git-fork": ["M6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "M18 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "M12 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4z", "M6 7v2a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7", "M12 12v5"],
  "git-branch": ["M6 3v12", "M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6z", "M18 9a9 9 0 0 1-9 9"],
  undo: ["M9 14L4 9l5-5", "M4 9h10.5a5.5 5.5 0 0 1 0 11H11"],
  redo: ["M15 14l5-5-5-5", "M20 9H9.5a5.5 5.5 0 0 0 0 11H13"],
  archive: ["M3 4h18v4H3z", "M5 8v12h14V8", "M10 12h4"],
  download: ["M12 3v12", "M7 10l5 5 5-5", "M5 21h14"],
  globe: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M3 12h18", "M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9", "M12 3c-2.5 2.7-3.8 5.7-3.8 9s1.3 6.3 3.8 9"],
  "folder-plus": ["M3 5.5h6l2 2h10v11H3z", "M12 10.5v5", "M9.5 13h5"],
  help: ["M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z", "M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7", "M12 17h.01"],
  bookmark: ["M6 3h12v18l-6-4-6 4z"],
  list: ["M9 6h11", "M9 12h11", "M9 18h11", "M4 6h.01", "M4 12h.01", "M4 18h.01"],
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
