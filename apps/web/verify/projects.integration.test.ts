import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4603
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")

let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(browserPath, 390, 844)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Vite did not start the Projects fixture")
})

afterAll(async () => {
  await browser?.close()
  server?.kill()
  if (server) await server.exited
})

const filterKey = "ycoding.remote.notification-filter"

async function until(page: Page, expression: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(40)
  }
  throw new Error(`Projects did not settle: ${expression}`)
}

async function open(width: number, query = "", options: { readonly theme?: "light" | "dark"; readonly coarse?: boolean; readonly height?: number; readonly storage?: Record<string, string> } = {}) {
  if (!browser) throw new Error("Chrome was not initialized")
  const page = await browser.openPage()
  await page.setViewport(width, options.height ?? 900)
  if (options.coarse) await page.setCoarsePointer(true)
  const url = `http://127.0.0.1:${port}/verify/remote.html?scenario=coordination-projects-${width === 1440 ? 1440 : 390}${query === "" ? "" : `&${query}`}`
  await page.navigate(url)
  await page.evaluate(`localStorage.removeItem(${JSON.stringify(filterKey)}); ${Object.entries(options.storage ?? {}).map(([key, value]) => `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`).join(";")}`)
  await page.navigate(url)
  await until(page, `document.querySelector('.projects') !== null`)
  if (options.theme) await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(options.theme)}`)
  return page
}

const label = (name: string) => `[...document.querySelectorAll('.projects button, .projects a, dialog button')].find(element => (element.getAttribute('aria-label') ?? element.textContent).trim() === ${JSON.stringify(name)})`
const press = (page: Page, name: string) => page.evaluate(`${label(name)}.click()`)
const requests = (page: Page, operation: string) => page.evaluate<{ operation: string; input: Record<string, unknown> }[]>(`window.remoteMutationReport().filter(entry => entry.operation === ${JSON.stringify(operation)})`)
const setValue = (page: Page, selector: string, value: string) => page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.value = ${JSON.stringify(value)}; field.dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
const text = (page: Page, selector: string) => page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.textContent?.trim() ?? ''`)
const cards = (page: Page) => page.evaluate<string[]>(`[...document.querySelectorAll('.project-card')].map(card => card.querySelector('.project-card__name').textContent + '|' + card.querySelector('.chip').textContent + '|' + [...card.querySelectorAll('.project-card__meta')].map(meta => meta.textContent).join('|'))`)
const openProject = async (page: Page, name: string) => { await press(page, `Open ${name}`); await until(page, `document.querySelector('#project-title')?.textContent === ${JSON.stringify(name)}`) }
const idle = (page: Page) => until(page, `document.querySelector('.projects__live')?.textContent === ''`)
const overflow = (page: Page) => page.evaluate<boolean>(`document.documentElement.scrollWidth > innerWidth`)

