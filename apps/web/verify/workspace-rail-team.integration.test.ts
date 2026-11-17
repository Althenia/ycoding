import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser, decodeArray, decodeBoolean, decodeNumber, decodeRecord, decodeString } from "./cdp"

const port = 4637
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to the provisioned Chrome for Testing executable")
let server: ReturnType<typeof Bun.spawn>
let browser: Awaited<ReturnType<typeof launchBrowser>>

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, YCODING_WEB_VERIFY: "1" },
    stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 80; attempt++) {
    if (await fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1440, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Workspace fixture did not start")
})

afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

async function fixture(query: string) {
  const page = await browser.openPage()
  await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await page.evaluate(`!!document.querySelector('.session-row')`)) break
    await Bun.sleep(50)
  }
  await page.evaluate("document.fonts.ready")
  return page
}

for (const [name, query, ready] of [
  ["Projects", "scenario=coordination-projects-1440", ".project-card"],
  ["Sessions", "scenario=session-list-1440", ".sessions-table"],
  ["Workspaces", "view=workspaces", ".workspaces-page"],
  ["Usage", "scenario=usage-quotas-1440", ".usage-page"],
  ["Settings", "scenario=autonomy-goal-notification-settings-1440", ".settings"],
] as const) test(`shared Session rail remains searchable on ${name}`, async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
    await page.evaluate(`new Promise((resolve,reject)=>{const end=performance.now()+8000;const check=()=>{if(document.querySelector(${JSON.stringify(ready)}))return resolve(true);if(performance.now()>end)return reject(new Error('Route did not settle'));requestAnimationFrame(check)};check()})`)
    const rail = await page.evaluate(`(()=>{const rail=document.querySelector('.workspace__rail');return{search:rail.querySelectorAll('input[aria-label="Search sessions"]').length,list:rail.querySelectorAll('.session-list').length,destinations:[...rail.querySelectorAll('.remote-nav__label')].map(e=>e.textContent),current:[...rail.querySelectorAll('.remote-nav [aria-current="page"]')].map(e=>e.textContent.trim()),replacements:rail.querySelectorAll('.project-rail,.workspace-nav').length}})()`)
    expect(rail).toEqual({ search: 1, list: 1, destinations: ["Projects", "Sessions", "Workspaces", "Usage", "Settings"], current: [name], replacements: 0 })
  } finally { await page.close() }
}, 15000)

for (const query of ["scenario=conversation-workspace-390", "scenario=session-list-390"]) test(`phone navigation exposes five reachable destinations on ${query}`, async () => {
  const page = await browser.openPage()
  try {
    await page.setViewport(390, 844)
    await page.setCoarsePointer(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?${query}`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.bottom-nav__item')`); attempt++) await Bun.sleep(25)
    const navigation = await page.evaluate(`(()=>{const links=[...document.querySelectorAll('.bottom-nav__item')];return{labels:links.map(e=>e.textContent.trim()),targets:links.every(e=>{const b=e.getBoundingClientRect();return b.width>=44&&b.height>=44}),current:links.filter(e=>e.getAttribute('aria-current')==='page').map(e=>e.textContent.trim()),overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    expect(navigation).toEqual({ labels: ["Projects", "Sessions", "Workspaces", "Usage", "Settings"], targets: true, current: ["Sessions"], overflow: false })
  } finally { await page.close() }
}, 15000)

test("project context keeps the shared Session rail and its search draft through route changes", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=coordination-projects-1440`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('[aria-label="Open project Release train"]')`); attempt++) await Bun.sleep(25)
    await page.evaluate(`document.querySelector('[aria-label="Open project Release train"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.project-context')`); attempt++) await Bun.sleep(25)
    expect(await page.evaluate(`document.querySelector('.remote-nav [aria-current="page"]').textContent.trim()`)).toBe("Sessions")
    expect(await page.evaluate(`document.querySelectorAll('.workspace__rail .session-list').length`)).toBe(1)
    await page.evaluate(`(()=>{const input=document.querySelector('.workspace__rail [aria-label="Search sessions"]');input.value='Stream';input.dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('.remote-nav [href="/remote/sessions"]').click()})()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.sessions-page')`); attempt++) await Bun.sleep(25)
    expect(await page.evaluate(`document.querySelector('.workspace__rail [aria-label="Search sessions"]').value`)).toBe("Stream")
    expect(await page.evaluate(`document.querySelectorAll('.workspace__rail .session-list').length`)).toBe(1)
  } finally { await page.close() }
}, 15000)

