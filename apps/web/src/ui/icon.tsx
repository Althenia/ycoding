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
  | "chevron-right"
  | "chevron-down"
  | "chat"
  | "activity"
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
  "chevron-right": ["M9 6l6 6-6 6"],
  "chevron-down": ["M6 9l6 6 6-6"],
  chat: ["M4 5h16v11H9l-5 4z"],
  activity: ["M3 13h4l2.5-7 4 14L16 13h5"],
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
