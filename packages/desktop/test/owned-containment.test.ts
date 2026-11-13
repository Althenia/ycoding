import { expect, mock, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { spawnSync } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { readFileSync, watch } from "node:fs"
import { profile } from "../src/backend-confinement"

let nativeFailure = false
let nativeWait: ((signal: AbortSignal) => Promise<void>) | undefined
await mock.module("../src/native-client", () => ({ connectNative: async (endpoint: unknown, options: { signal: AbortSignal }) => {
  await nativeWait?.(options.signal)
  if (typeof endpoint !== "object" || endpoint === null || !("pid" in endpoint) || typeof endpoint.pid !== "number") throw new Error("The synthetic native health fixture needs its explicit PID")
  return { health: { pid: endpoint.pid, version: "1.0.0" }, api: {}, close: async () => { if (nativeFailure) throw new Error("synthetic native close failure") } }
} }))
const { BackendController } = await import("../src/backend-controller")

const task = process.env.YCODING_DESKTOP_TEST_TASK
if (!task || !path.isAbsolute(task)) throw new Error("A private containment-test Task is required")

test("the unchanged confinement profile refuses process-list execution without running a listing", async () => {
  const root = await fs.mkdtemp(path.join(task, "profile-"))
  const text = profile({ owned: root, cwd: root, connect: [], backend: {
    resources: root, directory: root, manifest: path.join(root, "backend.json"), executable: "/usr/bin/true", version: "1.0.0",
  } })
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", text, "/bin/ps", "--help"], {
    env: { HOME: process.env.HOME!, PATH: process.env.PATH! }, encoding: "utf8", timeout: 2_000, maxBuffer: 4096,
  })
  await fs.writeFile(path.join(root, "result.json"), JSON.stringify({ status: result.status, signal: result.signal, error: result.error?.message, stdout: result.stdout, stderr: result.stderr }) + "\n", { flag: "wx", mode: 0o600 })
  expect(result.error).toBeUndefined()
  expect(result.status).not.toBe(0)
  expect(result.stderr).toMatch(/Operation not permitted/)
})

async function fixture(terminal: "valid" | "absent" | "stale" | "duplicate" | "early" | "partial" | "malformed" | "missing-pid", exit: number | "signal" = 7) {
  const root = await fs.mkdtemp(path.join(task!, "control-"))
  await fs.mkdir(path.join(root, "backend"))
  const executable = path.join(root, "backend/ycoding")
  await fs.copyFile("/usr/bin/true", executable)
  const sha256 = createHash("sha256").update(await fs.readFile(executable)).digest("hex")
  await fs.writeFile(path.join(root, "backend.json"), JSON.stringify({ version: "1.0.0", executable: "backend/ycoding", files: [{ path: "backend/ycoding", sha256 }] }), { flag: "wx", mode: 0o600 })
  let launches = 0
  let badVersion = false
  let badControl = false
  const proof = terminal === "absent" || terminal === "early" ? "" : terminal === "malformed" ? "process.stdout.write('not-json\\n');" : `process.stdout.write(JSON.stringify({type:'desktop.retired'${terminal === "missing-pid" ? "" : `,pid:${terminal === "stale" ? 2 : 1}`}})${terminal === "partial" ? "" : "+'\\n'"});${terminal === "duplicate" ? "process.stdout.write(JSON.stringify({type:'desktop.retired',pid:1})+'\\n');" : ""}`
  const controller = new BackendController(root, {
    env: { HOME: process.env.HOME!, PATH: process.env.PATH! },
    launch: (command) => {
      launches++
      if (command[1] !== "--version" && badControl) return ["/synthetic/missing-control"]
      return command[1] === "--version"
        ? [process.execPath, "-e", badVersion ? "process.exit(1)" : 'process.stdout.write("ycoding v1.0.0\\n")']
        : [process.execPath, "-e", `setTimeout(()=>process.exit(9),2000); ${terminal === "early" ? "process.stdout.write(JSON.stringify({type:'desktop.retired',pid:1})+'\\n');" : ""}process.stdout.write(JSON.stringify({type:'desktop.endpoint',version:'1.0.0',endpoint:{pid:1,url:'http://127.0.0.1:1/',auth:{type:'basic',username:'fixture',password:'synthetic'}}})+'\\n'); process.stdin.resume(); process.stdin.once('end',()=>{${proof}${exit === "signal" ? "process.kill(process.pid,'SIGTERM')" : `process.exit(${exit})`}})`]
    },
  })
  return { controller, launches: () => launches, badVersion: (value: boolean) => { badVersion = value }, badControl: (value: boolean) => { badControl = value } }
}

