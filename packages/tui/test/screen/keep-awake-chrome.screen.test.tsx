/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import type { KeepAwakeStatus } from "../../src/keep-awake"
import { json, sessionSnapshot } from "../fixture/tui-client"
import { renderScreen } from "./harness"
import { DEFAULT_THEMES } from "../../src/theme/builtins"
import { resolveThemeFile } from "../../src/theme/resolve"
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

const cases: { name: string; status: KeepAwakeStatus; detail?: string; ink?: "success" | "error" | "warning" }[] = [
  { name: "manual", status: { state: "on", manual: true, lid: "off" }, detail: "on · idle + lid off", ink: "success" },
  {
    name: "sleep-held",
    status: { state: "on", manual: false, lid: "on", sleepHold: true },
    detail: "on · idle + lid + sleep held",
    ink: "success",
  },
  {
    name: "lid-held",
    status: { state: "on", manual: false, lid: "held", sleepHold: true },
    detail: "on · idle + lid held elsewhere + sleep held",
    ink: "success",
  },
  { name: "off", status: { state: "off", lid: "off" } },
  { name: "error", status: { state: "error", lid: "error" }, detail: "error · lid error", ink: "error" },
  {
    name: "unsupported",
    status: { state: "unsupported", lid: "unsupported" },
    detail: "unsupported · lid unsupported",
    ink: "warning",
  },
]

for (const mode of ["dark", "light"] as const) {
  for (const width of [32, 50]) {
    for (const item of cases) {
      test(`keep-awake chrome ${item.name} at ${width} columns in ${mode}`, async () => {
        const screen = await renderScreen({
          width,
          height: 36,
          args: { sessionID },
          route,
          settle: "Ask first · ready",
          config: { animations: false, theme: { mode } },
          keepAwake: {
            get: async () => item.status,
            set: async () => {
              throw new Error("Read-only render")
            },
          },
        })
        try {
          if (!item.detail) {
            expect(screen.frame()).not.toContain("keep awake")
            expect(screen.frame()).toContain("Message YCoding…")
            await saveScreenCapture(`keep-awake-off-${width}-${mode}`, screen)
            return
          }
          await frame(screen, (value) => value.includes("keep awake"))
          const lines = screen.lines()
          const start = lines.findIndex((line) => line.includes("keep awake"))
          const status = lines
            .slice(start, start + 4)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim()
          expect(status).toContain(`keep awake ${item.detail}`)
          expect(screen.colorOf("keep awake")).toEqual(
            resolveThemeFile(DEFAULT_THEMES.ycoding, mode, "ycoding").text.feedback[item.ink!].default.toInts(),
          )
          expect(lines.filter((line) => line.includes("keep awake"))).toHaveLength(1)
          expect(lines.every((line) => line.trimEnd().length <= width)).toBe(true)
          expect(screen.frame()).toContain("Message YCoding…")
          await saveScreenCapture(`keep-awake-${item.name}-${width}-${mode}`, screen)
        } finally {
          await screen.dispose()
        }
      }, 30_000)
    }

    test(`/keep-awake updates chrome without a poll at ${width} columns in ${mode}`, async () => {
      const initial = Promise.withResolvers<KeepAwakeStatus>()
      const writes: boolean[] = []
      let reads = 0
      const screen = await renderScreen({
        width,
        height: 36,
        args: { sessionID },
        route,
        settle: "Ask first · ready",
        config: { animations: false, theme: { mode } },
        keepAwake: {
          get: () => (++reads === 1 ? initial.promise : new Promise<KeepAwakeStatus>(() => {})),
          set: async (enabled) => {
            writes.push(enabled)
            return { state: enabled ? "on" : "off", manual: enabled, lid: enabled ? "on" : "off" }
          },
        },
      })
      try {
        expect(screen.frame()).not.toContain("keep awake")
        await saveScreenCapture(`keep-awake-loading-${width}-${mode}`, screen)
        initial.resolve({ state: "off", manual: false, lid: "off" })
        await frame(screen, (value) => value.includes("Ask first"))
        await screen.input.typeText("/keep-awake")
        screen.input.pressEnter()
        await frame(screen, (value) => value.includes("keep awake on"))
        expect(writes).toEqual([true])
        expect(screen.frame()).not.toContain("/keep-awake")
        await screen.input.typeText("/keep-awake")
        screen.input.pressEnter()
        await frame(screen, (value) => !value.includes("keep awake on"))
        expect(writes).toEqual([true, false])
      } finally {
        initial.resolve({ state: "off" })
        await screen.dispose()
      }
    }, 30_000)
  }
}
