import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4396
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Team fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("Office-selected managed child opens read-only Conversation instead of a prompt composer", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=office&theme=light`)
    for (let attempt = 0; attempt < 100 && !await page.evaluate<boolean>(`document.querySelector('.office-roster__row[data-session-id="ses_child"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.office-roster__row[data-session-id="ses_child"]').click()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.office-roster__row[data-session-id="ses_child"]')?.getAttribute('aria-current') === 'true'`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.presentation-switch [role="radio"]:first-child').click()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent.includes('Child: fix flaky suite') ?? false`); attempt += 1) await Bun.sleep(50)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.composer, .mini-composer__mount')].every((element) => element.getClientRects().length === 0 || element.closest('[inert]') !== null)`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.subagent-bar [aria-label="Main session"]') !== null`)).toBe(true)
  } finally { await page.close() }
}, 20_000)

test("Conversation Team reads do not start Office-only family activity polling", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=conversation&team=two`)
    for (let attempt = 0; attempt < 80 && await page.evaluate<number>(`window.remoteOperationReport?.().operations['session.subagent.list'] ?? 0`) === 0; attempt += 1) await Bun.sleep(50)
    const report = await page.evaluate<{ readonly taskReads: number; readonly activityReads: number; readonly office: boolean; readonly operations: Readonly<Record<string, number>>; readonly selected: string | null }>(`({ taskReads: window.remoteOperationReport?.().operations['session.subagent.list'] ?? 0, activityReads: window.remoteOperationReport?.().operations['session.family.activity'] ?? 0, office: document.querySelector('.office-workspace') !== null, operations: window.remoteOperationReport?.().operations ?? {}, selected: document.querySelector('.conversation-breadcrumb strong')?.textContent ?? null })`)
    expect(report).toMatchObject({ taskReads: 1, activityReads: 0, office: false, selected: "Stream remote output safely" })
  } finally { await page.close() }
})

test("real remote Team opens on phone, tablet, and desktop with no Office activity reads", async () => {
  if (!browser) throw new Error("Browser not started")
  for (const [width, height] of [[390, 844], [820, 1180], [1440, 900]] as const) {
    const page = await browser.openPage()
    try {
      await page.setViewport(width, height)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=conversation&team=two`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Open Team"]') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]') !== null`); attempt += 1) await Bun.sleep(25)
      for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]')?.textContent.includes('$0.25') ?? false`); attempt += 1) await Bun.sleep(25)
      expect(await page.evaluate<string>(`document.querySelector('.team-view__task[data-session-id="ses_child"]')?.textContent ?? ''`)).toContain("20 tokens · $0.25 · Context 800 / 2,000 · 75% hit")
      expect(await page.evaluate<boolean>(`document.querySelector('.team-view [role="tablist"]') !== null && document.querySelector('.team-view__task[data-session-id="ses_child"]') !== null && (document.querySelector('.team-view')?.closest('dialog[open]') !== null) === (innerWidth < 768) && document.documentElement.scrollWidth <= innerWidth && (window.remoteOperationReport().operations['session.family.activity'] ?? 0) === 0`)).toBe(true)
    } finally { await page.close() }
  }
}, 30_000)

