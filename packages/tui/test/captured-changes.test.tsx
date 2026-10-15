/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { ClientProvider } from "../src/context/client"
import { DataProvider } from "../src/context/data"
import { createCapturedChanges } from "../src/routes/session/captured-changes"
import { createApi, createEventStream, createFetch, capturedGroup, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"

async function mount() {
  const [selection, select] = createSignal("ses_first")
  const [revision, revise] = createSignal("first")
  const events = createEventStream()
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  const failures = new Set<string>()
  const requests: string[] = []
  const settled: string[] = []
  const transport = createFetch(async (url) => {
    if (!url.pathname.endsWith("/captured-changes")) return undefined
    const key = `${url.pathname.split("/")[3]}:${url.searchParams.get("cursor") ?? "start"}`
    requests.push(key)
    await gates.get(key)?.promise
    settled.push(key)
    if (failures.has(key)) return json({ code: "internal_error", message: "Read failed" }, { status: 500 })
    return json({
      data: [capturedGroup(`msg_${key}`, `${key}.ts`, "patch")],
      cursor: key.endsWith(":start") ? { next: "opaque" } : undefined,
    })
  }, events)
  let captured!: ReturnType<typeof createCapturedChanges>
  function Probe() {
    captured = createCapturedChanges({ sessionID: selection, revision, ready: () => true })
    return <text>{JSON.stringify(captured.state())}</text>
  }
  const app = await testRender(
    () => (
      <TestTuiContexts>
        <ClientProvider api={createApi(transport.fetch)}>
          <DataProvider>
            <Probe />
          </DataProvider>
        </ClientProvider>
      </TestTuiContexts>
    ),
    { width: 120, height: 8 },
  )
  app.renderer.start()
  return { app, captured: () => captured, select, revise, events, gates, failures, requests, settled }
}

test("reads every opaque page through the v5 peer and publishes one complete result", async () => {
  const fixture = await mount()
  const gate = Promise.withResolvers<void>()
  fixture.gates.set("ses_first:opaque", gate)
  try {
    await fixture.app.waitFor(() => fixture.requests.includes("ses_first:opaque"))
    expect(fixture.captured().state()).toMatchObject({ groups: [], loading: true })
    gate.resolve()
    await fixture.app.waitFor(() => fixture.captured().state().groups.length === 2)
    expect(fixture.requests).toEqual(["ses_first:start", "ses_first:opaque"])
    expect(
      fixture
        .captured()
        .state()
        .groups.map((group) => group.path),
    ).toEqual(["ses_first:start.ts", "ses_first:opaque.ts"])
  } finally {
    gate.resolve()
    fixture.app.renderer.destroy()
  }
})

test("a failed later page exposes an error without publishing a partial total; retry restarts the projection", async () => {
  const fixture = await mount()
  fixture.failures.add("ses_first:opaque")
  try {
    await fixture.app.waitFor(() => !!fixture.captured().state().error)
    expect(fixture.captured().state()).toMatchObject({ groups: [], loading: false, error: "Read failed" })
    fixture.failures.clear()
    fixture.captured().retry()
    await fixture.app.waitFor(() => fixture.captured().state().groups.length === 2)
    expect(fixture.requests).toEqual(["ses_first:start", "ses_first:opaque", "ses_first:start", "ses_first:opaque"])
  } finally {
    fixture.app.renderer.destroy()
  }
})

test("selection changes reject obsolete pages and disposal stops further page reads", async () => {
  const fixture = await mount()
  const gate = Promise.withResolvers<void>()
  fixture.gates.set("ses_first:start", gate)
  try {
    await fixture.app.waitFor(() => fixture.requests.includes("ses_first:start"))
    fixture.select("ses_second")
    await fixture.app.waitFor(() =>
      fixture
        .captured()
        .state()
        .groups.some((group) => group.path === "ses_second:opaque.ts"),
    )
    gate.resolve()
    await fixture.app.waitFor(() => fixture.settled.includes("ses_first:start"))
    expect(fixture.requests).not.toContain("ses_first:opaque")
    expect(
      fixture
        .captured()
        .state()
        .groups.every((group) => group.path.startsWith("ses_second")),
    ).toBe(true)
  } finally {
    gate.resolve()
    fixture.app.renderer.destroy()
  }
})

test("duplicate invalidations coalesce while a read is pending and reconnect restarts from the first page", async () => {
  const fixture = await mount()
  try {
    await fixture.app.waitFor(() => fixture.captured().state().groups.length === 2)
    const gate = Promise.withResolvers<void>()
    fixture.gates.set("ses_first:start", gate)
    fixture.captured().retry()
    await fixture.app.waitFor(() => fixture.requests.length === 3)
    fixture.captured().retry()
    fixture.revise("new")
    expect(fixture.requests).toHaveLength(3)
    gate.resolve()
    await fixture.app.waitFor(() => fixture.requests.length === 6 && !fixture.captured().state().loading)
    fixture.events.disconnect()
    await fixture.app.waitFor(() => fixture.requests.length === 8 && !fixture.captured().state().loading, {
      maxPasses: 200,
    })
    expect(fixture.requests.slice(-2)).toEqual(["ses_first:start", "ses_first:opaque"])
  } finally {
    fixture.gates.forEach((gate) => gate.resolve())
    fixture.app.renderer.destroy()
  }
})
