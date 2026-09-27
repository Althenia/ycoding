import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { launchBrowser } from "./cdp"

const port = 45_000 + Math.floor(Math.random() * 10_000)
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
const captures = mkdtempSync(join(tmpdir(), "ycoding-office-workspace-"))

type Browser = Awaited<ReturnType<typeof launchBrowser>>
type Page = Awaited<ReturnType<Browser["openPage"]>>
type OperationReport = { readonly transports: number; readonly operations: Readonly<Record<string, number>> }

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Browser | undefined

beforeAll(async () => {
  server = Bun.spawn(["bunx", "vite", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: import.meta.dir.replace(/\/verify$/, ""),
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60 && !(await ready()); attempt += 1) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start the remote fixture server")
  browser = await launchBrowser(browserPath, 1440, 900)
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
  console.log(`Office workspace captures: ${captures}`)
})

describe("remote Office presentation", () => {
  test("switches Conversation and Office 50 times without reconnecting, resending, or losing the draft", async () => {
    const page = await openRemote("view=chat")
    try {
      expect(await until(page, `document.querySelector('.conversation-breadcrumb strong') !== null && document.querySelector('.composer textarea') !== null`)).toBe(true)
      await page.evaluate(`(() => {
        window.officeErrors = []
        addEventListener('error', (event) => window.officeErrors.push(String(event.message)))
        addEventListener('unhandledrejection', (event) => window.officeErrors.push(String(event.reason)))
        const field = document.querySelector('.composer textarea')
        field.value = 'Unsent office draft'
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })()`)
      const before = await page.evaluate<OperationReport>(`remoteOperationReport()`)
      const title = await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong').textContent`)

      for (let index = 0; index < 50; index += 1) {
        await choosePresentation(page, "Office")
        expect(await until(page, `document.querySelector('.office-workspace') !== null`)).toBe(true)
        expect(await page.evaluate<number>(`document.querySelectorAll('.composer').length`)).toBe(0)
        if (index % 2 === 0) expect(await until(page, `document.querySelectorAll('.office-workspace canvas').length === 1`, 150)).toBe(true)
        await choosePresentation(page, "Conversation")
        expect(await until(page, `document.querySelector('.office-workspace') === null`)).toBe(true)
      }

      expect(await until(page, `document.querySelectorAll('canvas').length === 0`)).toBe(true)
      const after = await page.evaluate<OperationReport>(`remoteOperationReport()`)
      expect(after.transports).toBe(before.transports)
      expect(after.operations["session.subscribe"] ?? 0).toBe(before.operations["session.subscribe"] ?? 0)
      expect(after.operations["session.prompt"] ?? 0).toBe(0)
      expect(await page.evaluate<string>(`document.querySelector('.composer textarea').value`)).toBe("Unsent office draft")
      expect(await page.evaluate<number>(`document.querySelectorAll('.composer').length`)).toBe(1)
      expect(await page.evaluate<string>(`document.querySelector('.conversation-breadcrumb strong').textContent`)).toBe(title)
      expect(await page.evaluate<readonly string[]>(`window.officeErrors`)).toEqual([])
    } finally {
      await page.close()
    }
  }, 180_000)

  test("selects and follows a family member from the roster without opening a transcript", async () => {
    const page = await openRemote("view=chat&presentation=office")
    try {
      expect(await until(page, `document.querySelectorAll('.office-roster__row').length === 2 && document.querySelector('.office-workspace canvas') !== null`)).toBe(true)
      await page.evaluate(`document.querySelector('.office-roster__row[data-session-id="ses_child"]').click()`)
      expect(await until(page, `document.querySelector('.office-roster__row[data-session-id="ses_child"]')?.getAttribute('aria-current') === 'true'`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelectorAll('.office-roster__row[aria-current="true"]').length`)).toBe(1)
      expect(await page.evaluate<boolean>(`!!document.querySelector('.office-roster__row[data-session-id="ses_fixture"]')`)).toBe(true)
      expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote")
      expect(await page.evaluate<boolean>(`document.querySelector('.presentation-switch [aria-checked="true"]').textContent.trim() === 'Office'`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelectorAll('.composer,.office-workspace__inspector').length`)).toBe(0)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("updates the office from the stream and retains the transcript in Conversation", async () => {
    const page = await openRemote("scenario=conversation-tool-terminal-output-1440&presentation=office")
    try {
      expect(await until(page, `document.querySelector('.office-roster__row[aria-current="true"] .office-roster__status')?.textContent === 'Working' && document.querySelectorAll('.office-workspace canvas').length === 1`, 150)).toBe(true)
      const before = await page.evaluate<OperationReport>(`remoteOperationReport()`)
      await page.evaluate(`[...document.querySelectorAll('.fixture__controls button')].find((button) => button.textContent.includes('Simulate streaming step')).click()`)

      expect(await until(page, `document.querySelector('.office-roster__row[aria-current="true"] .office-roster__status')?.textContent === 'Working'`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelectorAll('.office-workspace__inspector,.composer').length`)).toBe(0)
      await choosePresentation(page, "Conversation")
      expect(await until(page, `document.querySelector('.conversation-pane')?.textContent.includes('Streaming through the relay with bounded tool output.') ?? false`)).toBe(true)
      const after = await page.evaluate<OperationReport>(`remoteOperationReport()`)
      expect(after.operations["session.subscribe"] ?? 0).toBe(before.operations["session.subscribe"] ?? 0)
      expect(after.transports).toBe(before.transports)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("points to pending requests from the office and keeps replies on the existing cards", async () => {
    const page = await openRemote("scenario=permission-guardrail-hard-review-form-requests-1440&presentation=office")
    try {
      expect(await until(page, `document.querySelector('.office-attention') !== null`)).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector('.office-attention').textContent`)).toMatch(/need(s)? your reply/)
      await page.evaluate(`document.querySelector('.office-attention').click()`)
      expect(await until(page, `document.activeElement?.id === 'pending-requests'`)).toBe(true)

      const before = await page.evaluate<OperationReport>(`remoteOperationReport()`)
      await page.evaluate(`[...document.querySelectorAll('#pending-requests button')].find((button) => button.textContent.trim() === 'Approve once').click()`)
      expect(await until(page, `(remoteOperationReport().operations['session.permission.reply'] ?? 0) === ${(before.operations["session.permission.reply"] ?? 0) + 1}`)).toBe(true)
      expect(await page.evaluate<boolean>(`document.querySelector('#pending-requests')?.textContent.includes('human decision') ?? false`)).toBe(true)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("keeps an unknown prompt outcome visible across presentation switches without resending it", async () => {
    const page = await openRemote("view=chat&promptOutcome=unknown&presentation=office")
    try {
      expect(await until(page, `document.querySelector('.office-roster__row[aria-current="true"]') !== null`)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelectorAll('.composer').length`)).toBe(0)
      await choosePresentation(page, "Conversation")
      expect(await until(page, `document.querySelector('.composer__input') !== null`)).toBe(true)
      await page.evaluate(`(() => {
        const input = document.querySelector('.composer__input')
        input.value = 'Work on the office'
        input.dispatchEvent(new InputEvent('input', { bubbles: true }))
        document.querySelector('button[aria-label="Send prompt"]').click()
      })()`)
      expect(await until(page, `document.querySelector('.mutation--unknown') !== null`)).toBe(true)
      await choosePresentation(page, "Office")
      expect(await until(page, `document.querySelector('.office-roster__row[aria-current="true"]')?.textContent.includes('Outcome unknown') ?? false`)).toBe(true)

      for (let index = 0; index < 6; index += 1) {
        await choosePresentation(page, index % 2 === 0 ? "Conversation" : "Office")
        expect(await until(page, index % 2 === 0 ? `document.querySelector('.mutation--unknown') !== null` : `document.querySelector('.office-roster__row[aria-current="true"]')?.textContent.includes('Outcome unknown') ?? false`)).toBe(true)
      }
      await choosePresentation(page, "Conversation")
      expect(await until(page, `document.querySelector('.mutation--unknown') !== null`)).toBe(true)
      expect(await page.evaluate<number>(`remoteOperationReport().operations['session.prompt'] ?? 0`)).toBe(1)
      expect(await page.evaluate<number>(`document.querySelectorAll('.mutation--unknown .button').length`)).toBe(2)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("keeps the workspace usable and offers Conversation when the office renderer cannot load", async () => {
    const page = await openRemote("view=chat&presentation=office", 1440, (next) => next.blockURLs(["*create-game*"]))
    try {
      expect(await until(page, `document.querySelector('.office-workspace [role="alert"]')?.textContent.includes('could not start') ?? false`, 100)).toBe(true)
      expect(await page.evaluate<number>(`document.querySelectorAll('.office-workspace canvas').length`)).toBe(0)
      expect(await page.evaluate<number>(`document.querySelectorAll('.office-roster__row').length`)).toBeGreaterThan(0)
      expect(await page.evaluate<number>(`document.querySelectorAll('.composer').length`)).toBe(0)

      await page.evaluate(`[...document.querySelectorAll('.office-workspace [role="alert"] button')].find((button) => button.textContent.includes('normal view')).click()`)
      expect(await until(page, `document.querySelector('.office-workspace') === null && document.querySelector('.conversation-breadcrumb') !== null`)).toBe(true)
      expect(await page.evaluate<boolean>(`document.querySelector('.composer textarea')?.disabled === false`)).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector('.presentation-switch [aria-checked="true"]').textContent.trim()`)).toBe("Conversation")
    } finally {
      await page.close()
    }
  }, 60_000)

  test("fills the main area with a responsive canvas and accessible roster at each breakpoint and theme", async () => {
    for (const [width, height] of [[390, 844], [820, 1180], [1024, 768], [1440, 900]] as const) {
      const page = await openRemote("view=chat&presentation=office", width)
      try {
        await page.evaluate<void>(`document.querySelector('.fixture__banner').style.display='none';document.querySelector('.fixture__controls').style.display='none'`)
        await page.setViewport(width, height)
        expect(await until(page, `document.querySelectorAll('.office-roster__row').length >= 1 && document.querySelectorAll('.office-workspace canvas').length === 1`, 150)).toBe(true)
        expect(await until(page, `document.querySelector('.office-workspace__canvas')?.getBoundingClientRect().height >= ${width >= 1024 ? 300 : 220}`, 150)).toBe(true)
        if (width >= 768 && width < 1024) {
          expect(await page.evaluate<boolean>(`document.querySelector('.office-roster__toggle')?.getAttribute('aria-expanded') === 'false'`)).toBe(true)
          await page.evaluate(`document.querySelector('.office-roster__toggle').click()`)
          expect(await until(page, `document.querySelector('.office-roster__toggle')?.getAttribute('aria-expanded') === 'true' && document.querySelector('.office-roster__row')?.getBoundingClientRect().height >= 44`)).toBe(true)
        }
        const layout = await page.evaluate<{
          readonly overflow: boolean
          readonly stage: number
          readonly main: number
          readonly side: boolean
          readonly independentlyScrollable: boolean
          readonly rows: readonly number[]
          readonly controls: readonly number[]
        }>(`(() => {
          const stage=document.querySelector('.office-workspace__canvas').getBoundingClientRect()
          const roster=document.querySelector('.office-roster')
          const rosterRect=roster.getBoundingClientRect()
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            stage:stage.height,main:document.querySelector('.workspace__scroll').getBoundingClientRect().height,
            side:rosterRect.left >= stage.right-1,
            independentlyScrollable:getComputedStyle(roster).overflowY==='auto',
            rows: [...document.querySelectorAll('.office-roster__row')].map((row) => row.getBoundingClientRect().height),
            controls: [...document.querySelectorAll('.office-camera-controls button')].map((button) => button.getBoundingClientRect().height),
          }
        })()`)
        expect(layout.overflow).toBe(false)
        expect(await page.evaluate<number>(`document.querySelectorAll('.composer,.office-workspace__inspector').length`)).toBe(0)
        expect(layout.stage).toBeGreaterThanOrEqual(width >= 1024 ? 300 : 220)
        expect(layout.stage).toBeGreaterThan(layout.main * 0.45)
        expect(layout.side).toBe(width >= 1024)
        if (width >= 1024) expect(layout.independentlyScrollable).toBe(true)
        expect(layout.rows.every((row) => row >= 44)).toBe(true)
        expect(layout.controls.every((target) => target >= 44)).toBe(true)
        if (width === 390) {
          expect(await page.evaluate<boolean>(`document.querySelector('.office-roster__list').scrollWidth > document.querySelector('.office-roster__list').clientWidth`)).toBe(true)
          await page.evaluate<void>(`document.querySelector('button[aria-label="Back to conversation"]').focus()`)
          expect(await until(page, `getComputedStyle(document.querySelector('button[aria-label="Back to conversation"]'),'::after').opacity === '1'`)).toBe(true)
          await page.evaluate<void>(`document.querySelector('button[aria-label="Back to conversation"]').blur()`)
          expect(await until(page, `getComputedStyle(document.querySelector('button[aria-label="Back to conversation"]'),'::after').opacity === '0'`)).toBe(true)
        }
        expect(await until(page, `[...document.querySelectorAll('.office-roster__row')].every(row=>row.getAnimations().every(animation=>animation.playState==='finished'))`)).toBe(true)
        for (const theme of ["light", "dark"] as const) {
          await page.evaluate<void>(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
          const capture = join(captures, `${width}x${height}-${theme}.png`)
          await Bun.write(capture, Buffer.from(await page.screenshot(), "base64"))
          expect((await Bun.file(capture).arrayBuffer()).byteLength).toBeGreaterThan(12_000)
        }
      } finally {
        await page.close()
      }
    }
  }, 90_000)

  test("stays usable at 200% zoom of a 1440 by 900 window", async () => {
    const page = await openRemote("view=chat&presentation=office", 720)
    try {
      await page.setViewport(720, 450)
      expect(await until(page, `document.querySelectorAll('.office-roster__row').length >= 1 && document.querySelectorAll('.office-workspace canvas').length === 1`, 150)).toBe(true)
      expect(await until(page, `document.querySelector('.office-workspace__canvas')?.getBoundingClientRect().height > 180`, 150)).toBe(true)
      const layout = await page.evaluate<{ readonly overflow: boolean; readonly stage: number; readonly targets: readonly number[] }>(`(() => {
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          stage:document.querySelector('.office-workspace__canvas').getBoundingClientRect().height,
          targets: [...document.querySelectorAll('.presentation-switch [role="radio"], .office-roster__row')].map((element) => element.getBoundingClientRect().height),
        }
      })()`)
      expect(layout.overflow).toBe(false)
      expect(layout.stage).toBeGreaterThan(180)
      expect(await page.evaluate<number>(`document.querySelectorAll('.composer').length`)).toBe(0)
      expect(layout.targets.every((height) => height >= 44)).toBe(true)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("shows the selected Session's real subagent once and announces only live verified handoffs", async () => {
    const page = await openRemote("view=chat&presentation=office")
    try {
      const childRow = `document.querySelector('.office-roster__row[data-session-id="ses_child"]')`
      expect(await until(page, `${childRow}?.querySelector('.office-roster__name')?.textContent.includes('· general') ?? false`)).toBe(true)
      expect(await page.evaluate<string>(`${childRow}.querySelector('.office-roster__status').textContent`)).toBe("Running")
      expect(await page.evaluate<string>(`${childRow}.querySelector('.office-roster__room').textContent`)).toBe("Developer room")
      expect(await page.evaluate<string>(`document.querySelector('.office-roster__row[data-session-id="ses_fixture"] .office-roster__room').textContent`)).toBe("CEO office")
      expect(await page.evaluate<number>(`document.querySelectorAll('.office-roster__row').length`)).toBe(2)
      expect(await page.evaluate<string>(`document.querySelector('.office-roster [role="status"]').textContent`)).toBe("")

      await page.evaluate(`[...document.querySelectorAll('.fixture__controls button')].find((button) => button.textContent.includes('Simulate subagent handoff')).click()`)
      expect(await until(page, `document.querySelector('.office-roster [role="status"]').textContent === 'Delegated to subagent Fix flaky suite.'`)).toBe(true)
      expect(await until(page, `document.querySelector('.office-roster [role="status"]').textContent === 'Subagent Fix flaky suite reported completed.'`)).toBe(true)
      expect(await until(page, `${childRow} === null`, 250)).toBe(true)
      expect(await page.evaluate<boolean>(`document.querySelector('.office-workspace') !== null && document.querySelector('.office-roster__row[data-session-id="ses_fixture"]') !== null`)).toBe(true)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("shows one agent when no subagents are reported and preserves the Conversation route", async () => {
    const unsupported = await openRemote("view=chat&presentation=office&team=unsupported")
    try {
      expect(await until(unsupported, `document.querySelector('.office-roster')?.textContent.includes('The connected machine does not report subagents.') ?? false`)).toBe(true)
      expect(await unsupported.evaluate<number>(`document.querySelectorAll('.office-roster__row').length`)).toBe(1)
    } finally {
      await unsupported.close()
    }

    const page = await openRemote("view=chat&presentation=office&team=none")
    try {
      expect(await until(page, `document.querySelectorAll('.office-roster__row').length === 1 && document.querySelector('.office-workspace canvas') !== null`)).toBe(true)
      expect(await page.evaluate<string>(`document.querySelector('.office-roster__row').dataset.sessionId`)).toBe("ses_fixture")
      await page.evaluate(`document.querySelector('button[aria-label="Back to conversation"]').click()`)
      expect(await until(page, `document.querySelector('.office-workspace') === null && document.querySelector('.conversation-breadcrumb strong')?.textContent === 'Stream remote output safely'`)).toBe(true)
    } finally {
      await page.close()
    }
  }, 60_000)

  test("persists Office settings, resets only appearance, and opens the chosen presentation", async () => {
    const page = await openRemote("view=settings&presentation=conversation")
    try {
      expect(await until(page, `document.querySelector('#office-settings') !== null`)).toBe(true)
      await chooseSetting(page, "office-view", "Office")
      await chooseSetting(page, "office-quality", "Battery · 20 FPS")
      await chooseSetting(page, "office-bubbles", "Completed text")
      expect(await page.evaluate<string | null>(`localStorage.getItem('ycoding.remote.presentation')`)).toBe("office")
      expect(JSON.parse(await page.evaluate<string>(`localStorage.getItem('ycoding.office')`))).toMatchObject({ version: 1, quality: "battery", bubbles: "excerpt" })

      await page.evaluate(`[...document.querySelectorAll('.office-settings button')].find((button) => button.textContent.trim() === 'Reset').click()`)
      expect(await until(page, `document.querySelector('[aria-labelledby="office-settings"] [role="status"]')?.textContent === 'Office appearance reset.'`)).toBe(true)
      expect(JSON.parse(await page.evaluate<string>(`localStorage.getItem('ycoding.office')`))).toEqual({
        version: 1, motion: "system", bubbles: "status", labels: true, followSelected: true, quality: "standard",
      })
      expect(await page.evaluate<string | null>(`localStorage.getItem('ycoding.remote.presentation')`)).toBe("office")

      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=keep`)
      expect(await until(page, `document.querySelector('.office-workspace') !== null`)).toBe(true)
    } finally {
      await page.close()
    }
  }, 60_000)
})

async function chooseSetting(page: Page, id: string, label: string) {
  await page.evaluate(`[...document.querySelectorAll('[aria-labelledby="${id}-label"] [role="radio"]')].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
  expect(await until(page, `[...document.querySelectorAll('[aria-labelledby="${id}-label"] [role="radio"]')].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).getAttribute('aria-checked') === 'true'`)).toBe(true)
}

async function choosePresentation(page: Page, label: "Conversation" | "Office") {
  await page.evaluate(`[...document.querySelectorAll('.presentation-switch [role="radio"]')].find((button) => button.textContent.trim() === ${JSON.stringify(label)}).click()`)
}

async function until(page: Page, expression: string, attempts = 60): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await page.evaluate<boolean>(expression)) return true
    await Bun.sleep(100)
  }
  return false
}

async function openRemote(query: string, width = 1440, prepare?: (page: Page) => Promise<unknown>) {
  if (!browser) throw new Error("Browser was not initialized")
  const page = await browser.openPage()
  await page.setViewport(width, 900)
  await prepare?.(page)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await page.evaluate<boolean>(`document.querySelector('.app') !== null`)) return page
    await Bun.sleep(100)
  }
  await page.close()
  throw new Error(`${query}: remote workspace did not render`)
}

async function ready() {
  return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok).catch(() => false)
}