test("real remote Team cancels, kills, creates and opens a BTW side chat; managed child rejects crafted prompt", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=conversation&team=two`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Open Team"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]') !== null`); attempt += 1) await Bun.sleep(25)
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]').click(); document.querySelector('dialog[aria-label="Cancel subagent"] [data-action="confirm"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]')?.textContent.includes('cancelling') ?? false`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]')?.textContent.includes('cancelling') ?? false`)).toBe(true)
    await page.evaluate(`window.remoteTeamControl.cancelled()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]')?.textContent.includes('cancelled') ?? false`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]')?.textContent.includes('cancelled') ?? false`)).toBe(true)
    await page.evaluate(`document.querySelector('.team-view [data-tab="shell"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.team-view__shell [data-action="kill"]') !== null`); attempt += 1) await Bun.sleep(25)
    await page.evaluate(`document.querySelector('.team-view__shell [data-action="kill"]').click(); document.querySelector('dialog[aria-label="Kill shell"] [data-action="confirm"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.team-view__shell')?.textContent.includes('killed') ?? false`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__shell')?.textContent.includes('killed') ?? false`)).toBe(true)
    await page.evaluate(`document.querySelector('.team-view [data-tab="side-chats"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.team-view [data-action="new-side-chat"]') !== null`); attempt += 1) await Bun.sleep(25)
    await page.evaluate(`document.querySelector('.team-view [data-action="new-side-chat"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('.composer textarea') !== null`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<boolean>(`document.querySelector('.composer, .mini-composer__mount') !== null && document.querySelector('.subagent-bar') === null`)).toBe(true)
    await page.evaluate(`(() => { const field=document.querySelector('.composer textarea'); field.value='Review the result'; field.dispatchEvent(new InputEvent('input',{ bubbles:true })); document.querySelector('.composer button[aria-label="Send prompt"]').click() })()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`window.remoteMutationReport().some((item) => item.operation === 'session.prompt' && item.input?.text === 'Review the result')`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<boolean>(`window.remoteMutationReport().some((item) => item.operation === 'session.prompt' && item.input?.text === 'Review the result')`)).toBe(true)
    expect(await page.evaluate<string>(`window.remoteTeamControl.prompt('ses_child')`)).toBe("subagent_read_only")
    expect(await page.evaluate<string>(`window.remoteTeamControl.prompt(window.remoteTeamControl.createdID())`)).toBe("ok")
  } finally { await page.close() }
}, 30_000)

test("an older connector keeps the task page readable but requires a machine update for Team controls", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=conversation&team=two&teamControls=unsupported`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('[aria-label="Open Team"]') !== null`); attempt += 1) await Bun.sleep(25)
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate<boolean>(`document.querySelector('#team-panel-subagents [role="status"]')?.textContent.includes('Update YCoding') ?? false`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="open"]') !== null && document.querySelector('.team-view__task [data-action="cancel"]') === null && document.querySelector('#team-panel-subagents [role="status"]')?.textContent.includes('Update YCoding') === true`)).toBe(true)
    expect(await page.evaluate<number>(`window.remoteOperationReport().operations['session.subagent.cancel'] ?? 0`)).toBe(0)
  } finally { await page.close() }
}, 15_000)

test("a family shell owned by a BTW child retains the side-chat title", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team&sideShell`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view [data-tab="shell"]') !== null`); attempt += 1) await Bun.sleep(25)
    await page.evaluate(`document.querySelector('.team-view [data-tab="shell"]').click()`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.team-view__owner h3')].map((item) => item.textContent?.trim())`)).toEqual(["Main session", "Side chat · Quick question"])
  } finally { await page.close() }
})

test("Office alone enables family activity reads and returns to task-only watching in Conversation", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&presentation=office&team=two`)
    for (let attempt = 0; attempt < 100 && await page.evaluate<number>(`window.remoteOperationReport?.().operations['session.family.activity'] ?? 0`) === 0; attempt += 1) await Bun.sleep(50)
    expect(await page.evaluate<number>(`window.remoteOperationReport?.().operations['session.family.activity'] ?? 0`)).toBeGreaterThan(0)
    await page.evaluate(`document.querySelector('.presentation-switch [role="radio"]:first-child').click()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.office-workspace') === null`); attempt += 1) await Bun.sleep(25)
    const before = await page.evaluate<number>(`window.remoteOperationReport().operations['session.family.activity'] ?? 0`)
    await Bun.sleep(3_200)
    expect(await page.evaluate<number>(`window.remoteOperationReport().operations['session.family.activity'] ?? 0`)).toBe(before)
  } finally { await page.close() }
}, 12_000)

