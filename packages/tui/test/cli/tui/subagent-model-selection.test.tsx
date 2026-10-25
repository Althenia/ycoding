/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { onMount } from "solid-js"
import { ClientProvider } from "../../../src/context/client"
import { DataProvider, useData } from "../../../src/context/data"
import { ConfigProvider } from "../../../src/config"
import { ThemeProvider } from "../../../src/context/theme"
import { SubagentMetadata, formatSubagentModel } from "../../../src/routes/session/composer/subagents-tab"
import { createApi, createEventStream, createFetch, directory, json } from "../../fixture/tui-client"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

test("a child model selection updates the displayed task without opening the child", async () => {
  const events = createEventStream()
  const original = { providerID: "openai", id: "original", variant: "high" }
  const target = { providerID: "openai", id: "gpt-6.1-sol-ultrafast", variant: "high" }
  const task = { sessionID: "ses_child", parentID: "ses_parent", agent: "build", description: "Task", model: original, background: true, state: "running", revision: 1, time: { created: 1, updated: 1 } }
  const calls = createFetch(url => {
    if (url.pathname === "/api/event") return events.connect()
    if (url.pathname === "/api/session/ses_parent/subagent") return json({ data: [task], summary: { total: 1, active: 1, running: 1, waiting: 0 }, cursor: {} })
    return undefined
  })
  function Display() {
    const data = useData()
    onMount(() => { void data.session.subagent.sync("ses_parent") })
    return <SubagentMetadata width={110} model={formatSubagentModel(data.session.subagent.page("ses_parent")?.data[0]?.model)} status="Running" />
  }
  const app = await testRender(() => <TestTuiContexts><ConfigProvider config={createTuiResolvedConfig()}><ThemeProvider mode="dark" source={{ discover: () => Promise.resolve({}) }}><ClientProvider api={createApi(calls.fetch)}><DataProvider><Display /></DataProvider></ClientProvider></ThemeProvider></ConfigProvider></TestTuiContexts>, { width: 110, height: 3 })
  app.renderer.start()
  try {
    await app.waitForFrame(frame => frame.includes("openai/original#high"))
    events.emit({ id: "evt_child_selection", type: "session.model.selected", created: 2, location: { directory }, durable: { aggregateID: "ses_child", seq: 2, version: 1 }, data: { sessionID: "ses_child", model: target } })
    await app.waitForFrame(frame => frame.includes("openai/gpt-6.1-sol-ultrafast#high"))
    expect(app.captureCharFrame()).not.toContain("openai/original#high")
  } finally { app.renderer.destroy() }
})