describe("Projects", () => {
  test("opens as a full-screen route under Sessions and lists each group with its status and capacity", async () => {
    for (const width of [320, 390, 1440]) for (const theme of ["light", "dark"] as const) {
      const page = await open(width, "", { theme })
      try {
        expect(await page.evaluate<string>(`location.pathname`)).toBe("/remote/projects")
        expect(await text(page, ".projects h1")).toBe("Projects")
        await until(page, `document.querySelectorAll('.project-card').length === 2`)
        expect(await cards(page)).toEqual([
          "Release train|armed|1/2 workers · hard limit 4|3 Sessions · coordinator Release coordinator",
          "Docs sweep|disarmed|0/4 workers · uncapped policy · hard limit 4|1 Session · coordinator Spare research session",
        ])
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.remote-nav a[aria-current="page"], .bottom-nav a[aria-current="page"]')].filter(link => link.getBoundingClientRect().width > 0).map(link => link.textContent.trim())`)).toEqual(["Sessions"])
        expect(await overflow(page), `${width} ${theme}`).toBe(false)
        const bounds = await page.evaluate<boolean>(`[...document.querySelectorAll('.project-card')].every(card => { const box = card.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth })`)
        expect(bounds).toBe(true)
        expect(await page.evaluate<boolean>(`!!document.querySelector('.page-head__action') && document.querySelector('.page-head__action').textContent.trim() === 'New project'`)).toBe(true)
        await Bun.sleep(500)
        await Bun.write(new URL(`../../../.cache/tmp/projects-list-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      } finally { await page.close() }
    }
  }, 120_000)

  test("an unreported hard limit is stated as unreported and never as zero or unlimited", async () => {
    const page = await open(390, "hardLimit=none")
    try {
      await until(page, `document.querySelectorAll('.project-card').length === 2`)
      expect((await cards(page))[0]).toContain("1 workers · policy 2 · hard limit unreported")
      expect((await cards(page))[1]).toContain("0 workers · uncapped policy · hard limit unreported")
    } finally { await page.close() }
  }, 30_000)

  test("shows the unavailable, empty and older-machine states honestly while the notification filter stays usable", async () => {
    const empty = await open(390, "coordination=empty")
    try {
      await until(empty, `document.querySelector('.projects__empty')?.textContent === 'No coordination groups'`)
      expect(await empty.evaluate<boolean>(`document.querySelector('.page-head__action') !== null`)).toBe(true)
    } finally { await empty.close() }
    const older = await open(390, "coordination=unsupported")
    try {
      await until(older, `document.body.innerText.includes('This machine does not offer Projects yet. Update YCoding on it, then reload.')`)
      expect(await older.evaluate<boolean>(`document.querySelector('.page-head__action') === null && document.querySelector('.project-card') === null`)).toBe(true)
      await until(older, `document.querySelector('#projects-filter-title') !== null`)
      await press(older, "Selected coordinators")
      expect(await text(older, '[aria-label="Selected coordinators"] .projects__empty')).toContain("coordinator list is unavailable")
    } finally { await older.close() }
    const failing = await open(390, "coordination=error")
    try {
      await until(failing, `document.querySelector('.projects__notice[role="alert"]')?.textContent?.includes('Projects: Projects are unavailable') === true`)
      expect(await failing.evaluate<boolean>(`[...document.querySelectorAll('.projects button')].some(button => button.textContent.trim() === 'Retry')`)).toBe(true)
    } finally { await failing.close() }
  }, 60_000)

  test("a group opens to its roster, queue, policy, leases and receipts with titles, roles and reasons", async () => {
    for (const width of [390, 1440]) {
      const page = await open(width)
      try {
        await until(page, `document.querySelectorAll('.project-card').length === 2`)
        await openProject(page, "Release train")
        expect(await page.evaluate<string>(`document.activeElement?.id`)).toBe("project-title")
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.project-member')].map(member => member.querySelector('.project-member__name').textContent + '|' + member.querySelector('.chip').textContent + '|' + member.querySelector('.project-member__limits').textContent)`)).toEqual([
          "Release coordinator|Coordinator|No tool limit recorded · No scope limit recorded",
          "Docs worker|Worker|Tools: read, edit · Scopes: docs/**",
          "Test runner|Observer|No tool limit recorded · No scope limit recorded",
        ])
        const body = await page.evaluate<string>(`document.querySelector('.projects').innerText`)
        for (const expected of ["armed", "1/2 workers · hard limit 4", "Test runner · waiting for a free worker slot", "Concurrency", "Queue capacity", "$25.00", "Narrowed: questions, guardrail reviews", "Docs worker · held by Release coordinator · expires in", "admitted → Docs worker", "Roles are the recorded assignment. They are not evidence that the runtime enforces them."])
          expect(body, expected).toContain(expected)
        expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[aria-label="Lifecycle"] button')].map(button => button.textContent.trim())`)).toEqual(["Stop dispatch · workers keep running", "Complete group", "Edit name and roster", "Edit policy"])
        expect(body).not.toMatch(/cancel workers|kill workers/i)
        const rows = (section: string) => page.evaluate<{ line: string; choice: string; reason: string; kind: string | null }[]>(`[...document.querySelectorAll('section[aria-labelledby="${section}"] .project-lines > li')].map(row => ({ line: row.innerText.split('\\n')[0], choice: row.querySelector('.project-selection__choice').textContent, reason: row.querySelector('.project-selection__reason')?.textContent ?? '', kind: row.querySelector('.project-selection').getAttribute('data-selection') }))`)
        expect(await rows("project-queue-title")).toEqual([{ line: "Test runner · waiting for a free worker slot", choice: "Agent plan · openai/gpt-6-sol · variant unavailable", reason: "Reason: Planning only; the suite run needs no extra reasoning.", kind: "reported" }])
        const receipts = await rows("project-receipts-title")
        expect(receipts.map((row) => [row.line.replace(/ · \d+[smh] ago$/, ""), row.choice, row.reason, row.kind])).toEqual([
          ["admitted → Docs worker", "Agent build · anthropic/claude-sonnet-5-5 · profile work · variant high", "Reason: Needs careful wording across three release notes.", "reported"],
          ["dispatched → Test runner", "Agent plan · openai/gpt-6-sol · variant unavailable", "Reason: Planning only; the suite run needs no extra reasoning.", "reported"],
          ["failed → Docs worker · Session was busy", "Selection not reported", "", "unreported"],
        ])
        expect(await page.evaluate<boolean>(`document.querySelector('.transcript-message__agent, .project-selection .chip') === null`)).toBe(true)
        expect(await overflow(page)).toBe(false)
        await press(page, "Back to projects")
        await until(page, `document.querySelectorAll('.project-card').length === 2`)
      } finally { await page.close() }
    }
  }, 60_000)

  test("lifecycle controls follow the reported status, send once with the shown revision, and completion asks first", async () => {
    const page = await open(1440, "coordinationDelay=400")
    try {
      await until(page, `document.querySelectorAll('.project-card').length === 2`)
      await openProject(page, "Release train")
      await page.evaluate(`(() => { const button = ${label("Stop dispatch · workers keep running")}; button.click(); button.click() })()`)
      expect(await page.evaluate<string>(`document.querySelector('.projects__live').textContent`)).toBe("Working…")
      await until(page, `document.body.innerText.includes('stopped · workers keep running')`)
      await idle(page)
      expect(await requests(page, "coordination.stop")).toEqual([{ operation: "coordination.stop", input: { groupID: "cgrp_release", revision: 3 } }])
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[aria-label="Lifecycle"] button')].map(button => button.textContent.trim()).slice(0, 2)`)).toEqual(["Re-arm group", "Complete group"])
      await press(page, "Re-arm group")
      await until(page, `document.querySelector('[aria-label="Lifecycle"] button')?.textContent.trim() === 'Stop dispatch · workers keep running'`)
      expect((await requests(page, "coordination.arm"))[0]?.input).toEqual({ groupID: "cgrp_release", revision: 4 })
      await idle(page)
      await press(page, "Complete group")
      await until(page, `document.querySelector('dialog[open]') !== null`)
      expect(await text(page, "dialog[open] p")).toContain("Running workers are not cancelled.")
      expect((await requests(page, "coordination.complete")).length).toBe(0)
      await page.pressEscape()
      await until(page, `document.querySelector('dialog[open]') === null`)
      expect(await page.evaluate<string>(`document.activeElement?.textContent?.trim()`)).toBe("Complete group")
      await press(page, "Complete group")
      await until(page, `document.querySelector('dialog[open]') !== null`)
      await page.evaluate(`document.querySelector('[data-confirm-complete]').click()`)
      await until(page, `document.body.innerText.includes('Project completed.')`)
      expect((await requests(page, "coordination.complete"))[0]?.input).toEqual({ groupID: "cgrp_release", revision: 5 })
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[aria-label="Lifecycle"] button')].map(button => button.textContent.trim())`)).toEqual(["Edit name and roster", "Edit policy"])
    } finally { await page.close() }
  }, 60_000)

  test("a new project needs one coordinator, takes Sessions from the list or by ID, and sends the shared default policy", async () => {
    const page = await open(390)
    try {
      await until(page, `document.querySelectorAll('.project-card').length === 2`)
      await press(page, "New project")
      await until(page, `document.querySelector('#project-editor-title')?.textContent === 'New project'`)
      expect(await page.evaluate<boolean>(`document.querySelector('.project-editor button[type="submit"]').disabled`)).toBe(true)
      expect(await text(page, ".projects__notice[role='alert']")).toBe("A group needs exactly one coordinator")
      await setValue(page, ".project-editor input.input", "  Launch crew  ")
      await setValue(page, ".project-picker input[type=search]", "docs")
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.project-picker__row .project-member__name')].map(name => name.textContent)`)).toEqual(["Docs worker"])
      await press(page, "Add Docs worker")
      await setValue(page, ".project-picker input[type=search]", "")
      await press(page, "Add Test runner")
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.project-member--edit')].map(row => row.querySelector('.project-member__name').textContent + '|' + row.querySelector('[aria-checked="true"]').textContent)`)).toEqual(["Docs worker|Coordinator", "Test runner|Worker"])
      const roles = () => page.evaluate<string[]>(`[...document.querySelectorAll('.project-member--edit')].map(row => row.querySelector('[aria-checked="true"]').textContent)`)
      const radio = (row: number, index: number) => page.evaluate(`[...document.querySelectorAll('.project-member--edit')][${row}].querySelectorAll('[role="radio"]')[${index}].click()`)
      await radio(1, 0)
      expect(await roles()).toEqual(["Worker", "Coordinator"])
      await radio(0, 0)
      expect(await roles()).toEqual(["Coordinator", "Worker"])
      await press(page, "Remove Docs worker")
      expect(await text(page, ".projects__notice[role='alert']")).toBe("A group needs exactly one coordinator")
      expect(await page.evaluate<number>(`document.querySelectorAll('.project-member--edit').length`)).toBe(2)
      await page.evaluate(`[...document.querySelectorAll('.project-member--edit')][1].querySelector('details > summary').click()`)
      await page.evaluate(`(() => { const area = [...document.querySelectorAll('.project-member--edit')][1].querySelectorAll('textarea'); area[0].value = 'read, shell'; area[0].dispatchEvent(new InputEvent('input', { bubbles: true })); area[1].value = 'src/**\\ndocs/**'; area[1].dispatchEvent(new InputEvent('input', { bubbles: true })) })()`)
      await setValue(page, ".project-picker__id input", "nope")
      await page.evaluate(`[...document.querySelectorAll('.project-picker__id button')][0].click()`)
      expect(await text(page, ".projects__notice[role='alert']")).toBe("Enter a Session ID that starts with ses_")
      await setValue(page, ".project-picker__id input", "ses_spare")
      await page.evaluate(`document.querySelector('.project-picker__id input').focus()`)
      await page.pressKey("Enter", "Enter", 13, "\r")
      expect(await page.evaluate<number>(`document.querySelectorAll('.project-member--edit').length`)).toBe(3)
      await press(page, "Remove Spare research session")
      expect(await page.evaluate<number>(`document.querySelectorAll('.project-member--edit').length`)).toBe(2)
      await press(page, "Create project")
      await until(page, `document.querySelectorAll('.project-card').length === 3`)
      expect(await requests(page, "coordination.create")).toEqual([{ operation: "coordination.create", input: {
        name: "Launch crew", policy: { concurrency: 1, queueCapacity: 64 },
        members: [{ sessionID: "ses_docs", role: "coordinator" }, { sessionID: "ses_tests", role: "worker", allowedTools: ["read", "shell"], resourceScopes: ["src/**", "docs/**"] }],
      } }])
      expect((await cards(page)).at(-1)).toContain("Launch crew|disarmed|")
      expect(await text(page, ".projects__notice")).toBe("Project created.")
    } finally { await page.close() }
  }, 60_000)

  test("renaming and re-roling keeps the policy, uses the opened revision, and a conflicting change is reported without a replay", async () => {
    const page = await open(1440)
    try {
      await until(page, `document.querySelectorAll('.project-card').length === 2`)
      await openProject(page, "Release train")
      await press(page, "Edit name and roster")
      await until(page, `document.querySelector('#project-editor-title')?.textContent === 'Edit Release train'`)
      await setValue(page, ".project-editor input.input", "Release train 2")
      await page.evaluate(`window.coordinationBump('cgrp_release')`)
      await press(page, "Save changes")
      await until(page, `document.querySelector('.projects__notice[role="alert"]') !== null`)
      expect(await text(page, ".projects__notice[role='alert']")).toBe("Projects: Group revision changed")
      expect((await requests(page, "coordination.members")).length).toBe(1)
      expect(await page.evaluate<string>(`document.querySelector('#project-editor-title').textContent`)).toBe("Edit Release train")
      await press(page, "Cancel")
      await until(page, `document.querySelector('#project-title') !== null`)
      await press(page, "Edit name and roster")
      await until(page, `document.querySelector('#project-editor-title') !== null`)
      await setValue(page, ".project-editor input.input", "Release train 2")
      await press(page, "Save changes")
      await until(page, `document.querySelector('#project-title')?.textContent === 'Release train 2'`)
      const sent = (await requests(page, "coordination.members"))[1]!.input
      expect(sent).toMatchObject({ groupID: "cgrp_release", revision: 4, name: "Release train 2", policy: { concurrency: 2, queueCapacity: 64, budget: 25, delegatedDecisions: { categories: ["question", "review"] } } })
      expect(sent.members).toEqual([{ sessionID: "ses_lead", role: "coordinator" }, { sessionID: "ses_docs", role: "worker", allowedTools: ["read", "edit"], resourceScopes: ["docs/**"] }, { sessionID: "ses_tests", role: "observer" }])
    } finally { await page.close() }
  }, 60_000)

  test("policy limits validate, and delegation can only narrow the central policy with its effect shown", async () => {
    const page = await open(390)
    try {
      await until(page, `document.querySelectorAll('.project-card').length === 2`)
      await openProject(page, "Release train")
      await press(page, "Edit policy")
      await until(page, `document.querySelector('#project-policy-editor-title') !== null`)
      expect(await text(page, "[data-testid='delegation-effective']")).toBe("Narrowed: questions, guardrail reviews")
      expect(await text(page, ".project-delegation .projects__notice")).toBe("Central delegation policy is on. A group can only narrow it; the narrowest setting applies.")
      expect(await page.evaluate<boolean[]>(`[...document.querySelectorAll('[aria-label="Delegated categories"] input')].map(input => input.checked)`)).toEqual([true, false, true])
      await setValue(page, ".project-editor input[aria-labelledby='policy-concurrency-label']", "0")
      await press(page, "Save policy")
      expect(await text(page, ".projects__notice[role='alert']")).toBe("Concurrency must be a whole number of at least 1")
      await setValue(page, ".project-editor input[aria-labelledby='policy-concurrency-label']", "3")
      await page.evaluate(`document.querySelector('[aria-label="Delegated categories"] label:nth-child(2) input').click()`)
      await setValue(page, ".project-delegation textarea", "shell, edit")
      await press(page, "1 hour")
      await press(page, "Save policy")
      await until(page, `document.querySelector('#project-title') !== null`)
      const policy = (await requests(page, "coordination.members"))[0]!.input.policy as { concurrency: number; delegatedDecisions: { categories: string[]; actions: string[]; expiresAt: number } }
      expect(policy).toMatchObject({ concurrency: 3, queueCapacity: 64, budget: 25, delegatedDecisions: { categories: ["question", "review", "permission"], actions: ["shell", "edit"] } })
      expect(policy.delegatedDecisions.expiresAt).toBeGreaterThan(Date.now())
      await press(page, "Edit policy")
      await until(page, `document.querySelector('#project-policy-editor-title') !== null`)
      await press(page, "Inherit central policy")
      expect(await text(page, "[data-testid='delegation-effective']")).toBe("Inherits central policy: questions, permission requests, guardrail reviews")
      await press(page, "Uncapped policy")
      await press(page, "Save policy")
      await until(page, `document.querySelector('#project-title') !== null`)
      const inherited = (await requests(page, "coordination.members"))[1]!.input.policy as Record<string, unknown>
      expect(inherited).toEqual({ concurrency: null, queueCapacity: 64, budget: 25 })
    } finally { await page.close() }
  }, 60_000)

  test("an off or unreadable central policy revokes delegation visibly and blocks narrowing without hiding the group", async () => {
    for (const [central, note, summary] of [
      ["off", "Central delegation policy is off: delegated decisions are revoked for every group, whatever a group sets.", "Revoked: central policy is off for every group"],
      ["unavailable", "Central delegation policy is unavailable, so group narrowing cannot be checked or changed here.", "Central policy unavailable; group narrowing cannot be checked"],
    ] as const) {
      const page = await open(390, `central=${central}`)
      try {
        await until(page, `document.querySelectorAll('.project-card').length === 2`)
        await openProject(page, "Release train")
        expect(await page.evaluate<string>(`document.querySelector('[data-delegation]').textContent`)).toBe(summary)
        await press(page, "Edit policy")
        await until(page, `document.querySelector('#project-policy-editor-title') !== null`)
        expect(await text(page, ".project-delegation .projects__notice")).toBe(note)
        expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.project-delegation [role="radio"]')].every(radio => radio.disabled)`)).toBe(true)
        await setValue(page, ".project-editor input[aria-labelledby='policy-concurrency-label']", "2")
        await press(page, "Save policy")
        await until(page, `document.querySelector('#project-title') !== null`)
        expect((await requests(page, "coordination.members"))[0]!.input.policy).toMatchObject({ delegatedDecisions: { categories: ["question", "review"] } })
      } finally { await page.close() }
    }
  }, 60_000)

  test("external notifications narrow by scope and category, persist per browser, and never hide in-app items", async () => {
    const page = await open(390)
    try {
      await until(page, `document.querySelector('#projects-filter-title') !== null`)
      const state = () => page.evaluate<string>(`document.querySelector('.projects__summary').textContent`)
      expect(await state()).toBe("Currently: all sessions")
      expect(await text(page, "#projects-filter-title + .settings__hint")).toContain("In-app notices, pending requests, reviews and decisions are never hidden.")
      await press(page, "All coordinators")
      expect(await state()).toBe("Currently: all coordinators")
      await press(page, "Selected coordinators")
      expect(await state()).toBe("Currently: no sessions selected · nothing notifies externally")
      expect(await page.evaluate<string[]>(`[...document.querySelectorAll('[aria-label="Selected coordinators"] label')].map(label => label.textContent)`)).toEqual(["Release coordinator", "Spare research session"])
      await page.evaluate(`document.querySelector('[aria-label="Selected coordinators"] label input').click()`)
      expect(await state()).toBe("Currently: coordinators: Release coordinator")
      await page.evaluate(`[...document.querySelectorAll('[aria-label="Notification categories"] label')].find(label => label.textContent === 'Completion').querySelector('input').click()`)
      expect(await state()).toBe("Currently: coordinators: Release coordinator · question, permission, review, failure")
      expect(JSON.parse(await page.evaluate<string>(`localStorage.getItem(${JSON.stringify(filterKey)})`))).toEqual({ scope: "selected", sessionIDs: ["ses_lead"], categories: ["question", "permission", "review", "failure"] })
      expect(await text(page, ".settings__section:last-child .field__hint[role='status']")).toContain("System alerts are not allowed in this browser yet")
      await page.evaluate(`[...document.querySelectorAll('[aria-label="Notification categories"] label input')].forEach(input => { if (input.checked) input.click() })`)
      expect(await state()).toBe("Currently: coordinators: Release coordinator · no categories (muted)")
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=coordination-projects-390`)
      await until(page, `document.querySelector('.projects__summary') !== null`)
      expect(await state()).toBe("Currently: coordinators: Release coordinator · no categories (muted)")
      expect(await page.evaluate<boolean>(`document.querySelector('.page-head__action') !== null && document.querySelectorAll('.project-card').length === 2`)).toBe(true)
    } finally { await page.close() }
  }, 60_000)

  test("Settings summarises the filter and links to Projects", async () => {
    const page = await open(1440, "", { storage: { [filterKey]: JSON.stringify({ scope: "coordinators", categories: ["failure"] }) } })
    try {
      await page.evaluate(`document.querySelector('a[href="/remote/settings"]')?.click()`)
      await until(page, `document.querySelector('[data-filter-summary]') !== null`)
      expect(await text(page, "[data-filter-summary]")).toBe("all coordinators · failure")
      await page.evaluate(`[...document.querySelectorAll('a')].find(link => link.getAttribute('aria-label') === 'Choose external notifications in Projects').click()`)
      await until(page, `location.pathname === '/remote/projects' && document.querySelector('.projects') !== null`)
    } finally { await page.close() }
  }, 30_000)

  test("a master-origin message renders as the user's own message with no coordinator label, identity or on-behalf wording", async () => {
    for (const [width, theme] of [[390, "light"], [1440, "dark"]] as const) {
      if (!browser) throw new Error("Chrome was not initialized")
      const page = await browser.openPage()
      try {
        await page.setViewport(width, 900)
        await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&masterInput=1`)
        await page.evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`)
        await until(page, `document.querySelectorAll('.transcript-message--user .transcript-message__bubble').length >= 2`)
        const rows = await page.evaluate<{ text: string; className: string; right: number; align: string; children: string[] }[]>(`[...document.querySelectorAll('.transcript-message--user')].map(row => ({ text: row.querySelector('.transcript-message__bubble').textContent, className: row.className, right: Math.round(row.getBoundingClientRect().right), align: getComputedStyle(row).justifySelf, children: [...row.children].map(child => child.className) }))`)
        const typed = rows.find((row) => row.text.startsWith("Please review"))!
        const master = rows.find((row) => row.text.startsWith("I need the flaky suite"))!
        expect(master.text).toBe("I need the flaky suite fixed before we ship, so please take it.")
        expect(master.className).toBe(typed.className)
        expect(master.right).toBe(typed.right)
        expect(master.align).toBe(typed.align)
        expect(master.children).toEqual(typed.children)
        const transcript = await page.evaluate<string>(`document.querySelector('.transcript')?.innerText ?? document.body.innerText`)
        expect(transcript).not.toMatch(/coordinator|master|on your behalf|on behalf|delegat|ses_master|cgrp_release|cdsp_9/i)
        expect(await page.evaluate<boolean>(`document.querySelector('.transcript [data-origin], .transcript [data-coordinator], .transcript .transcript-message__origin') === null && !(document.querySelector('.transcript')?.innerHTML ?? 'x').includes('ses_master')`)).toBe(true)
      } finally { await page.close() }
    }
  }, 60_000)

  test("touch targets are at least 44px, group names render as literal text, and the editor never overflows at 320", async () => {
    const hostile = "<img src=x onerror=window.pwned=1>"
    const page = await open(320, "", { coarse: true, height: 700 })
    try {
      await until(page, `document.querySelectorAll('.project-card').length === 2`)
      const small = await page.evaluate<string[]>(`[...document.querySelectorAll('.projects button, .projects a, .projects input:not([type=checkbox]), .projects label.switch')].filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.height < 44 || box.width < 44) && !element.closest('.visually-hidden') }).map(element => element.getAttribute('aria-label') ?? element.textContent.trim()).filter(name => name !== '')`)
      expect(small).toEqual([])
      await press(page, "New project")
      await until(page, `document.querySelector('#project-editor-title') !== null`)
      await setValue(page, ".project-editor input.input", hostile)
      await setValue(page, ".project-picker input[type=search]", "")
      await press(page, "Add Release coordinator")
      await press(page, "Create project")
      await until(page, `document.querySelectorAll('.project-card').length === 3`)
      expect(await page.evaluate<{ names: string[]; images: number; pwned: unknown }>(`({ names: [...document.querySelectorAll('.project-card__name')].map(name => name.textContent), images: document.querySelectorAll('.projects img').length, pwned: window.pwned ?? null })`)).toEqual({ names: ["Release train", "Docs sweep", hostile], images: 0, pwned: null })
      expect(await overflow(page)).toBe(false)
      await openProject(page, hostile)
      await press(page, "Edit name and roster")
      await until(page, `document.querySelector('#project-editor-title') !== null`)
      expect(await overflow(page)).toBe(false)
    } finally { await page.close() }
  }, 60_000)
})
