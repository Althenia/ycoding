import { expect, test } from "bun:test"
import { handleSelectionKey } from "../../src/util/selection"

function harness(input: { selected?: string; platform: NodeJS.Platform; event: Record<string, unknown> }) {
  const writes: string[] = []
  let cleared = 0
  let prevented = 0
  let stopped = 0
  const selection = input.selected
    ? {
        getSelectedText: () => input.selected!,
        selectedRenderables: [],
      }
    : null

  handleSelectionKey(
    {
      getSelection: () => selection,
      clearSelection: () => cleared++,
      currentFocusedRenderable: null,
    },
    { show: () => {}, error: () => {} },
    {
      name: String(input.event.name ?? ""),
      ctrl: Boolean(input.event.ctrl),
      meta: Boolean(input.event.meta),
      super: Boolean(input.event.super),
      preventDefault: () => prevented++,
      stopPropagation: () => stopped++,
    },
    { write: async (text) => void writes.push(text) },
    input.platform,
  )

  return { writes, cleared, prevented, stopped }
}

test("Cmd+C copies an active selection on macOS", async () => {
  const result = harness({ selected: "selected", platform: "darwin", event: { name: "c", meta: true } })
  await Bun.sleep(0)
  expect(result).toEqual({ writes: ["selected"], cleared: 1, prevented: 1, stopped: 1 })
})

test("Ctrl+C copies an active selection outside macOS", async () => {
  const result = harness({ selected: "selected", platform: "linux", event: { name: "c", ctrl: true } })
  await Bun.sleep(0)
  expect(result).toEqual({ writes: ["selected"], cleared: 1, prevented: 1, stopped: 1 })
})

test("Ctrl+C remains available to normal commands on macOS", async () => {
  const result = harness({ selected: "selected", platform: "darwin", event: { name: "c", ctrl: true } })
  await Bun.sleep(0)
  expect(result).toEqual({ writes: [], cleared: 1, prevented: 0, stopped: 0 })
})

test("Escape clears an active selection without copying", async () => {
  const result = harness({ selected: "selected", platform: "linux", event: { name: "escape" } })
  await Bun.sleep(0)
  expect(result).toEqual({ writes: [], cleared: 1, prevented: 1, stopped: 1 })
})

test("selection handling ignores copy keys when no selection exists", async () => {
  const result = harness({ platform: "linux", event: { name: "c", ctrl: true } })
  await Bun.sleep(0)
  expect(result).toEqual({ writes: [], cleared: 0, prevented: 0, stopped: 0 })
})