for (const query of ["account=signedout", "invite"]) test(`auth composition centers its native content without submission for ${query}`, async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(query === "invite" ? `http://127.0.0.1:${port}/remote/invite#${"A".repeat(43)}` : `http://127.0.0.1:${port}/verify/remote.html?${query}`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.sign-in__panel')`); attempt++) await Bun.sleep(25)
    await page.evaluate(`document.querySelector('.fixture__banner')?.remove();document.querySelector('.fixture__controls')?.remove()`)
    const geometry = await page.evaluate(`(()=>{const children=[...document.querySelector('.sign-in__panel').children].filter(e=>e.getClientRects().length).map(e=>e.getBoundingClientRect()),top=Math.min(...children.map(b=>b.top)),bottom=Math.max(...children.map(b=>b.bottom)),bar=document.querySelector('.sign-in__bar').getBoundingClientRect();return{offset:Math.abs((top+bottom)/2-(bar.bottom+innerHeight)/2),overflow:document.documentElement.scrollWidth>innerWidth,heading:!!document.querySelector('.sign-in__title')}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, offset: (decodeNumber)(record["offset"]), overflow: (decodeBoolean)(record["overflow"]), heading: (decodeBoolean)(record["heading"]) } })
    expect(geometry.offset).toBeLessThanOrEqual(1)
    expect(geometry.overflow).toBe(false)
    expect(geometry.heading).toBe(true)
  } finally { await page.close() }
}, 15000)

test("Team activity docks below the conversation header and preserves the same companion across tabs", async () => {
  const page = await fixture("ledger=1&view=chat&presentation=conversation&team=five&childQuestion=1")
  try {
    await page.evaluate(`document.querySelector('.fixture__banner')?.remove();document.querySelector('.fixture__controls')?.remove()`)
    await page.setReducedMotion(true)
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.team-view__task')`); attempt++) await Bun.sleep(25)
    const bounds = () => page.evaluate(`(()=>{const panel=document.querySelector('#session-companion-panel'),box=panel.getBoundingClientRect(),header=panel.querySelector('.companion__header').getBoundingClientRect(),title=panel.querySelector('.rl-pane-kicker'),range=document.createRange();range.selectNodeContents(title);return{width:box.width,top:box.top,headerRight:document.querySelector('.workspace__topbar').getBoundingClientRect().right,actionsFit:[...panel.querySelectorAll('.companion__header button')].every(button=>{const b=button.getBoundingClientRect();return b.left>=header.left&&b.right<=header.right&&b.top>=header.top&&b.bottom<=header.bottom}),titleFits:range.getBoundingClientRect().width<=title.getBoundingClientRect().width,overflow:document.documentElement.scrollWidth>innerWidth}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), top: (decodeNumber)(record["top"]), headerRight: (decodeNumber)(record["headerRight"]), actionsFit: (decodeBoolean)(record["actionsFit"]), titleFits: (decodeBoolean)(record["titleFits"]), overflow: (decodeBoolean)(record["overflow"]) } })
    expect(await bounds(), await page.evaluate(`JSON.stringify([...document.querySelector('.companion__header').children].map(element => ({ text: element.textContent, width: element.getBoundingClientRect().width, scroll: element.scrollWidth })))`, decodeString)).toEqual({ width: 380, top: 56, headerRight: 1440, actionsFit: true, titleFits: true, overflow: false })
    expect(await page.evaluate(`document.querySelectorAll('.team-view__task').length`)).toBe(6)
    expect(await page.evaluate(`!!document.querySelector('.team-view__usage')`)).toBe(true)
    await page.evaluate(`window.retainedCompanion=document.querySelector('#session-companion-panel');document.querySelector('.companion [role="tab"][aria-controls$="context"]').click()`)
    expect(await bounds()).toEqual({ width: 448, top: 0, headerRight: 992, actionsFit: true, titleFits: true, overflow: false })
    await page.evaluate(`document.querySelector('.companion [role="tab"][aria-controls$="activity"]').click()`)
    expect(await page.evaluate(`window.retainedCompanion===document.querySelector('#session-companion-panel')`)).toBe(true)
    expect(await bounds()).toEqual({ width: 380, top: 56, headerRight: 1440, actionsFit: true, titleFits: true, overflow: false })
    await page.evaluate(`document.querySelector('[aria-label="Close Session companion"]').click()`)
    expect(await page.evaluate(`document.activeElement===document.querySelector('[aria-label="Open Team"]')`)).toBe(true)
  } finally { await page.close() }
}, 20000)

test("narrow desktop Activity keeps task titles and inclusive usage labels readable", async () => {
  const page = await fixture("ledger=1&view=chat&presentation=conversation&team=five&childQuestion=1")
  try {
    await page.setReducedMotion(true)
    await page.evaluate(`document.querySelector('.fixture__banner')?.remove();document.querySelector('.fixture__controls')?.remove();document.querySelector('[aria-label="Open Team"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`document.querySelectorAll('.team-view__task').length===6`); attempt++) await Bun.sleep(25)
    const layout = await page.evaluate(`(()=>{const rows=[...document.querySelectorAll('.team-view__task')];return{labels:rows.every(row=>[...row.querySelectorAll('dt')].every(label=>label.scrollWidth<=label.clientWidth+1)),titles:rows.every(row=>{const title=row.querySelector('.team-view__title');return title.scrollHeight<=title.clientHeight+1}),slots:[...rows[0].querySelectorAll('dt')].map(label=>label.textContent),overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    expect(layout).toEqual({ labels: true, titles: true, slots: ["Tokens (inclusive)", "Cost (inclusive)", "Context", "Cache"], overflow: false })
  } finally { await page.close() }
}, 20000)

test("selected-child inspector retains complete inclusive usage labels in its 320px column", async () => {
  const page = await fixture("ledger=1&view=chat&presentation=conversation&team=four&childTranscript=1&childQuestion=1")
  try {
    await page.setReducedMotion(true)
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('[aria-label="Expand Team"]')`); attempt++) await Bun.sleep(25)
    await page.evaluate(`document.querySelector('[aria-label="Expand Team"]').click();document.querySelector('[data-action="inspect-child"]').click()`)
    const layout = await page.evaluate(`(()=>{const panel=document.querySelector('.team-overview__inspector');return{width:panel.getBoundingClientRect().width,labels:[...panel.querySelectorAll('dt')].every(label=>label.scrollWidth<=label.clientWidth+1),slots:[...panel.querySelectorAll('dt')].map(label=>label.textContent)}})()`)
    expect(layout).toEqual({ width: 320, labels: true, slots: ["Tokens (inclusive)", "Cost (inclusive)", "Context", "Cache"] })
  } finally { await page.close() }
}, 20000)

