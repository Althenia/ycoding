import { expect, test } from "bun:test"
import { parseAgentMessage, type RemoteResponse } from "@ycoding-ai/remote"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RemoteAgent, type ConnectionInput, type RelayConnection } from "../src/remote-bridge"
import { createLocalServer } from "../src/remote-local"
import { createSession, password, startServer } from "./remote-harness"

test("lists existing backend Locations and creates, adopts, lists, and prompts a root Session", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ycoding-remote-workspace-"))
  const secondDirectory = await mkdtemp(join(tmpdir(), "ycoding-remote-workspace-second-"))
  const server = await startServer(directory)
  const sessionID = "ses_remote_workspace_created"
  const existingID = "ses_remote_workspace_existing"
  let deliver: ((frame: unknown) => void) | undefined
  const responses: RemoteResponse[] = []
  const bridge = new RemoteAgent({
    relayURL: "https://relay.example",
    local: createLocalServer({ url: server.base, auth: { type: "basic", username: "ycoding", password } }),
    credentials: async () => ({ accessToken: "workspace-token", accessExpiresAt: Date.now() + 600_000 }),
    createConnection: (input: ConnectionInput): RelayConnection => ({
      connect: async () => input.onOpen(),
      send: async (raw) => {
        const parsed = parseAgentMessage(raw)
        if (parsed.ok && parsed.value.type === "response") responses.push(parsed.value)
      },
      onMessage: (handler) => {
        deliver = handler
      },
      disconnect: async () => undefined,
    }),
    refreshIntervalMs: 3_600_000,
  })

  const call = async (id: string, operation: string, input?: Record<string, unknown>, targetSessionID?: string) => {
    deliver?.({
      type: "request",
      id,
      operation,
      ...(targetSessionID === undefined ? {} : { sessionID: targetSessionID }),
      ...(input === undefined ? {} : { input }),
    })
    const deadline = Date.now() + 10_000
    for (;;) {
      const response = responses.find((frame) => frame.id === id)
      if (response !== undefined) return response
      if (Date.now() >= deadline) throw new Error(`remote ${operation} did not settle`)
      await Bun.sleep(10)
    }
  }

  const value = (response: RemoteResponse) => {
    if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
    expect(response.ok).toBe(true)
    return response.value
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)

  const record = (value: unknown): Record<string, unknown> => {
    if (!isRecord(value)) throw new Error("expected an object")
    return value
  }

  const array = (value: unknown): readonly unknown[] => {
    if (!Array.isArray(value)) throw new Error("expected an array")
    return value
  }

  try {
    await createSession(server, existingID, directory)
    await createSession(server, "ses_remote_workspace_second", secondDirectory)
    await bridge.connect()

    const inventory = array(record(value(await call("workspace_list", "workspace.list"))).data)
    expect(inventory.map((item) => record(item).directory)).toContain(directory)
    expect(inventory.map((item) => record(item).directory)).toContain(secondDirectory)
    expect(inventory.every((item) => typeof record(item).id === "string" && typeof record(item).projectID === "string")).toBe(true)
    expect(inventory.map((item) => record(item).directory)).not.toContain("/")

    const selected = inventory.find((item) => record(item).directory === directory)
    if (selected === undefined) throw new Error("existing Session Location was not inventoried")
    const workspace = record(selected).id
    const projectID = record(selected).projectID
    if (typeof workspace !== "string" || typeof projectID !== "string") throw new Error("workspace identity was incomplete")
    const createdBody = record(value(await call("create", "session.create", { id: sessionID, workspace })))
    const created = record(createdBody.data)
    expect(created).toMatchObject({ id: sessionID, projectID, location: { directory } })
    expect(created.parentID).toBeUndefined()

    const adopted = value(await call("create_retry", "session.create", { id: sessionID, workspace }))
    expect(adopted).toEqual(createdBody)

    const secondWorkspace = inventory.find((item) => record(item).directory === secondDirectory)
    if (secondWorkspace === undefined) throw new Error("second Session Location was not inventoried")
    const secondWorkspaceID = record(secondWorkspace).id
    if (typeof secondWorkspaceID !== "string") throw new Error("second workspace identifier was missing")
    const mismatch = await call("create_mismatch", "session.create", { id: sessionID, workspace: secondWorkspaceID })
    expect(mismatch).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    await rm(secondDirectory, { recursive: true, force: true })
    const missing = await call("create_missing", "session.create", {
      id: "ses_remote_workspace_missing",
      workspace: secondWorkspaceID,
    })
    expect(missing).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    const unknown = await call("create_unknown", "session.create", { id: "ses_remote_workspace_unknown", workspace: "wsp_unknown" })
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_message" } })
    const injected = await call("create_injected", "session.create", { id: "ses_remote_workspace_injected", workspace: `/tmp/${workspace}` })
    expect(injected).toMatchObject({ ok: false, error: { code: "invalid_message" } })

    const listed = array(record(value(await call("session_list", "session.list"))).data)
    expect(listed.filter((session) => record(session).id === sessionID)).toHaveLength(1)
    expect(listed.map((session) => record(session).id)).not.toContain("ses_remote_workspace_missing")
    expect(listed.map((session) => record(session).id)).not.toContain("ses_remote_workspace_unknown")
    expect(listed.map((session) => record(session).id)).not.toContain("ses_remote_workspace_injected")
    const active = record(value(await call("active", "session.active")))
    expect(record(active.data)[sessionID]).toBeUndefined()

    const prompt = record(record(value(
      await call(
        "prompt",
        "session.prompt",
        { id: "msg_remote_workspace_prompt", text: "hello", resume: false },
        sessionID,
      ),
    )).data)
    expect(prompt.id).toBe("msg_remote_workspace_prompt")
    const current = await server.request(`/api/session/${sessionID}`)
    expect(current.status).toBe(200)
  } finally {
    await bridge.close()
    await server.close()
    await rm(directory, { recursive: true, force: true })
    await rm(secondDirectory, { recursive: true, force: true })
  }
}, 60_000)