for (const terminal of ["absent", "stale", "duplicate", "partial", "malformed", "missing-pid"] as const) {
  test(`own-backend disconnect retains unconfirmed ${terminal} evidence across concurrent and repeated operations`, async () => {
    const { controller, launches } = await fixture(terminal)
    expect((await controller.connect({ mode: "own" })).status).toBe("connected")
    const results = await Promise.allSettled([controller.disconnect(), controller.disconnect()])
    expect(results.map((result) => result.status)).toEqual(["rejected", "rejected"])
    await rejects(controller.disconnect(), Error)
    await rejects(controller.connect({ mode: "own" }), Error)
    expect(controller.state().status).toBe("error")
    expect(launches()).toBe(2)
  })
}

for (const exit of [7, "signal"] as const) {
  test(`own-backend disconnect reports ${exit} but confirmed termination permits explicit reconnect`, async () => {
    const { controller, launches } = await fixture("valid", exit)
    expect((await controller.connect({ mode: "own" })).status).toBe("connected")
    await rejects(controller.disconnect(), Error)
    await rejects(controller.disconnect(), Error)
    expect((await controller.connect({ mode: "own" })).status).toBe("connected")
    await rejects(controller.disconnect(), Error)
    expect(launches()).toBe(4)
  })
}

test("own-backend disconnect succeeds once after confirmed normal EOF", async () => {
  const { controller, launches } = await fixture("valid", 0)
  expect((await controller.connect({ mode: "own" })).status).toBe("connected")
  await Promise.all([controller.disconnect(), controller.disconnect()])
  await controller.disconnect()
  expect(controller.state().status).toBe("idle")
  expect(launches()).toBe(2)
})

test("own-backend disconnect preserves failed native retirement despite a valid backend terminal observation", async () => {
  const { controller, launches } = await fixture("valid", 0)
  expect((await controller.connect({ mode: "own" })).status).toBe("connected")
  nativeFailure = true
  try {
    await rejects(controller.disconnect(), Error)
    await rejects(controller.connect({ mode: "own" }), Error)
    expect(launches()).toBe(2)
    expect(controller.state().status).toBe("error")
  } finally { nativeFailure = false }
})

test("own-backend startup version failure without a control remains explicitly recoverable", async () => {
  const first = await fixture("valid", 0)
  first.badVersion(true)
  await rejects(first.controller.connect({ mode: "own" }), Error)
  first.badVersion(false)
  expect((await first.controller.connect({ mode: "own" })).status).toBe("connected")
  await first.controller.disconnect()
  expect(first.launches()).toBe(3)
})

test("own-backend failed control spawn remains explicitly recoverable after its failed close is reported", async () => {
  const first = await fixture("valid", 0)
  first.badControl(true)
  await rejects(first.controller.connect({ mode: "own" }), Error)
  first.badControl(false)
  expect((await first.controller.connect({ mode: "own" })).status).toBe("connected")
  await first.controller.disconnect()
  expect(first.launches()).toBe(4)
})

test("own-backend startup rejects terminal evidence before readiness and retains the unknown owner", async () => {
  const { controller, launches } = await fixture("early", 0)
  await rejects(controller.connect({ mode: "own" }), Error)
  await rejects(controller.connect({ mode: "own" }), Error)
  expect(launches()).toBe(2)
})

test("own-backend concurrent abort joins one confirmed retirement without respawn", async () => {
  const { controller, launches } = await fixture("valid", 0)
  const entered = Promise.withResolvers<void>()
  nativeWait = (signal) => new Promise((_resolve, reject) => {
    entered.resolve()
    const abort = () => reject(new Error("synthetic cancelled native startup"))
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) abort()
  })
  try {
    const connecting = controller.connect({ mode: "own" }).then(() => "connected", () => "cancelled")
    await entered.promise
    await Promise.all([controller.disconnect(), controller.disconnect()])
    expect(await connecting).toBe("cancelled")
    expect(controller.state().status).toBe("idle")
    expect(launches()).toBe(2)
  } finally { nativeWait = undefined }
})

type Identity = { control: number; backend: number | null }
const gone = (identity: Identity) => {
  for (const pid of [identity.control, ...(identity.backend === null ? [] : [identity.backend])]) {
    let missing = false
    try { process.kill(pid, 0) }
    catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error
      missing = true
    }
    expect(missing).toBe(true)
  }
}