test("Activity keeps its companion header reachable while scrolling real task content", async () => {
  const page = await fixture("ledger=1&view=chat&presentation=conversation&team=five&childQuestion=1")
  try {
    await page.setReducedMotion(true)
    await page.evaluate(`document.querySelector('.fixture__banner')?.remove();document.querySelector('.fixture__controls')?.remove();document.querySelector('[aria-label="Open Team"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`document.querySelectorAll('.team-view__task').length===6`); attempt++) await Bun.sleep(25)
    await page.evaluate(`const panel=document.querySelector('#session-companion-panel');panel.scrollTop=panel.scrollHeight;new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    const position = await page.evaluate(`(()=>{const panel=document.querySelector('#session-companion-panel'),header=panel.querySelector('.companion__header'),close=header.querySelector('[aria-label="Close Session companion"]'),box=close.getBoundingClientRect();return{scrolled:panel.scrollTop>0,top:panel.getBoundingClientRect().top,headerTop:header.getBoundingClientRect().top,closeVisible:document.elementsFromPoint(box.x+box.width/2,box.y+box.height/2).includes(close)}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, scrolled: (decodeBoolean)(record["scrolled"]), top: (decodeNumber)(record["top"]), headerTop: (decodeNumber)(record["headerTop"]), closeVisible: (decodeBoolean)(record["closeVisible"]) } })
    expect(position.scrolled).toBe(true)
    expect(position.headerTop).toBeCloseTo(position.top, 0)
    expect(position.closeVisible).toBe(true)
  } finally { await page.close() }
}, 20000)

test("Ledger Changes shows four captured files and an expanded unified patch inside the companion", async () => {
  const page = await fixture("ledger=1&view=chat&presentation=conversation&capturedChanges=four")
  try {
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    await page.evaluate(`document.querySelector('.companion [role="tab"][aria-controls$="changes"]').click()`)
    for (let attempt = 0; attempt < 80 && await page.evaluate(`document.querySelectorAll('.companion .file-change-card__file-toggle').length`) !== 4; attempt++) await Bun.sleep(25)
    expect(await page.evaluate(`document.querySelectorAll('.companion .file-change-card__file-toggle').length`)).toBe(4)
    await page.evaluate(`document.querySelector('.companion .file-change-card__file-toggle').click()`)
    const patch = await page.evaluate(`(()=>{const panel=document.querySelector('.companion'),diff=panel.querySelector('.file-change-card__diff'),unified=diff.querySelector('.file-change-card__unified'),split=diff.querySelector('.file-change-card__split');return {unified:!!unified.getClientRects().length,split:!!split.getClientRects().length,content:unified.textContent.includes('align-items: baseline'),scrolls:diff.scrollHeight>diff.clientHeight,contained:diff.getBoundingClientRect().right<=panel.getBoundingClientRect().right,overflow:document.documentElement.scrollWidth>innerWidth}})()`)
    expect(patch).toEqual({ unified: true, split: false, content: true, scrolls: true, contained: true, overflow: false })
  } finally { await page.close() }
}, 20000)

for (const [state, text, absent] of [
  ["empty", "No subagents have been launched.", "Subagents could not be loaded."],
  ["error", "Subagents could not be loaded.", "No subagents have been launched."],
] as const) test(`Team ${state} state stays explicit without simultaneous task rows`, async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/team-fixture.html?mode=team&${state}`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('#team-panel-subagents [role="status"]')`); attempt++) await Bun.sleep(25)
    const display = await page.evaluate(`(()=>{const panel=document.querySelector('#team-panel-subagents');return{text:panel.textContent,rows:panel.querySelectorAll('.team-view__task').length,overflow:document.documentElement.scrollWidth>innerWidth}})()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, text: (decodeString)(record["text"]), rows: (decodeNumber)(record["rows"]), overflow: (decodeBoolean)(record["overflow"]) } })
    expect(display.text).toContain(text)
    expect(display.text).not.toContain(absent)
    expect(display.rows).toBe(0)
    expect(display.overflow).toBe(false)
  } finally { await page.close() }
}, 20000)

