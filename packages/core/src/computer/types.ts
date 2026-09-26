import { Schema } from "effect"

export interface Capability {
  readonly platform: string
  readonly application: string
  readonly identity: {
    readonly kind: string
    readonly value: string
  }
  readonly operations: ReadonlyArray<string>
}

export interface Status {
  readonly platform: string
  readonly state: "supported" | "unsupported"
  readonly capabilities: ReadonlyArray<Capability>
}

export interface WindowInfo {
  readonly window_id: number
  readonly title: string
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  readonly on_screen: boolean
}

export interface AppInfo {
  readonly bundle_id: string
  readonly pid: number
  readonly name: string
  readonly is_active: boolean
  readonly is_hidden: boolean
  readonly windows: ReadonlyArray<WindowInfo>
}

export interface BrowserWindowInfo {
  readonly window_id: string
  readonly index: number
  readonly revision: string
  readonly tabs: ReadonlyArray<{ readonly index: number; readonly title: string; readonly url: string; readonly active: boolean }>
}

export interface ComputerFrame {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export interface AgentDisplay {
  readonly id: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type NativeSuccess<Action extends string = string> = {
  readonly status: "ok"
  readonly action: Action
  readonly revision: string
  readonly accessible?: boolean
  readonly effect?: "changed" | "unchanged" | "unverified"
  readonly elements?: ReadonlyArray<{
    readonly path: ReadonlyArray<number>
    readonly role: string
    readonly label: string
    readonly frame: readonly [number, number, number, number]
    readonly actions: ReadonlyArray<"press" | "confirm" | "increment" | "decrement" | "show_menu">
    readonly enabled: boolean
    readonly focused: boolean
    readonly value?: string
  }>
  readonly image?: string
  readonly width?: number
  readonly height?: number
  readonly scale?: number
  readonly apps?: ReadonlyArray<AppInfo>
  readonly pid?: number
  readonly windows?: ReadonlyArray<WindowInfo | BrowserWindowInfo>
  readonly browserWindows?: ReadonlyArray<BrowserWindowInfo>
  readonly exited?: boolean
  readonly tabIndex?: number
  readonly value?: string
  readonly truncated?: boolean
  readonly display?: AgentDisplay
  readonly originalFrame?: ComputerFrame
}

export class NativeError extends Schema.TaggedErrorClass<NativeError>()("Computer.NativeError", {
  code: Schema.Literals([
    "unsupported_platform",
    "helper_unavailable",
    "invalid_request",
    "invalid_response",
    "app_not_running",
    "automation_denied",
    "accessibility_denied",
    "screen_recording_denied",
    "target_not_found",
    "stale_revision",
    "target_conflict",
    "native_failure",
    "unknown_outcome",
    "background_unavailable",
    "focus_restore_failed",
    "inspector_close_failed",
    "quit_pending",
  ]),
  message: Schema.String,
  outcome: Schema.Literals(["not_started", "unknown"]).pipe(Schema.optional),
}) {}
