import type { OfficePreferences, OfficeSnapshot } from "./types"

export type OfficeFrameInput = { readonly snapshot: OfficeSnapshot; readonly preferences: OfficePreferences; readonly systemReduced: boolean }

export function createOfficeMailbox(initial: OfficeFrameInput) {
  let value = initial
  let revision = 0
  return {
    read: () => value,
    revision: () => revision,
    update: (next: OfficeFrameInput) => { value = next; revision++ },
  }
}
export type OfficeMailbox = ReturnType<typeof createOfficeMailbox>
