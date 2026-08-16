/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ToastProvider, useToast } from "../../../src/ui/toast"

test("shows structured API error messages instead of an unknown-error fallback", async () => {
  let toast!: ReturnType<typeof useToast>

  function Probe() {
    toast = useToast()
    onMount(() => toast.error({ data: { message: "History request failed" } }))
    return <box />
  }

  const app = await testRender(() => (
    <ToastProvider>
      <Probe />
    </ToastProvider>
  ))

  try {
    await app.waitFor(() => toast.currentToast !== null)
    expect(toast.currentToast?.message).toBe("History request failed")
  } finally {
    app.renderer.destroy()
  }
})
