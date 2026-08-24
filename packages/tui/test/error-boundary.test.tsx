/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ExitProvider } from "../src/context/exit"
import { FatalCrashGuard } from "../src/component/error-component"

// The crash screen (ErrorComponent) is the ErrorBoundary fallback. If it throws while rendering
// (for example the renderer's native text-buffer allocator is exhausted, which is exactly what a
// "Failed to create TextBuffer" crash reports), Solid does not catch a fallback's own error, so the
// TUI freezes with no way out. FatalCrashGuard must convert that into a clean exit with the original
// crash so the process restores the terminal and surfaces the error on stderr instead of hanging.
test("FatalCrashGuard exits with the original crash when the crash screen fails to render", async () => {
  const exits: unknown[] = []
  const original = new Error("original crash")

  function Boom(): never {
    throw new Error("crash screen render failed")
  }

  const app = await testRender(() => (
    <ExitProvider exit={(reason) => exits.push(reason)}>
      <FatalCrashGuard error={original}>
        <Boom />
      </FatalCrashGuard>
    </ExitProvider>
  ))
  try {
    await Bun.sleep(5)
    expect(exits).toEqual([original])
  } finally {
    app.renderer.destroy()
  }
})

test("FatalCrashGuard renders the crash screen normally when it does not throw", async () => {
  const exits: unknown[] = []

  const app = await testRender(() => (
    <ExitProvider exit={(reason) => exits.push(reason)}>
      <FatalCrashGuard error={new Error("original crash")}>
        <text>crash screen</text>
      </FatalCrashGuard>
    </ExitProvider>
  ))
  try {
    await app.renderOnce()
    expect(exits).toEqual([])
    expect(app.captureCharFrame()).toContain("crash screen")
  } finally {
    app.renderer.destroy()
  }
})
