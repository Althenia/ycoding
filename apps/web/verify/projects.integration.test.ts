import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4603
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((result) => result.ok, () => false)) { browser = await launchBrowser(browserPath, 1440, 900); return }
    await Bun.sleep(100)
  }
  throw new Error("Projects fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function until(page: Page, expression: string) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await page.evaluate<boolean>(expression)) return; await Bun.sleep(40) }
  throw new Error(`Projects did not settle: ${expression}`)
}
async function open(width = 1440, extra = "", theme = "light") {
  const page = await browser!.openPage()
  await page.setViewport(width, 900)
  if (width < 768) await page.setCoarsePointer(true)
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=coordination-projects-${width < 768 ? 390 : 1440}&${extra}`)
  await until(page, `!!document.querySelector('.projects')`)
  await page.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`)
  return page
}
const button = (name: string) => `[...document.querySelectorAll('button,a')].filter(e=>e.getClientRects().length && !e.closest('[inert]')).find(e=>(e.getAttribute('aria-label')||e.textContent).trim()===${JSON.stringify(name)})`
const click = (page: Page, name: string) => page.evaluate(`${button(name)}.click()`)
const setField = (page: Page, label: string, value: string) => page.evaluate(`(()=>{const el=[...document.querySelectorAll('label')].find(e=>e.textContent.includes(${JSON.stringify(label)})).querySelector('input,textarea');el.value=${JSON.stringify(value)};el.dispatchEvent(new InputEvent('input',{bubbles:true}))})()`)
const mutations = (page: Page, operation: string) => page.evaluate<{ input: Record<string, unknown> }[]>(`window.remoteMutationReport().filter(x=>x.operation===${JSON.stringify(operation)})`)
const panel = (width: number) => width < 1024 ? "dialog .project-panel" : ".project-desktop .project-panel"
async function openProject(page: Page, width = 1440) {
  await until(page, `document.querySelectorAll('.project-card').length===2`)
  await click(page, "Open project Release train")
  await until(page, `document.querySelector('.project-context')?.textContent.includes('Master of Release train')`)
  if (width < 1024) await click(page, "Sessions 5")
  await until(page, `document.querySelectorAll('${panel(width)} .project-member').length===5`)
}

