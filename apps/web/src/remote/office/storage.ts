import { createSignal } from "solid-js"
import { browserStorage, readStored, writeStored, type StorageLike } from "../../lib/storage"
import { defaultOfficePreferences, readOfficePreferences } from "./preferences"
import type { OfficePreferences } from "./types"

export const OFFICE_PREFERENCES_KEY = "ycoding.office"
export const WORKSPACE_PRESENTATION_KEY = "ycoding.remote.presentation"

export type WorkspacePresentation = "conversation" | "office"

export function createOfficeSettings(storage: StorageLike | null | undefined = browserStorage()) {
  const [preferences, setPreferences] = createSignal(readOfficePreferences(readStored(storage, OFFICE_PREFERENCES_KEY, parseJson)))
  const [presentation, setPresentation] = createSignal<WorkspacePresentation>(
    readStored(storage, WORKSPACE_PRESENTATION_KEY, (raw) => (raw === "office" || raw === "conversation" ? raw : undefined)) ?? "conversation",
  )
  const [generation, setGeneration] = createSignal(0)
  const store = (next: OfficePreferences) => {
    setPreferences(next)
    writeStored(storage, OFFICE_PREFERENCES_KEY, JSON.stringify(next))
  }
  return {
    preferences,
    presentation,
    generation,
    present: (next: WorkspacePresentation) => {
      setPresentation(next)
      writeStored(storage, WORKSPACE_PRESENTATION_KEY, next)
    },
    update: (patch: Partial<Omit<OfficePreferences, "version">>) => store({ ...preferences(), ...patch }),
    reset: () => {
      store(defaultOfficePreferences)
      setGeneration((value) => value + 1)
    },
  }
}

export type OfficeSettingsStore = ReturnType<typeof createOfficeSettings>

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}
