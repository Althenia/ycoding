/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { YCoding } from "@ycoding-ai/client"
import { Effect, Exit, Logger, Scope } from "effect"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { ServerProcess } from "../../server/src/process"
import { ConfigProvider } from "../src/config"
import { ClientProvider } from "../src/context/client"
import { CoordinationProvider, useCoordination } from "../src/context/coordination"
import { ProjectCreationError } from "../src/util/coordination"
import { TestTuiContexts } from "../test/fixture/tui-environment"
import { createTuiResolvedConfig } from "../test/fixture/tui-runtime"

const auth = `Basic ${Buffer.from("ycoding:test-password").toString("base64")}`

test("Project creation resolves ~ against the TUI home and rejects relative directories before the real Session API", async () => {
  await mkdir(join(import.meta.dir, "tmp"), { recursive: true })
  const root = await mkdtemp(join(import.meta.dir, "tmp", "coordination-create-"))
  const home = join(root, "home")
  const scope = await Effect.runPromise(Scope.make())
  let app: Awaited<ReturnType<typeof testRender>> | undefined
  try {
    await Promise.all(["master", "member"].map((name) => mkdir(join(home, name), { recursive: true })))
    const port = await availablePort()
    const starting = ServerProcess.start<never, never>({
      hostname: "127.0.0.1",
      port,
      password: "test-password",
      database: { path: join(root, "ycoding.db") },
      config: { directory: join(root, "config"), project: false, content: "{}" },
      fs: { filewatcher: false, fff: false },
    }).pipe(Effect.provideService(Scope.Scope, scope))
    await Effect.runPromise(
      (starting as Effect.Effect<unknown, unknown>).pipe(
        Effect.provide(Logger.layer([Logger.map(Logger.formatStructured, () => {})])),
      ),
    )
    const client = YCoding.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { authorization: auth } })

    let coordination!: ReturnType<typeof useCoordination>
    function Probe() {
      coordination = useCoordination()
      return <text>{coordination.projects() ? "ready" : "loading"}</text>
    }
    app = await testRender(
      () => (
        <TestTuiContexts cwd={root} directory={root} paths={{ home, state: join(root, "state"), worktree: root }}>
          <ConfigProvider config={createTuiResolvedConfig()}>
            <ClientProvider api={client}>
              <CoordinationProvider>
                <Probe />
              </CoordinationProvider>
            </ClientProvider>
          </ConfigProvider>
        </TestTuiContexts>
      ),
      { width: 40, height: 4 },
    )
    app.renderer.start()
    await app.waitForFrame((frame) => frame.includes("ready"))

    const rejected = await coordination.service
      .create({ name: "Dots", master: { directory: "master" } })
      .catch((cause: unknown) => cause)
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected).not.toBeInstanceOf(ProjectCreationError)
    expect(rejected).toMatchObject({ message: "Choose an absolute directory" })
    expect((await client.session.list({ parentID: null })).data).toEqual([])

    const projectID = await coordination.service.create({ name: "Dots", master: { directory: "~/master" } })
    const masters = (await client.session.list({ parentID: null })).data
    expect(masters.map((session) => session.location.directory)).toEqual([join(home, "master")])
    expect(masters[0].title).toBe("Dots")
    const projects = await client.coordination.list()
    expect(projects.map((project) => project.name)).toEqual(["Dots"])
    const created = await client.coordination.get({ groupID: projects[0].id })
    expect(created.master.sessionID).toBe(masters[0].id)
    expect(projectID).toBe(masters[0].id)

    const memberID = await coordination.service.newMember(created.id, "~/member", "Worker")
    const grown = await client.coordination.get({ groupID: created.id })
    expect(grown.members.map((member) => [member.sessionID, member.location.directory])).toEqual([
      [memberID, join(home, "member")],
    ])
  } finally {
    app?.renderer.destroy()
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await rm(root, { recursive: true, force: true })
  }
}, 60_000)

async function availablePort() {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve coordination integration test port")
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return address.port
}