test("Team tabs keep keyed rows, counts, and navigation across phone, tablet, and desktop themes", async () => {
  if (!browser) throw new Error("Browser not started")
  for (const theme of ["light", "dark"] as const) for (const [width, height] of [[390, 844], [820, 1180], [1440, 900]] as const) {
    const page = await browser.openPage()
    try {
      await page.setViewport(width, height)
      await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team&theme=${theme}`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view [role="tablist"]') !== null`); attempt += 1) await Bun.sleep(50)
      expect(await page.evaluate<{ readonly tabs: readonly string[]; readonly sections: readonly string[]; readonly rows: number; readonly overflow: boolean; readonly sheet: boolean; readonly smallTargets: readonly string[] }>(`(() => ({ tabs: [...document.querySelectorAll('.team-view [role="tab"]')].map((item) => item.textContent.trim()), sections: [...document.querySelectorAll('.team-view__section')].map((item) => item.textContent.trim()), rows: document.querySelectorAll('.team-view__task').length, overflow: document.documentElement.scrollWidth > innerWidth, sheet: document.querySelector('.team-view')?.closest('dialog[open]') !== null, smallTargets: [...document.querySelectorAll('.team-view button')].filter((button) => button.getClientRects().length > 0 && button.getBoundingClientRect().height < 43.5).map((button) => button.textContent.trim() + ':' + button.getBoundingClientRect().height) }))()`)).toEqual({ tabs: ["Subagents 4", "Shell 1", "Side chats 1"], sections: ["ACTIVE", "INACTIVE"], rows: 3, overflow: false, sheet: width < 768, smallTargets: [] })
      await Bun.write(new URL(`../../../.cache/tmp/team-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      await page.evaluate(`window.teamRow = document.querySelector('.team-view__task[data-session-id="ses_child"]'); window.teamRefresh()`)
      expect(await page.evaluate<boolean>(`window.teamRow === document.querySelector('.team-view__task[data-session-id="ses_child"]')`)).toBe(true)
      await page.evaluate(`window.teamComplete('ses_child')`)
      expect(await page.evaluate<boolean>(`window.teamRow === document.querySelector('.team-view__task[data-session-id="ses_child"]') && window.teamRow.previousElementSibling?.classList.contains('team-view__section') === false`)).toBe(true)
      await page.evaluate(`document.querySelector('.team-view [data-tab="shell"]').click(); document.querySelector('.team-view [data-tab="subagents"]').click()`)
      expect(await page.evaluate<boolean>(`window.teamRow === document.querySelector('.team-view__task[data-session-id="ses_child"]')`)).toBe(true)
      await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="open"]').click()`)
      expect(await page.evaluate<string>(`window.teamSelected()`)).toBe("ses_child")
    } finally { await page.close() }
  }
}, 30_000)

