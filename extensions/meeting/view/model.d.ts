import type { MeetingView } from "../src/types"

declare const source: string
export default source

export type ViewInput = {
  meeting?: Partial<NonNullable<MeetingView["meeting"]>>
  health?: Partial<MeetingView["health"]>
  audio?: Partial<MeetingView["audio"]>
  analysis?: Partial<MeetingView["analysis"]>
  summary?: Partial<NonNullable<MeetingView["summary"]>>
}

export function readCredentials(hash: string): { key: string; owner?: string } | undefined
export function encodeModelChoice(providerID: string, id: string): string
export function decodeModelChoice(value: string): { providerID: string; id: string } | undefined
export function resolveAskSelection(
  selected: "inherit" | { providerID: string; id: string; variant?: string },
  loaded: unknown,
): "inherit" | { providerID: string; id: string; variant?: string; profile?: string }
export function ownerModelStatus(model?: { enabled?: unknown; status?: unknown }): string
export function ownerBindingStatus(
  binding?: { server?: string; write?: string; writeCapability?: string },
  servers?: Array<{ name?: string; status?: string }>,
): string
export function formatSeconds(value: unknown): string
export function describeView(view: ViewInput): {
  phase: "setup" | "live" | "finalizing" | "recovery" | "review"
  status: string
  tone: string
  health: string
  canStop: boolean
  canRetry: boolean
  notice: string
  buffered: string
  processed: string
  backlog: string
  lag: string
  remote: string
  microphone: string
}
export function questionError(error: string): string