test("desktop rail preserves complete long session names in non-overlapping rows", async () => {
  const page = await fixture("view=chat&paletteAcceptance=1&acceptanceLongTitles=1")
  try {
    const layout = await page.evaluate(`(() => {
      const rail=document.querySelector('.workspace__rail'), rows=[...rail.querySelectorAll('.session-row')], labels=rows.map(row=>row.querySelector('.session-row__name'));
      const boxes=rows.map(row=>row.getBoundingClientRect()).sort((a,b)=>a.top-b.top);
      return {rail:rail.getBoundingClientRect().width,wraps:labels.every(label=>getComputedStyle(label).whiteSpace==='normal'),
        clipped:labels.some(label=>label.scrollWidth>label.clientWidth+1||label.scrollHeight>label.clientHeight+1),
        overlaps:boxes.some((box,i)=>i>0&&box.top<boxes[i-1].bottom-1),border:getComputedStyle(rail).borderInlineEndWidth,
        overflow:document.documentElement.scrollWidth>innerWidth}; })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, rail: (decodeNumber)(record["rail"]), wraps: (decodeBoolean)(record["wraps"]), clipped: (decodeBoolean)(record["clipped"]), overlaps: (decodeBoolean)(record["overlaps"]), border: (decodeString)(record["border"]), overflow: (decodeBoolean)(record["overflow"]) } })
    expect(layout.rail).toBe(256)
    expect(layout.wraps).toBe(true)
    expect(layout.clipped).toBe(false)
    expect(layout.overlaps).toBe(false)
    expect(layout.border).toBe("0px")
    expect(layout.overflow).toBe(false)
  } finally { await page.close() }
}, 20000)

test("Team overview inspects reported direct children without leaving the master conversation", async () => {
  const page = await fixture("view=chat&presentation=conversation&team=two&childTranscript=images&images=1&childQuestion=1")
  try {
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.team-view__task')`); attempt++) await Bun.sleep(50)
    expect(await page.evaluate(`!!document.querySelector('[aria-label="Expand Team"]')`)).toBe(true)
    await page.evaluate(`document.querySelector('[aria-label="Expand Team"]').click()`)
    expect(await page.evaluate(`!!document.querySelector('.team-overview')`)).toBe(true)
    const before = await page.evaluate("location.href")
    await page.evaluate(`document.querySelector('.team-overview [data-action="inspect-child"]').click()`)
    expect(await page.evaluate(`!!document.querySelector('[aria-label="Selected child"]')`)).toBe(true)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.team-conversation__message')`); attempt++) await Bun.sleep(50)
    expect(await page.evaluate(`document.querySelectorAll('.team-conversation__message').length`)).toBeGreaterThan(0)
    expect(await page.evaluate(`document.querySelector('.team-overview__children').getBoundingClientRect().bottom<innerHeight`)).toBe(true)
    expect(await page.evaluate(`!!document.querySelector('[aria-label="Blockers and escalations"]')`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('[aria-label="Blockers and escalations"]').textContent`)).toContain("May I update the scoped tests?")
    expect(await page.evaluate("location.href")).toBe(before)
    expect(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('.team-conversation').textContent`)).not.toContain("[Image 1]")
    expect(await page.evaluate(`document.querySelector('.team-conversation').textContent`)).not.toContain("[Image 2]")
    await page.evaluate(`document.querySelector('.team-conversation__message:last-of-type').scrollIntoView({block:'end'})`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`[...document.querySelectorAll('.team-conversation .transcript-image img')].filter(image=>image.naturalWidth>0).length === 3`); attempt++) await Bun.sleep(50)
    expect(await page.evaluate(`document.querySelectorAll('.team-conversation .transcript-image img').length`)).toBe(3)
    expect(await page.evaluate(`(()=>{const file=[...document.querySelectorAll('.team-conversation .transcript-file')].find(element=>element.textContent.includes('notes.txt'));return !!file && !file.closest('.team-conversation__prompt')})()`)).toBe(true)
    await page.pressEscape()
    for (let attempt = 0; attempt < 80 && await page.evaluate(`!!document.querySelector('.overlay--team-overview[open]')`, decodeBoolean); attempt++) await Bun.sleep(50)
    expect(await page.evaluate(`document.activeElement===document.querySelector('[aria-label="Expand Team"]')`)).toBe(true)
  } finally { await page.close() }
}, 20000)