test("Team keeps one titled header, sheet padding, and a non-overlapping older control", async () => {
  if (!browser) throw new Error("Browser not started")
  const reports: { readonly width: number; readonly theme: string; readonly headings: number; readonly closes: number; readonly count: string; readonly left: number; readonly right: number; readonly token: number; readonly olderClear: boolean; readonly listScrolls: boolean; readonly olderVisible: boolean }[] = []
  for (const theme of ["light", "dark"] as const) for (const width of [390, 768] as const) {
    const page = await browser.openPage()
    try {
      await page.setViewport(width, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team&crowded&theme=${theme}`)
      for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__more') !== null`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`(() => { const panel = document.querySelector('.team-view'), body = panel.closest('dialog')?.querySelector('.overlay__body'); if (body) body.scrollTop = body.scrollHeight; else panel.querySelector('.team-view__list').scrollTop = panel.querySelector('.team-view__list').scrollHeight })()`)
      await Bun.write(new URL(`../../../.cache/tmp/phone-settings-${process.env.PHONE_CAPTURE_PHASE ?? "after"}-team-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      const layout = await page.evaluate<{ readonly headings: number; readonly closes: number; readonly count: string; readonly left: number; readonly right: number; readonly token: number; readonly olderClear: boolean; readonly listScrolls: boolean; readonly olderVisible: boolean }>(`(() => {
        const panel = document.querySelector('.team-view'), sheet = panel.closest('dialog'), head = sheet?.querySelector('.overlay__head') ?? panel.querySelector('.team-view__header');
        const body = sheet?.querySelector('.overlay__body'), card = panel.querySelector('.team-view__task'), list = panel.querySelector('.team-view__list'), more = panel.querySelector('.team-view__more');
        const container = (body ?? panel).getBoundingClientRect(), content = (card ?? list).getBoundingClientRect(), older = more.getBoundingClientRect();
        return { headings: [...head.querySelectorAll('.overlay__title, h2')].filter(node => node.textContent.trim() === 'Team').length + [...panel.querySelectorAll('h2')].filter(node => node.textContent.trim() === 'Team' && !head.contains(node)).length,
          closes: [...(sheet ?? panel).querySelectorAll('button[aria-label="Close Team"]')].filter(button => button.getClientRects().length).length,
          count: head.textContent.trim(), left: content.left - container.left, right: container.right - content.right,
          token: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-space-4')),
          olderClear: [...panel.querySelectorAll('.team-view__task')].every(task => { const box = task.getBoundingClientRect(); return older.bottom <= box.top || older.top >= box.bottom + parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--yc-space-2')) || older.right <= box.left || older.left >= box.right }),
          listScrolls: list.scrollHeight > list.clientHeight + 1,
          olderVisible: !body || (older.top >= body.getBoundingClientRect().top && older.bottom <= body.getBoundingClientRect().bottom) };
      })()`)
      reports.push({ width, theme, ...layout })
    } finally { await page.close() }
  }
  for (const layout of reports) {
    expect(layout.headings, JSON.stringify(layout)).toBe(1)
    expect(layout.closes).toBe(1)
    expect(layout.count).toContain("5 active")
    if (layout.width === 390) {
      expect(layout.left).toBeGreaterThanOrEqual(layout.token)
      expect(layout.right).toBeGreaterThanOrEqual(layout.token)
      expect(layout.listScrolls).toBe(false)
      expect(layout.olderVisible).toBe(true)
    }
    expect(layout.olderClear).toBe(true)
  }
}, 30_000)

test("Team controls confirm cancellation and shell kill, answer a blocked child, and page side chats", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.setViewport(390, 844)
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]').click()`)
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Cancel subagent"][open]') !== null`)).toBe(true)
    await page.evaluate(`document.querySelector('dialog[aria-label="Cancel subagent"] [data-action="keep"]').click()`)
    expect(await page.evaluate<{ present: boolean; open: boolean; inert: boolean }>(`(() => { const dialog = document.querySelector('dialog[aria-label="Cancel subagent"]'); return { present: !!dialog, open: dialog?.open ?? false, inert: dialog?.inert ?? false } })()`)).toEqual({ present: true, open: false, inert: true })
    for (let attempt = 0; attempt < 20 && await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Cancel subagent"]') !== null`); attempt += 1) await Bun.sleep(50)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toEqual([])
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]').click(); document.querySelector('dialog[aria-label="Cancel subagent"] [data-action="confirm"]').click()`)
    for (let attempt = 0; attempt < 40 && await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Cancel subagent"]')?.open === true`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<{ present: boolean; inert: boolean }>(`(() => { const dialog = document.querySelector('dialog[aria-label="Cancel subagent"]'); return { present: !!dialog, inert: dialog?.inert ?? false } })()`)).toEqual({ present: true, inert: true })
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]')?.textContent.includes('cancelling') ?? false`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toEqual(["cancel:ses_child"])
    await page.evaluate(`window.teamComplete('ses_child')`)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]')?.textContent.includes('cancelled') ?? false`)).toBe(true)
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_waiting"] [data-action="answer"]').click()`)
    await page.evaluate(`(() => { const field=document.querySelector('.team-answer textarea'); field.value='staging'; field.dispatchEvent(new InputEvent('input',{bubbles:true})); document.querySelector('.team-answer button[type="submit"]').click() })()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`window.teamEvents().some((item) => item.startsWith('answer:'))`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toContain("answer:ses_waiting:qst_1:staging")
    await page.evaluate(`document.querySelector('.team-view [role="tab"][data-tab="shell"]').click()`)
    expect(await page.evaluate<string>(`document.querySelector('.team-view__owner')?.textContent ?? ''`)).toBe("Main session")
    await page.evaluate(`document.querySelector('.team-view__shell [data-action="output"]').click()`)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toContain("output:ses_root:sh_1")
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__output')?.textContent.includes('Tests passed') ?? false`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<string>(`document.querySelector('.team-view__output')?.textContent ?? ''`)).toContain("Tests passed")
    await page.evaluate(`document.querySelector('.team-view__shell [data-action="kill"]').click()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Kill shell"][open]') !== null`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<{ readonly confirm: boolean; readonly dialogs: readonly string[]; readonly killDisabled: boolean; readonly tab: string | null; readonly events: readonly string[] }>(`({ confirm: document.querySelector('dialog[aria-label="Kill shell"][open]') !== null, dialogs: [...document.querySelectorAll('dialog[open]')].map((item) => item.getAttribute('aria-label')), killDisabled: document.querySelector('.team-view__shell [data-action="kill"]')?.disabled ?? true, tab: document.querySelector('.team-view [aria-selected="true"]')?.getAttribute('data-tab') ?? null, events: window.teamEvents() })`)).toMatchObject({ confirm: true, killDisabled: false, tab: "shell" })
    await page.evaluate(`document.querySelector('dialog[aria-label="Kill shell"] [data-action="confirm"]').click()`)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toContain("kill:sh_1")
    await page.evaluate(`document.querySelector('.team-view [role="tab"][data-tab="side-chats"]').click()`)
    await page.evaluate(`document.querySelector('.team-view__side-chat [data-action="open"]').click()`)
    expect(await page.evaluate<string>(`window.teamSelected()`)).toBe("ses_btw")
    await page.evaluate(`document.querySelector('.team-view [data-action="new-side-chat"]').click()`)
    expect(await page.evaluate<string>(`window.teamSelected()`)).toBe("ses_btw_new")
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toContain("open:ses_btw_new")
    await page.evaluate(`document.querySelector('.team-view [data-action="older-side-chats"]').click()`)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toContain("older:sidechats")
  } finally { await page.close() }
}, 20_000)

test("loading older subagents appends the next page without replacing resident rows", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.setViewport(390, 844)
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`window.teamRow = document.querySelector('.team-view__task[data-session-id="ses_child"]'); document.querySelector('.team-view__more').click()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_old"]') !== null`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<boolean>(`window.teamRow === document.querySelector('.team-view__task[data-session-id="ses_child"]') && document.querySelector('.team-view__more') === null`)).toBe(true)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toEqual(["older:subagents"])
  } finally { await page.close() }
})

