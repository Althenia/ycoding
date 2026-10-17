import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import type { ShellInfo } from "@ycoding-ai/client"
import { ClientProvider } from "../src/context/client"
import { DataProvider, useData } from "../src/context/data"
import { createApi, createEventStream, createFetch, directory, json } from "./fixture/tui-client"
import { TestTuiContexts } from "./fixture/tui-environment"

function shell(id: string, status: ShellInfo["status"] = "running"): ShellInfo {
  return { id, command: `command ${id}`, status, cwd: directory, shell: "bash", file: `/tmp/${id}`, metadata: {}, time: { started: 1 } }
}

async function setup(initial: ShellInfo[]) {
  const events = createEventStream()
  let response: () => Promise<Response> = async () => json({ location: { directory, project: { id: "proj_test", directory } }, data: initial })
  const calls = createFetch((url) => url.pathname === "/api/shell" ? response() : undefined, events)
  let data: ReturnType<typeof useData> | undefined
  function Probe() { data = useData(); return <box /> }
  const app = await testRender(() => <TestTuiContexts><ClientProvider api={createApi(calls.fetch)}><DataProvider><Probe /></DataProvider></ClientProvider></TestTuiContexts>)
  await data!.location.sync().catch((error) => { app.renderer.destroy(); throw error })
  await until(() => data !== undefined && data.shell.list().length === initial.length).catch((error) => { app.renderer.destroy(); throw error })
  return { app, events, data: () => data!, respond: (next: () => Promise<Response>) => { response = next } }
}

test("shell sync retains observed settled records, drops missing live records, and lets fetched identities override cached rows", async () => {
  const values = ["exited", "timeout", "memory-limit", "killed"].map((status) => shell(`sh_${status}`))
  const fixture = await setup([...values, shell("sh_missing_running"), shell("sh_missing_queued", "queued"), shell("sh_override")])
  try {
    for (const [index, status] of (["exited", "timeout", "memory-limit", "killed"] as const).entries()) {
      fixture.events.emit({ id: `evt_exit_${index}`, type: "shell.exited", location: { directory }, created: 100 + index, data: { id: values[index]!.id, status } })
    }
    await until(() => fixture.data().shell.get("sh_killed")?.status === "killed")
    const next = [{ ...shell("sh_override"), command: "fresh live record" }, shell("sh_new", "queued"), shell("sh_exited")]
    fixture.respond(async () => json({ location: { directory, project: { id: "proj_test", directory } }, data: next }))
    fixture.data().shell.invalidate()
    await fixture.data().shell.sync()
    expect(fixture.data().shell.list().map((value) => value.id).sort()).toEqual(["sh_exited", "sh_killed", "sh_memory-limit", "sh_new", "sh_override", "sh_timeout"])
    expect(fixture.data().shell.get("sh_override")).toMatchObject({ status: "running", command: "fresh live record" })
    expect(fixture.data().shell.get("sh_exited")?.time.completed).toBe(100)
    expect(fixture.data().shell.get("sh_missing_running")).toBeUndefined()
    expect(fixture.data().shell.get("sh_missing_queued")).toBeUndefined()
  } finally { fixture.app.renderer.destroy() }
})

test("exit during a gated live-list read cannot restore the observed terminal shell to running", async () => {
  const value = shell("sh_settled")
  const fixture = await setup([value])
  const pending = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  try {
    fixture.respond(() => { started.resolve(); return pending.promise })
    fixture.data().shell.invalidate()
    const sync = fixture.data().shell.sync()
    await started.promise
    fixture.events.emit({ id: "evt_inflight_exit", type: "shell.exited", location: { directory }, created: 100, data: { id: value.id, status: "exited", exit: 0 } })
    await until(() => fixture.data().shell.get(value.id)?.status === "exited")
    pending.resolve(json({ location: { directory, project: { id: "proj_test", directory } }, data: [value] }))
    await sync
    expect(fixture.data().shell.get(value.id)).toMatchObject({ status: "exited", exit: 0, time: { started: 1, completed: 100 } })
  } finally { pending.resolve(json({ location: { directory }, data: [] })); fixture.app.renderer.destroy() }
})

test.each([true, false])("deleting an observed archive removes it and fences an older live-only response (located=%s)", async (located) => {
  const value = shell("sh_deleted")
  const fixture = await setup([value])
  const pending = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  try {
    fixture.events.emit({ id: "evt_delete_exit", type: "shell.exited", location: { directory }, created: 100, data: { id: value.id, status: "exited" } })
    await until(() => fixture.data().shell.get(value.id)?.status === "exited")
    fixture.respond(() => { started.resolve(); return pending.promise })
    fixture.data().shell.invalidate()
    const sync = fixture.data().shell.sync()
    await started.promise
    fixture.events.emit({ id: "evt_delete_archive", type: "shell.deleted", created: 101, ...(located ? { location: { directory } } : {}), data: { id: value.id } })
    await until(() => fixture.data().shell.get(value.id) === undefined)
    pending.resolve(json({ location: { directory, project: { id: "proj_test", directory } }, data: [value] }))
    await sync
    expect(fixture.data().shell.get(value.id)).toBeUndefined()
  } finally { pending.resolve(json({ location: { directory }, data: [] })); fixture.app.renderer.destroy() }
})

test("invalidated shell sync cannot replace a newer live record or erase the retained archive", async () => {
  const value = shell("sh_retained")
  const fixture = await setup([value])
  const pending = Promise.withResolvers<Response>()
  const started = Promise.withResolvers<void>()
  try {
    fixture.events.emit({ id: "evt_stale_exit", type: "shell.exited", location: { directory }, created: 100, data: { id: value.id, status: "timeout" } })
    await until(() => fixture.data().shell.get(value.id)?.status === "timeout")
    fixture.respond(() => { started.resolve(); return pending.promise })
    fixture.data().shell.invalidate()
    const old = fixture.data().shell.sync()
    await started.promise
    fixture.data().shell.invalidate()
    fixture.events.emit({ id: "evt_new_record", type: "shell.created", created: 101, location: { directory }, data: { info: shell("sh_new_live", "queued") } })
    await until(() => fixture.data().shell.get("sh_new_live")?.status === "queued")
    pending.resolve(json({ location: { directory, project: { id: "proj_test", directory } }, data: [] }))
    await old
    expect(fixture.data().shell.get(value.id)?.status).toBe("timeout")
    expect(fixture.data().shell.get("sh_new_live")?.status).toBe("queued")
  } finally { pending.resolve(json({ location: { directory }, data: [] })); fixture.app.renderer.destroy() }
})

async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve))
  expect(predicate()).toBe(true)
}