async function startupFixture(beforeChild: boolean) {
  const root = await fs.mkdtemp(path.join(task!, "startup-"))
  await fs.mkdir(path.join(root, "backend"))
  const executable = path.join(root, "backend/ycoding")
  await fs.copyFile("/usr/bin/true", executable)
  const sha256 = createHash("sha256").update(await fs.readFile(executable)).digest("hex")
  await fs.writeFile(path.join(root, "backend.json"), JSON.stringify({ version: "1.0.0", executable: "backend/ycoding", files: [{ path: "backend/ycoding", sha256 }] }), { flag: "wx", mode: 0o600 })
  const read = (name: string): Identity => {
    const value: unknown = JSON.parse(readFileSync(path.join(root, name), "utf8"))
    if (typeof value !== "object" || value === null || !("control" in value) || typeof value.control !== "number" || !Number.isSafeInteger(value.control) || value.control <= 0 || !("backend" in value) || (value.backend !== null && (typeof value.backend !== "number" || !Number.isSafeInteger(value.backend) || value.backend <= 0))) throw new Error("Invalid owned synthetic process identity")
    return { control: value.control, backend: value.backend }
  }
  let first: Identity | undefined
  let controls = 0
  const entered = Promise.withResolvers<Identity>()
  const observer = watch(root, (_event, name) => {
    if (name !== "started.json") return
    try { first = read("started.json"); entered.resolve(first) }
    catch (error) { entered.reject(error) }
    observer.close()
    clearTimeout(deadline)
  })
  const deadline = setTimeout(() => { observer.close(); entered.reject(new Error("Synthetic startup admission timed out")) }, 3_000)
  const controller = new BackendController(root, {
    env: { HOME: process.env.HOME!, PATH: process.env.PATH! },
    launch: (command) => {
      if (command[1] === "--version") return [process.execPath, "-e", 'process.stdout.write("ycoding v1.0.0\\n")']
      const later = ++controls > 1
      const shared = command.includes("shared")
      const marker = path.join(root, later ? "later.json" : "started.json")
      const prior = first ? [first.control, ...(first.backend === null ? [] : [first.backend])] : []
      const publish = `const f=require('node:fs');const marker=${JSON.stringify(marker)};f.writeFileSync(marker+'.partial',JSON.stringify({control:${shared || (!later && beforeChild) ? "process.pid" : "process.ppid"},backend:${shared || (!later && beforeChild) ? "null" : "process.pid"}}));f.renameSync(marker+'.partial',marker);`
      const endpoint = "JSON.stringify({type:'desktop.endpoint',version:'1.0.0',endpoint:{pid:PID,url:'http://127.0.0.1:1/',auth:{type:'basic',username:'fixture',password:'synthetic'}}})+'\\n'"
      const check = `for(const pid of ${JSON.stringify(prior)}){try{process.kill(pid,0);process.exit(5)}catch(e){if(e.code!=='ESRCH')throw e}};`
      const prelude = `${check}setTimeout(()=>process.exit(9),2500);process.stdin.resume();`
      if (shared || (!later && beforeChild)) return [process.execPath, "-e", `${prelude}${publish}${shared ? `process.stdout.write(${endpoint.replace("PID", "1")});` : ""}process.stdin.once('end',()=>process.stdout.write(JSON.stringify({type:'desktop.retired'})+'\\n',()=>process.exit(0)));`]
      const backend = `process.stdin.resume();process.stdin.once('end',()=>process.exit(0));setTimeout(()=>process.exit(9),2000);${publish}process.stdout.write('started');`
      return [process.execPath, "-e", `${prelude}const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(backend)}],{env:{HOME:process.env.HOME,PATH:process.env.PATH},stdio:['pipe','pipe','ignore']});const closed=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));child.stdout.once('data',()=>{${later ? `process.stdout.write(${endpoint.replace("PID", "child.pid")});` : ""}});process.stdin.once('end',async()=>{child.stdin.end();const result=await closed;process.stdout.write(JSON.stringify({type:'desktop.retired'${later ? ",pid:child.pid" : ""}})+'\\n',()=>process.exit(result.code===0&&result.signal===null?0:7))});`]
    },
  })
  return { controller, entered: entered.promise, read, stop: () => { observer.close(); clearTimeout(deadline) } }
}

for (const beforeChild of [true, false]) {
  test(`own-backend pre-readiness ${beforeChild ? "disconnect before a child" : "switch after child spawn"} confirms cleanup before another connection`, async () => {
    const f = await startupFixture(beforeChild)
    const initial = f.controller.connect({ mode: "own" }).then(() => "connected", () => "cancelled")
    let original: Identity | undefined
    try {
      original = await f.entered
      expect(original.backend === null).toBe(beforeChild)
      if (beforeChild) await f.controller.disconnect()
      const next = await f.controller.connect({ mode: beforeChild ? "own" : "shared" })
      expect(await initial).toBe("cancelled")
      expect(next.status).toBe("connected")
      expect(next.mode).toBe(beforeChild ? "own" : "shared")
      gone(original)
      const current = f.read("later.json")
      await f.controller.disconnect()
      gone(current)
      expect(f.controller.state().status).toBe("idle")
    } finally { f.stop(); await f.controller.disconnect().catch(() => undefined); await initial; if (original) gone(original) }
  }, 5_000)
}