describe("Projects", () => {
  test("list, master chat and phone sheet render in both themes with no horizontal overflow", async () => {
    for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
      const page = await open(width, "", theme)
      try {
        await until(page, `document.querySelectorAll('.project-card').length===2`)
        expect(await page.evaluate<string>(`document.querySelector('.projects').textContent`)).toContain("Paused · interrupted")
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true)
        await openProject(page, width)
        expect(await page.evaluate<string>(`document.querySelector('${panel(width)} .project-member').dataset.master`)).toBe("true")
        expect(await page.evaluate<string>(`document.querySelector('${panel(width)}').textContent`)).toContain("driven by Migration agent · master subagent")
        expect(await page.evaluate<string>(`document.querySelector('${panel(width)} [role=meter]').getAttribute('aria-valuetext')`)).toBe("1 of 2 running")
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true)
      } finally { await page.close() }
    }
  }, 120_000)

  test("loading, empty, error and unsupported lists retain orientation", async () => {
    for (const [mode, text] of [["loading", "Loading projects…"], ["empty", "No projects"], ["error", "Projects are unavailable"], ["unsupported", "This machine does not offer Projects yet."]]) {
      const page = await open(390, `coordination=${mode}`)
      try { await until(page, `document.querySelector('.projects').textContent.includes(${JSON.stringify(text)})`); expect(await page.evaluate<string>(`document.querySelector('.projects h1').textContent`)).toBe("Projects") } finally { await page.close() }
    }
  }, 60_000)

  test("creates a project with an existing Master and does not create another Session", async () => {
    const page = await open()
    try {
      await until(page, `document.querySelectorAll('.project-card').length===2`)
      await click(page, "New project")
      await setField(page, "Project name", "Release next")
      await click(page, "Use as master Triage flaky tests")
      await click(page, "Create project")
      await until(page, `document.querySelector('.project-context')?.textContent.includes('Master of Release next')`)
      expect((await mutations(page, "coordination.create"))[0]?.input).toEqual({ name: "Release next", masterSessionID: "ses_available", memberSessionIDs: [] })
      expect(await mutations(page, "session.create")).toHaveLength(0)
    } finally { await page.close() }
  }, 30_000)

  test("creates a Master in a chosen directory then creates the project", async () => {
    const page = await open()
    try {
      await until(page, `document.querySelectorAll('.project-card').length===2`)
      await click(page, "New project")
      await setField(page, "Project name", "New master project")
      await click(page, "Create a new Session")
      await click(page, "Directory")
      await page.evaluate(`document.querySelector('[role=option]').click()`)
      await click(page, "Create project")
      await until(page, `document.querySelector('.project-context')?.textContent.includes('New master project')`)
      expect(await mutations(page, "session.create")).toHaveLength(1)
      expect(await mutations(page, "coordination.create")).toHaveLength(1)
    } finally { await page.close() }
  }, 30_000)

  test("adds, removes and deletes member Sessions through their distinct operations", async () => {
    const page = await open()
    try {
      await openProject(page)
      await click(page, "Add session…")
      await click(page, "Add Triage flaky tests")
      await until(page, `!document.querySelector('dialog[open]')`)
      expect((await mutations(page, "coordination.update"))[0]?.input.memberSessionIDs).toContain("ses_available")
      await click(page, "Remove Triage flaky tests from project")
      await until(page, `window.remoteMutationReport().filter(x=>x.operation==='coordination.update').length===2`)
      expect((await mutations(page, "coordination.update"))[1]?.input.memberSessionIDs).not.toContain("ses_available")
      await click(page, "Delete session Audit dashboards")
      expect(await mutations(page, "session.delete")).toHaveLength(0)
      await click(page, "Delete Session")
      await until(page, `!document.querySelector('dialog[open]')`)
      expect((await mutations(page, "session.delete"))[0]?.input).toEqual({ sessionID: "ses_audit" })
    } finally { await page.close() }
  }, 30_000)

  test("creates and adds a member once", async () => {
    const page = await open()
    try {
      await openProject(page)
      await click(page, "New session…")
      await click(page, "Directory")
      await page.evaluate(`document.querySelector('[role=option]').click()`)
      await click(page, "Create and add")
      await until(page, `!document.querySelector('dialog[open]')`)
      expect(await mutations(page, "session.create")).toHaveLength(1)
      expect(await mutations(page, "coordination.update")).toHaveLength(1)
    } finally { await page.close() }
  }, 30_000)

  test("opens a member and returns to the master, including inline event links", async () => {
    const page = await open()
    try {
      await openProject(page)
      await click(page, "Open session Docs worker")
      await until(page, `document.querySelector('.project-context')?.textContent.includes('Member of Release train')`)
      expect(await page.evaluate<string>(`document.querySelector('.project-context').textContent`)).toContain("master Release lead")
      await click(page, "Back to project chat")
      await until(page, `document.querySelector('.project-context')?.textContent.includes('Master of Release train')`)
      await until(page, `document.querySelectorAll('.project-event').length===2`)
      await page.evaluate(`document.querySelector('.project-event a').click()`)
      await until(page, `document.querySelector('.project-context')?.textContent.includes('Member of Release train')`)
    } finally { await page.close() }
  }, 30_000)

  test("saves name, concurrency, delegation, notifications and retains the former Master as a member", async () => {
    const page = await open()
    try {
      await openProject(page)
      await page.evaluate(`document.querySelector('.project-desktop [role=tab]:last-child').click()`)
      await setField(page, "Project name", "Release renamed")
      await click(page, "Save name")
      await until(page, `document.querySelector('.project-heading h1')?.textContent==='Release renamed'`)
      await setField(page, "Members running at once", "3")
      await click(page, "Save concurrency")
      await until(page, `window.remoteMutationReport().filter(x=>x.operation==='coordination.update').length===2`)
      expect((await mutations(page, "coordination.update"))[1]?.input.settings).toEqual({ concurrency: 3 })
      await click(page, "Narrow for this project")
      await click(page, "Save delegation")
      await until(page, `window.remoteMutationReport().filter(x=>x.operation==='coordination.update').length===3`)
      await click(page, "All masters")
      expect(await page.evaluate<string>(`JSON.parse(localStorage.getItem('ycoding.remote.notification-filter')).scope`)).toBe("coordinators")
      await click(page, "Change master…")
      await click(page, "Use as master Docs worker")
      await until(page, `!document.querySelector('dialog[open]')`)
      const changed = (await mutations(page, "coordination.update")).at(-1)!.input
      expect(changed.masterSessionID).toBe("ses_docs")
      expect(changed.memberSessionIDs).toContain("ses_lead")
    } finally { await page.close() }
  }, 30_000)

  test("deleting a project confirms and preserves every Session", async () => {
    const page = await open()
    try {
      await until(page, `document.querySelectorAll('.project-card').length===2`)
      await click(page, "Delete project Release train")
      expect(await page.evaluate<string>(`document.querySelector('dialog').textContent`)).toContain("keep running and keep their histories")
      await click(page, "Delete project")
      await until(page, `document.querySelectorAll('.project-card').length===1`)
      expect((await mutations(page, "coordination.delete"))[0]?.input).toEqual({ groupID: "cgrp_release" })
      expect(await mutations(page, "session.delete")).toHaveLength(0)
    } finally { await page.close() }
  }, 30_000)

  test("phone sheet traps keyboard focus, Escape closes it, and focus returns to its trigger", async () => {
    const page = await open(390)
    try {
      await openProject(page, 390)
      await page.evaluate(`document.querySelector('dialog .overlay__close').focus()`)
      await page.evaluate(`document.querySelector('dialog').dispatchEvent(new KeyboardEvent('keydown', {key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))`)
      expect(await page.evaluate<boolean>(`!!document.activeElement.closest('dialog')`)).toBe(true)
      await page.pressKey("Escape", "Escape", 27)
      await until(page, `!document.querySelector('dialog[open]')`)
      expect(await page.evaluate<string>(`document.activeElement.textContent`)).toBe("Sessions 5")
    } finally { await page.close() }
  }, 30_000)

  test("Project layout reflows at the panel breakpoint and the minimum phone width", async () => {
    for (const width of [320, 1023, 1024]) {
      const page = await open(width)
      try {
        await openProject(page, width)
        expect(await page.evaluate<boolean>(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true)
        if (width < 1024) expect(await page.evaluate<number>(`document.querySelectorAll('dialog[open]').length`)).toBe(1)
        else expect(await page.evaluate<boolean>(`document.querySelector('.project-desktop').getClientRects().length>0`)).toBe(true)
      } finally { await page.close() }
    }
  }, 60_000)

  test("an unconfirmed Session creation cannot accidentally create a duplicate", async () => {
    const page = await open(1440, "creation=unknown")
    try {
      await openProject(page)
      await click(page, "New session…")
      await click(page, "Directory")
      await page.evaluate(`document.querySelector('[role=option]').click()`)
      await click(page, "Create and add")
      await until(page, `document.querySelector('dialog').textContent.includes('may already exist')`)
      expect(await page.evaluate<boolean>(`${button("Create and add")}.disabled`)).toBe(true)
      expect(await mutations(page, "session.create")).toHaveLength(1)
      expect(await mutations(page, "coordination.update")).toHaveLength(0)
    } finally { await page.close() }
  }, 30_000)

  test("a phone action replaces the sheet with one dialog and returns focus to Sessions", async () => {
    const page = await open(390)
    try {
      await openProject(page, 390)
      await click(page, "New session…")
      await until(page, `document.querySelector('dialog[open]')?.getAttribute('aria-label')==='New session in this project'`)
      await Bun.sleep(300)
      expect(await page.evaluate<number>(`document.querySelectorAll('dialog[open]').length`)).toBe(1)
      await page.pressKey("Escape", "Escape", 27)
      await until(page, `!document.querySelector('dialog[open]')`)
      expect(await page.evaluate<string>(`document.activeElement.textContent`)).toBe("Sessions 5")
    } finally { await page.close() }
  }, 30_000)
})
