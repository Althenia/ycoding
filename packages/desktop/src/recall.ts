import { recallVisible, type RecallEntry } from "@ycoding-ai/client/cue-recall"
import { lifecycleVisible, type LifecycleEntry } from "@ycoding-ai/client/lifecycle"
import type { Messages } from "./contract"

export type TranscriptRecord =
  | { readonly kind: "recall"; readonly id: string; readonly created: number; readonly entry: RecallEntry }
  | { readonly kind: "lifecycle"; readonly id: string; readonly created: number; readonly entry: LifecycleEntry }

export function transcriptRecords(recall: readonly RecallEntry[], lifecycle: readonly LifecycleEntry[]): readonly TranscriptRecord[] {
  return [
    ...recall.filter(recallVisible).map((entry) => ({ kind: "recall" as const, id: entry.id, created: entry.created, entry })),
    ...lifecycle.filter(lifecycleVisible).map((entry) => ({ kind: "lifecycle" as const, id: entry.id, created: entry.created, entry })),
  ].toSorted((a, b) => a.created - b.created || a.id.localeCompare(b.id))
}

export function recordPlacements(turns: readonly Messages[number][], records: readonly TranscriptRecord[]) {
  const before = new Map<string, readonly TranscriptRecord[]>()
  const tail: TranscriptRecord[] = []
  records.forEach((record) => {
    const next = turns.find((turn) => turn.time.created > record.created)
    if (next === undefined) return void tail.push(record)
    before.set(next.id, [...(before.get(next.id) ?? []), record])
  })
  return { before, tail }
}