test("a stale confirmation cannot cancel a terminal child or kill an exited shell", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]').click(); window.teamComplete('ses_child')`)
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Cancel subagent"] [data-action="confirm"]')?.disabled === true`)).toBe(true)
    await page.evaluate(`document.querySelector('dialog[aria-label="Cancel subagent"] [data-action="confirm"]').click()`)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toEqual([])
    await page.evaluate(`document.querySelector('dialog[aria-label="Cancel subagent"] [data-action="keep"]').click(); document.querySelector('.team-view [data-tab="shell"]').click(); document.querySelector('.team-view__shell [data-action="kill"]').click(); window.teamShellExit('sh_1')`)
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Kill shell"] [data-action="confirm"]')?.disabled === true`)).toBe(true)
    await page.evaluate(`document.querySelector('dialog[aria-label="Kill shell"] [data-action="confirm"]').click()`)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toEqual([])
  } finally { await page.close() }
})

test("an uncertain cancellation stays unresolved and does not replay", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team&cancelOutcome=unknown`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]').click(); document.querySelector('dialog[aria-label="Cancel subagent"] [data-action="confirm"]').click()`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view [role="alert"]')?.textContent.includes('Outcome unknown') ?? false`); attempt += 1) await Bun.sleep(25)
    expect(await page.evaluate<string>(`document.querySelector('.team-view [role="alert"]')?.textContent ?? ''`)).toContain("Outcome unknown")
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toEqual(["cancel:ses_child"])
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]')?.textContent.includes('running') ?? false`)).toBe(true)
  } finally { await page.close() }
})

test("unsupported Team operations ask for a device update without exposing unusable controls", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team&unsupported`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view [role="tablist"]') !== null`); attempt += 1) await Bun.sleep(50)
    expect(await page.evaluate<string>(`document.getElementById('team-panel-subagents')?.textContent ?? ''`)).toContain("Update YCoding")
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view [data-action="cancel"]') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.team-view [data-tab="shell"]').click()`)
    expect(await page.evaluate<string>(`document.getElementById('team-panel-shell')?.textContent ?? ''`)).toContain("Update YCoding")
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view [data-action="kill"]') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.team-view [data-tab="side-chats"]').click()`)
    expect(await page.evaluate<string>(`document.getElementById('team-panel-side-chats')?.textContent ?? ''`)).toContain("Update YCoding")
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view [data-action="new-side-chat"]') === null`)).toBe(true)
  } finally { await page.close() }
})

