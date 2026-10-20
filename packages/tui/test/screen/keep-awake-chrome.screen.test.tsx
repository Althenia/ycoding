/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { KeepAwakeStatus } from "../../src/keep-awake"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"
import { saveScreenCapture } from "../fixture/screen-capture"

const sessionID = "ses_keep_awake_chrome"
const session = {
  id: sessionID,
  title: "Machine status",
  projectID: "proj_test",
  location: { directory: "/tmp/ycoding" },
  agent: "build",
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
}

function route(url: URL) {
  if (url.pathname === "/api/session") return json({ data: [session], cursor: {} })
  if (url.pathname === "/api/location")
    return json({
      directory: session.location.directory,
      project: { id: "proj_test", directory: session.location.directory },
    })
  if (url.pathname === `/api/session/${sessionID}`) return json({ data: session })
  if (url.pathname === `/api/session/${sessionID}/snapshot`) return sessionSnapshot(sessionID, [], { session })
  if (url.pathname.endsWith("/subagent"))
    return json({ data: [], summary: { total: 0, active: 0, running: 0, waiting: 0 }, cursor: {} })
  if (url.pathname.endsWith("/guardrail"))
    return json({
      data: {
        rootSessionID: sessionID,
        profile: "standard",
        customRules: 0,
        approvals: 0,
        blocked: 0,
        counters: [],
        invalidFiles: [],
      },
    })
  if (url.pathname.endsWith("/permission") || url.pathname.endsWith("/todo")) return json({ data: [] })
}

async function frame(screen: Awaited<ReturnType<typeof renderScreen>>, check: (value: string) => boolean) {
  if (check(screen.frame())) return
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      screen.renderer.off("frame", observe)
    }
    const observe = () => {
      if (!check(screen.frame())) return
      cleanup()
      resolve()
    }
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(screen.frame()))
    }, 5000)
    screen.renderer.on("frame", observe)
    screen.renderer.requestRender()
  })
}

const cases: { name: string; status: KeepAwakeStatus }[] = [
  { name: "manual", status: { state: "on", manual: true, lid: "off" } },
  {
    name: "sleep-held",
    status: { state: "on", manual: false, lid: "on", sleepHold: true },
  },
  {
    name: "lid-held",
    status: { state: "on", manual: false, lid: "held", sleepHold: true },
  },
  { name: "off", status: { state: "off", lid: "off" } },
  { name: "error", status: { state: "error", lid: "error" } },
  {
    name: "unsupported",
    status: { state: "unsupported", lid: "unsupported" },
  },
]

for (const mode of ["dark", "light"] as const) {
  for (const width of [32, 50]) {
    for (const item of cases) {
      test(`keep-awake ${item.name} adds no footer line at ${width} columns in ${mode}`, async () => {
        const initial = Promise.withResolvers<KeepAwakeStatus>()
        const screen = await renderScreen({
          width,
          height: 36,
          args: { sessionID },
          route,
          settle: "YOLO off · ready",
          config: { animations: false, theme: { mode } },
          keepAwake: {
            get: () => initial.promise,
            set: async () => {
              throw new Error("Read-only render")
            },
          },
        })
        try {
          initial.resolve(item.status)
          await initial.promise
          await screen.renderOnce()
          expect(screen.frame()).not.toContain("keep awake")
          const lines = screen.lines()
          expect(lines.every((line) => line.trimEnd().length <= width)).toBe(true)
          expect(screen.frame()).toContain("Message YCoding…")
          await saveScreenCapture(`keep-awake-${item.name}-${width}-${mode}`, screen)
        } finally {
          initial.resolve(item.status)
          await screen.dispose()
        }
      }, 30_000)
    }

    test(`/keep-awake toggles without adding a footer line at ${width} columns in ${mode}`, async () => {
      const initial = Promise.withResolvers<KeepAwakeStatus>()
      const enabledWrite = Promise.withResolvers<void>()
      const disabledWrite = Promise.withResolvers<void>()
      const writes: boolean[] = []
      let reads = 0
      const screen = await renderScreen({
        width,
        height: 36,
        args: { sessionID },
        route,
        settle: "YOLO off · ready",
        config: { animations: false, theme: { mode } },
        keepAwake: {
          get: () => (++reads === 1 ? initial.promise : new Promise<KeepAwakeStatus>(() => {})),
          set: async (enabled) => {
            writes.push(enabled)
            if (enabled) enabledWrite.resolve()
            if (!enabled) disabledWrite.resolve()
            return { state: enabled ? "on" : "off", manual: enabled, lid: enabled ? "on" : "off" }
          },
        },
      })
      try {
        expect(screen.frame()).not.toContain("keep awake")
        await saveScreenCapture(`keep-awake-loading-${width}-${mode}`, screen)
        initial.resolve({ state: "off", manual: false, lid: "off" })
        await screen.renderOnce()
        await screen.input.typeText("/keep-awake")
        screen.input.pressEnter()
        await enabledWrite.promise
        await frame(screen, (value) => value.includes("Idle and lid-closed"))
        expect(writes).toEqual([true])
        expect(screen.frame()).not.toContain("keep awake")
        expect(screen.frame()).not.toContain("/keep-awake")
        await screen.input.typeText("/keep-awake")
        screen.input.pressEnter()
        await disabledWrite.promise
        await screen.renderOnce()
        expect(writes).toEqual([true, false])
        expect(screen.frame()).not.toContain("keep awake")
      } finally {
        initial.resolve({ state: "off" })
        await screen.dispose()
      }
    }, 30_000)
  }
}
