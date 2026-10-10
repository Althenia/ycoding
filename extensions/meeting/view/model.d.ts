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

export function readViewKey(hash: string): string | undefined
export function formatSeconds(value: unknown): string
export function pairingState(
  pairing: { code: string; expiresAt: number } | undefined,
  now?: number,
): { status: "waiting" | "expired" | "unreported"; seconds: number | undefined }
export function describeView(view: ViewInput): {
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