test("switching families invalidates a pending confirmation and old Team rows", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]').click(); window.teamSwitchRoot()`)
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="Cancel subagent"]') === null`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"]') === null && document.querySelector('.team-view__task[data-session-id="ses_other_child"]') !== null`)).toBe(true)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toEqual([])
  } finally { await page.close() }
})

test("a late uncertain cancellation from the old family cannot report on the new one", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team&cancelOutcome=deferred`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]') !== null`); attempt += 1) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="cancel"]').click(); document.querySelector('dialog[aria-label="Cancel subagent"] [data-action="confirm"]').click(); window.teamSwitchRoot(); window.teamReleaseCancel()`)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view [role="alert"]') === null && document.querySelector('.team-view__task[data-session-id="ses_other_child"]') !== null`)).toBe(true)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toEqual(["cancel:ses_child"])
  } finally { await page.close() }
})

test("managed child bar navigates siblings and parent while BTW retains its composer", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=child`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.subagent-bar') !== null`); attempt += 1) await Bun.sleep(50)
    expect(await page.evaluate<boolean>(`document.querySelector('textarea[aria-label="Message main session"], textarea[aria-label="Message BTW"]') === null`)).toBe(true)
    expect(await page.evaluate<string>(`document.querySelector('.subagent-bar')?.textContent ?? ''`)).toContain("100% hit")
    expect(await page.evaluate<string>(`document.querySelector('.subagent-bar')?.textContent ?? ''`)).toContain("read unreported · write unreported")
    await page.evaluate(`document.querySelector('.subagent-bar [aria-label="Next subagent"]').click()`)
    expect(await page.evaluate<string>(`window.teamSelected()`)).toBe("ses_done")
    await page.evaluate(`document.querySelector('.subagent-bar [aria-label="Previous subagent"]').click()`)
    expect(await page.evaluate<string>(`window.teamSelected()`)).toBe("ses_child")
    await page.evaluate(`document.querySelector('.subagent-bar [aria-label="Main session"]').click()`)
    expect(await page.evaluate<string>(`window.teamSelected()`)).toBe("ses_root")
    expect(await page.evaluate<boolean>(`document.querySelector('textarea[aria-label="Message main session"]') !== null`)).toBe(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=btw`)
    expect(await page.evaluate<boolean>(`document.querySelector('textarea[aria-label="Message BTW"]') !== null && document.querySelector('.subagent-bar') === null`)).toBe(true)
  } finally { await page.close() }
})

test("Team tabs and row actions are keyboard operable, and Escape closes the phone sheet", async () => {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  try {
    await page.setViewport(390, 844)
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team`)
    for (let attempt = 0; attempt < 40 && !await page.evaluate<boolean>(`document.querySelector('.team-view [data-tab="subagents"]') !== null`); attempt += 1) await Bun.sleep(50)
    expect(await page.evaluate<boolean>(`[...document.querySelectorAll('.team-view [role="tab"]')].every((tab) => { const panel=document.getElementById(tab.getAttribute('aria-controls')); return panel?.getAttribute('role')==='tabpanel' && panel.hidden === (tab.getAttribute('aria-selected')!=='true') })`)).toBe(true)
    await page.evaluate(`document.querySelector('.team-view [data-tab="subagents"]').focus()`)
    await page.pressKey("ArrowRight", "ArrowRight", 39)
    expect(await page.evaluate<string>(`document.querySelector('.team-view [aria-selected="true"]')?.getAttribute('data-tab') ?? ''`)).toBe("shell")
    await page.pressKey("End", "End", 35)
    expect(await page.evaluate<string>(`document.querySelector('.team-view [aria-selected="true"]')?.getAttribute('data-tab') ?? ''`)).toBe("side-chats")
    await page.pressKey("Home", "Home", 36)
    expect(await page.evaluate<string>(`document.querySelector('.team-view [aria-selected="true"]')?.getAttribute('data-tab') ?? ''`)).toBe("subagents")
    await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="open"]').focus()`)
    await page.pressKey(" ", "Space", 32)
    expect(await page.evaluate<string[]>(`window.teamEvents()`)).toContain("open:ses_child")
    await page.pressEscape()
    expect(await page.evaluate<boolean>(`(() => { const view = document.querySelector('.team-view'); return view === null || view.closest('dialog[inert]:not([open])') !== null })()`)).toBe(true)
    for (let attempt = 0; attempt < 20 && await page.evaluate<boolean>(`document.querySelector('.team-view') !== null`); attempt += 1) await Bun.sleep(50)
    expect(await page.evaluate<boolean>(`document.querySelector('.team-view') === null`)).toBe(true)
  } finally { await page.close() }
})