for (const [state, failure] of [
  ["ready", undefined],
  ["unavailable", "Child conversation is unavailable because the relay request limit was reached."],
  ["failed", "Child conversation: Child snapshots are unavailable on this connector."],
  ["mismatched", "The device returned a different or unreadable child conversation."],
] as const) test(`selected child transcript ${state} response preserves the master and explicit refresh recovery`, async () => {
  const page = await fixture(`view=chat&presentation=conversation&team=two&childTranscript=${state}`)
  const wait = async (condition: string) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await page.evaluate(condition)) return
      await Bun.sleep(25)
    }
    throw new Error(`Child transcript condition did not settle: ${condition}`)
  }
  try {
    const before = await page.evaluate(`({url:location.href,selected:window.providerAuthState().activeSessionID,master:window.providerAuthState().view.messages.map(message=>message.id)})`, (value: unknown) => { const record = decodeRecord(value); return { ...record, url: (decodeString)(record["url"]), selected: (decodeString)(record["selected"]), master: (decodeArray(decodeString))(record["master"]) } })
    expect(before.selected).toBe("ses_fixture")
    expect(before.master).toContain("msg_user")
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    await wait(`!!document.querySelector('.team-view__task')`)
    await page.evaluate(`document.querySelector('[aria-label="Expand Team"]').click()`)
    await page.evaluate(`document.querySelector('.team-overview [data-action="inspect-child"]').click()`)
    await wait(`!!document.querySelector('.team-conversation[aria-busy="false"]') && window.childSnapshotReads.length===1`)
    expect(await page.evaluate(`window.childSnapshotReads`)).toEqual([{ sessionID: "ses_child", input: { limit: 40 } }])
    if (failure) {
      expect(await page.evaluate(`document.querySelector('.team-conversation [role="alert"]')?.textContent`)).toBe(failure)
      expect(await page.evaluate(`document.querySelectorAll('.team-conversation__message').length`)).toBe(0)
      expect(await page.evaluate(`document.querySelector('.team-conversation').textContent.includes('ses_wrong_child')`)).toBe(false)
      await page.evaluate(`document.querySelector('.team-conversation__heading button').click()`)
      await wait(`!!document.querySelector('.team-conversation[aria-busy="false"]') && window.childSnapshotReads.length===2`)
    }
    expect(await page.evaluate(`document.querySelector('.team-conversation__prompt').textContent`)).toBe("Prompt from ses_child.")
    expect(await page.evaluate(`document.querySelector('.team-conversation').textContent`)).toContain("Transcript from ses_child.")
    expect(await page.evaluate(`document.querySelector('.team-conversation .transcript-tool').textContent`)).toContain("Tool output from ses_child.")
    expect(await page.evaluate(`document.querySelectorAll('.team-conversation [role="alert"]').length`)).toBe(0)
    expect(await page.evaluate(`window.childSnapshotReads.length`)).toBe(failure ? 2 : 1)
    await page.evaluate(`document.querySelectorAll('.team-overview [data-action="inspect-child"]')[1].click()`)
    await wait(`document.querySelector('.team-conversation__prompt')?.textContent==='Prompt from ses_second.'`)
    expect(await page.evaluate(`document.querySelector('.team-conversation').textContent`)).toContain("Transcript from ses_second.")
    expect(await page.evaluate(`document.querySelector('.team-conversation').textContent`)).not.toContain("Transcript from ses_child.")
    expect(await page.evaluate(`window.childSnapshotReads.at(-1)`)).toEqual({ sessionID: "ses_second", input: { limit: 40 } })
    expect(await page.evaluate(`({url:location.href,selected:window.providerAuthState().activeSessionID,master:window.providerAuthState().view.messages.map(message=>message.id)})`)).toEqual(before)
  } finally { await page.close() }
}, 20000)

