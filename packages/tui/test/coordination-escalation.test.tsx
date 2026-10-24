/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { expect, test } from "bun:test"
import { ClientProvider, useClient } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { TestTuiContexts } from "./fixture/tui-environment"
import { createApi, createEventStream, createFetch, directory } from "./fixture/tui-client"

test("Project request escalation updates existing pending controls without duplicating them", async () => {
  const events = createEventStream()
  const transport = createFetch(() => undefined, events)
  let data!: ReturnType<typeof useData>
  let client!: ReturnType<typeof useClient>
  function Probe() {
    data = useData()
    client = useClient()
    return <box />
  }
  const app = await testRender(() => (
    <TestTuiContexts>
      <ClientProvider api={createApi(transport.fetch)}>
        <DataProvider>
          <Probe />
        </DataProvider>
      </ClientProvider>
    </TestTuiContexts>
  ))
  app.renderer.start()
  const reason = { reasons: [{ sessionID: "ses_master", reason: "Confirm the assignment boundary." }] }
  try {
    await app.waitFor(() => client.connection.status() === "connected")
    events.emit({
      id: "evt_pending_permission",
      created: 1,
      location: { directory },
      type: "permission.asked",
      data: {
        id: "per_1",
        sessionID: "ses_member",
        action: "read",
        resources: ["/repo/file"],
      },
    })
    events.emit({
      id: "evt_pending_review",
      created: 1,
      location: { directory },
      type: "guardrail.asked",
      data: {
        id: "grq_1",
        rootSessionID: "ses_member",
        sessionID: "ses_member",
        action: "read",
        resources: ["/repo/file"],
        ruleIDs: ["custom.review"],
        reason: "Review scope",
        standard: false,
      },
    })
    events.emit({
      id: "evt_pending_form",
      created: 1,
      location: { directory },
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "ses_member",
          title: "Select scope",
          fields: [{ key: "scope", type: "string", title: "Scope" }],
        },
      },
    })
    await app.waitFor(
      () =>
        data.session.permission.list("ses_member")?.length === 1 &&
        data.session.guardrail.list("ses_member").length === 1 &&
        data.session.form.list("ses_member")?.length === 1,
    )
    for (const [kind, requestID] of [
      ["permission", "per_1"],
      ["review", "grq_1"],
      ["question", "frm_1"],
    ] as const) {
      events.emit({
        id: `evt_escalated_${kind}`,
        created: 2,
        location: { directory },
        type: "coordination.request.escalated",
        data: {
          sessionID: "ses_member",
          rootSessionID: "ses_member",
          requestID,
          kind,
          coordinationEscalation: reason,
        },
      })
    }
    await app.renderOnce()
    await app
      .waitFor(() => data.session.permission.list("ses_member")?.[0]?.coordinationEscalation !== undefined)
      .catch((cause) => {
        throw new Error("Escalation event did not update the pending permission", { cause })
      })
    expect(data.session.permission.list("ses_member")).toHaveLength(1)
    expect(data.session.guardrail.list("ses_member")).toHaveLength(1)
    expect(data.session.form.list("ses_member")).toHaveLength(1)
    expect(data.session.permission.list("ses_member")?.[0]?.coordinationEscalation).toEqual(reason)
    expect(data.session.guardrail.list("ses_member")[0]?.coordinationEscalation).toEqual(reason)
    expect(data.session.form.list("ses_member")?.[0]?.coordinationEscalation).toEqual(reason)
  } finally {
    app.renderer.destroy()
  }
})