test("phone Team sheet closes through its inert exit and returns focus for every dismissal", async () => {
  if (!browser) throw new Error("Browser not started")
  for (const theme of ["light", "dark"]) for (const [reduced, method] of [[false, "modal-button"], [false, "escape"], [false, "backdrop"], [false, "open-child"], [true, "modal-button"]] as const) {
    const page = await browser.openPage()
    try {
      await page.setViewport(390, 844)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&theme=${theme}`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`(() => { const trigger=document.querySelector('[aria-label="Open Team"]'); return trigger !== null && !trigger.closest('[inert]') && trigger.getBoundingClientRect().width > 0 })()`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`(() => { const trigger=document.querySelector('[aria-label="Open Team"]'); window.teamOpener=trigger; trigger.focus() })()`)
      expect(await page.evaluate<boolean>(`document.activeElement === window.teamOpener`)).toBe(true)
      await page.pressKey(" ", "Space", 32)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet[open]') !== null`); attempt += 1) await Bun.sleep(25)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet[open]') !== null`)).toBe(true)
      if (method === "modal-button") await page.evaluate(`document.querySelector('.team-view__sheet .overlay__head [aria-label="Close Team"]').click()`)
      if (method === "escape") await page.pressEscape()
      if (method === "backdrop") await page.evaluate(`document.querySelector('dialog.team-view__sheet').click()`)
      if (method === "open-child") await page.evaluate(`document.querySelector('.team-view__task[data-session-id="ses_child"] [data-action="open"]').click()`)
      expect(await page.evaluate<boolean>(`document.activeElement === window.teamOpener && window.teamOpener.getAttribute('aria-expanded') === 'false'`)).toBe(true)
      if (reduced) expect(await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet') === null`)).toBe(true)
      else {
        const exit = await page.evaluate<{ readonly inert: boolean | undefined; readonly hidden: string | null | undefined; readonly open: boolean | undefined; readonly duration: string | undefined }>(`(() => { const dialog=document.querySelector('dialog.team-view__sheet'); return { inert:dialog?.inert, hidden:dialog?.getAttribute('aria-hidden'), open:dialog?.open, duration:dialog ? getComputedStyle(dialog.querySelector('.overlay__surface')).animationDuration : undefined } })()`)
        expect({ theme, reduced, method, ...exit }).toEqual({ theme, reduced, method, inert: true, hidden: "true", open: false, duration: "0.22s" })
        if (method === "escape") continue
        let removed = false
        for (let attempt = 0; attempt < 30; attempt += 1) {
          removed = await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet') === null`)
          if (removed) break
          await Bun.sleep(25)
        }
        expect(removed).toBe(true)
      }
      if (method === "open-child") expect(await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Child: fix flaky suite') === true`)).toBe(true)
    } finally { await page.close() }
  }
}, 90_000)

test("phone Team reopens a fresh sheet before its previous exit completes", async () => {
  if (!browser) throw new Error("Browser not started")
  for (const theme of ["light", "dark"]) {
    const page = await browser.openPage()
    try {
      await page.setViewport(390, 844)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&team=two&theme=${theme}`)
      for (let attempt = 0; attempt < 60 && !await page.evaluate<boolean>(`(() => { const trigger=document.querySelector('[aria-label="Open Team"]'); return trigger !== null && !trigger.closest('[inert]') && trigger.getBoundingClientRect().width > 0 })()`); attempt += 1) await Bun.sleep(50)
      await page.evaluate(`document.querySelector('[aria-label="Open Team"]').focus()`)
      await page.pressKey(" ", "Space", 32)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet[open]') !== null`)).toBe(true)
      await page.evaluate(`document.querySelector('dialog.team-view__sheet .overlay__close').click()`)
      expect(await page.evaluate<boolean>(`document.querySelector('dialog.team-view__sheet[data-closing][inert]') !== null && document.activeElement?.getAttribute('aria-label') === 'Open Team'`)).toBe(true)
      await page.pressKey(" ", "Space", 32)
      expect(await page.evaluate<boolean>(`document.querySelectorAll('dialog.team-view__sheet').length === 1 && document.querySelector('dialog.team-view__sheet[open]:not([data-closing])') !== null`)).toBe(true)
    } finally { await page.close() }
  }
}, 20_000)