test("Project coordination inspects members and reported requests without switching the attached Session", async () => {
  const page = await browser.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?scenario=coordination-projects-1440`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('[aria-label="Open project Release train"]')`); attempt++) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('[aria-label="Open project Release train"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('[aria-label="Expand project coordination"]')`); attempt++) await Bun.sleep(50)
    const before = await page.evaluate("location.href")
    await page.evaluate(`document.querySelector('[aria-label="Expand project coordination"]').click()`)
    expect(await page.evaluate(`document.querySelectorAll('.project-coordination [data-action="inspect-member"]').length`)).toBe(5)
    expect(await page.evaluate(`document.querySelector('[aria-label="Project pending requests"]').textContent`)).toContain("Which column should checkout read?")
    await page.evaluate(`document.querySelectorAll('.project-coordination [data-action="inspect-member"]')[1].click()`)
    expect(await page.evaluate(`!!document.querySelector('[aria-label="Selected project member"]')`)).toBe(true)
    expect(await page.evaluate("location.href")).toBe(before)
    expect(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true)
    await page.pressEscape()
    for (let attempt = 0; attempt < 80 && await page.evaluate(`!!document.querySelector('.overlay--project-coordination[open]')`, decodeBoolean); attempt++) await Bun.sleep(50)
    expect(await page.evaluate(`document.activeElement===document.querySelector('[aria-label="Expand project coordination"]')`)).toBe(true)
  } finally { await page.close() }
}, 20000)

