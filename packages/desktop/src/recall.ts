import { recallVisible, type RecallEntry } from "@ycoding-ai/client/cue-recall"
import type { Messages } from "./contract"

export function recallPlacements(turns: readonly Messages[number][], entries: readonly RecallEntry[]) {
  const before = new Map<string, readonly RecallEntry[]>()
  const tail: RecallEntry[] = []
  entries.filter(recallVisible).forEach((entry) => {
    const next = turns.find((turn) => turn.time.created > entry.created)
    if (next === undefined) return void tail.push(entry)
    before.set(next.id, [...(before.get(next.id) ?? []), entry])
  })
  return { before, tail }
}