test("expanded Team keeps four reported children and a flush 320px inspector beside the master", async () => {
  const page = await fixture("ledger=1&view=chat&presentation=conversation&team=four&childQuestion=1&childTranscript=1")
  try {
    await page.setReducedMotion(true)
    await page.evaluate(`document.querySelector('[aria-label="Open Team"]').click()`)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.team-view__task')`); attempt++) await Bun.sleep(50)
    await page.evaluate(`document.querySelector('[aria-label="Expand Team"]').click()`)
    await page.evaluate(`document.querySelector('.team-overview [data-action="inspect-child"]').click()`)
    const result = await page.evaluate(`(()=>{const inspector=document.querySelector('.team-overview__inspector'),box=inspector.getBoundingClientRect();return{children:document.querySelectorAll('.team-overview__child').length,width:box.width,right:box.right,border:getComputedStyle(document.querySelector('.team-overview__master')).borderTopWidth,state:document.querySelector('.team-overview__child .team-view__state').textContent.trim()}})()`)
    expect(result).toEqual({ children: 4, width: 320, right: 1440, border: "0px", state: "running" })
    expect(await page.evaluate(`document.documentElement.scrollWidth<=innerWidth`)).toBe(true)
    expect(await page.evaluate(`document.querySelectorAll('.team-overview__blocker').length`)).toBe(2)
    for (let attempt = 0; attempt < 80 && !await page.evaluate(`!!document.querySelector('.team-conversation__message')`); attempt++) await Bun.sleep(50)
    expect(await page.evaluate(`document.querySelectorAll('.team-conversation__message').length`)).toBeGreaterThan(0)
    expect(await page.evaluate(`document.querySelectorAll('.team-overview__child .team-view__state')[1].textContent.trim()`)).toBe("supervising")
    const before = await page.evaluate("location.href")
    await page.evaluate(`(()=>{const input=document.querySelector('.team-overview [aria-label="Answer subagent question"]');input.value='Proceed with the scoped tests';input.dispatchEvent(new InputEvent('input',{bubbles:true}));document.querySelector('.team-overview .team-answer button[type="submit"]').click();})()`)
    for (let attempt = 0; attempt < 80 && await page.evaluate(`document.querySelectorAll('.team-overview__blocker').length===2`, decodeBoolean); attempt++) await Bun.sleep(50)
    expect(await page.evaluate(`document.querySelectorAll('.team-overview__blocker').length`)).toBe(1)
    expect(await page.evaluate("location.href")).toBe(before)
  } finally { await page.close() }
}, 20000)
