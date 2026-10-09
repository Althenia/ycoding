import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4326
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", `${port}`, "--strictPort"], { cwd: import.meta.dir.replace(/\/verify$/, ""), env: { ...process.env, YCODING_WEB_VERIFY: "1" }, stdout: "ignore", stderr: "ignore" })
  for (let index = 0; index < 60 && !(await ready()); index++) await Bun.sleep(100)
  if (!(await ready())) throw new Error("Vite did not start")
  browser = await launchBrowser(browserPath, 1440, 900)
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

test("New session stays reachable separately from the selected Session and the URL retains its identity", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong') !== null`)
    expect(await page.evaluate<boolean>(`document.querySelector('.conversation-breadcrumb [aria-label="New conversation"]') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.workspace-new-session .new-session__trigger').click()`)
    await wait(page, `document.querySelector('.route-panel:not([inert]) .new-session-composer textarea') !== null`)
    expect(await page.evaluate<string>(`new URL(location.href).pathname`)).toBe("/remote")
    expect(await page.evaluate<string | null>(`new URL(location.href).searchParams.get('workspace_id')`)).toBeNull()
    expect(await page.evaluate<string>(`new URL(location.href).searchParams.get('device_id')`)).toBe("dev_studio")
    await page.evaluate(`document.querySelector('.workspace-resume[href^="/remote/session?"]').click()`)
    await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong') !== null`)
    expect(await page.evaluate<string>(`new URL(location.href).pathname`)).toBe("/remote/session")
    expect(await page.evaluate<string>(`new URL(location.href).searchParams.get('session_id')`)).toBe("ses_fixture")
    expect(await page.evaluate<string>(`new URL(location.href).searchParams.get('device_id')`)).toBe("dev_studio")
    expect(await page.evaluate<number>(`window.requestLog.filter(item => item.operation === 'session.create').length`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("Session without a selected ID settles to its empty state rather than loading forever", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=session&noSelection=1`)
    await wait(page, `window.remoteInventoryReport().listStatus === 'ready'`)
    expect(await page.evaluate<boolean>(`document.querySelector('.remote-conversation-view:not([inert]) .empty-conversation') !== null`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.remote-conversation-view:not([inert]) .loading-placeholder--screen') === null`)).toBe(true)
    expect(await page.evaluate<number>(`window.requestLog.filter(item => item.operation === 'session.create').length`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("choosing a Session from Sessions hands focus to its selected workspace heading", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
    await wait(page, `document.querySelector('.sessions-table__select') !== null`)
    await page.evaluate(`[...document.querySelectorAll('.sessions-table__select')].find(item => item.textContent.includes('Archived: release notes')).click()`)
    await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong')?.textContent?.includes('Archived: release notes') === true`)
    expect(await page.evaluate<boolean>(`document.activeElement === document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb')`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("the first inventory read holds a named loading frame before Conversation reveals its landing", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&inventoryGate=1`)
    await wait(page, `window.requestLog.some(item => item.operation === 'workspace.list' && item.input?.sessionsOnly === true)`)
    expect(await page.evaluate<boolean>(`document.querySelector('.route-panel:not([inert]) .loading-placeholder--screen') !== null`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.route-panel:not([inert]) .new-session-composer') === null`)).toBe(true)
    await page.evaluate(`window.remoteReleaseInventory()`)
    await wait(page, `document.querySelector('.route-panel:not([inert]) .new-session-composer') !== null`)
  } finally { await page.evaluate(`window.remoteReleaseInventory?.()`); await page.close() }
}, 30_000)

test("a workspace plus button locks its source repository instead of choosing the first repository", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=20`)
    await wait(page, `document.querySelector('.workspace-nav button') !== null`)
    await page.evaluate(`[...document.querySelectorAll('.workspace-nav button')].find(item => item.textContent.includes('Other repository')).click()`)
    await wait(page, `document.querySelector('.sessions-page__content .sessions-page__toolbar .new-session__trigger:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.sessions-page__content .sessions-page__toolbar .new-session__trigger').click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]') !== null`)
    expect(await page.evaluate<{ label: string; locked: boolean; workspace: string | null; source: string | null }>(`(() => { const repository = document.querySelector('.new-session-composer button[aria-label="Repository"]'); const params = new URL(location.href).searchParams; return { label: repository.textContent.trim(), locked: repository.disabled, workspace: params.get('workspace_id'), source: params.get('source') } })()`)).toMatchObject({ label: "Other repository", locked: true, workspace: "workspace_other", source: "sessions" })
    await type(page, ".new-session-composer textarea", "Stay in this repository")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]').click()`)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.create')`)
    expect(await page.evaluate<unknown>(`window.remoteMutationReport().find(item => item.operation === 'session.create').input`)).toMatchObject({ workspace: "workspace_other" })
  } finally { await page.close() }
}, 30_000)

for (const notice of [false, true]) test(`notification selects its owning machine before opening its Session${notice ? " and reading its notice" : " without a notice ID"}`, async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong') !== null`)
    await page.evaluate(`window.remoteDeviceRequests.length = 0; window.dispatchEvent(new CustomEvent('ycoding:open-session', { detail: { sessionID: 'ses_fixture', deviceID: 'dev_laptop'${notice ? ", noticeID: 'ntc_3'" : ""} } }))`)
    await wait(page, `window.remoteDeviceRequests.some(item => item.operation === 'session.subscribe' && item.deviceID === 'dev_laptop')`)
    expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe').map(item => ({ deviceID: item.deviceID, sessionID: item.sessionID }))`)).toEqual([{ deviceID: "dev_laptop", sessionID: "ses_fixture" }])
    expect(await page.evaluate<string>(`new URL(location.href).searchParams.get('device_id')`)).toBe("dev_laptop")
    expect(await page.evaluate<string>(`new URL(location.href).searchParams.get('session_id')`)).toBe("ses_fixture")
    if (notice) {
      await wait(page, `window.remoteDeviceRequests.some(item => item.operation === 'notice.read')`)
      expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'notice.read').map(item => item.deviceID)`)).toEqual(["dev_laptop"])
    }
  } finally { await page.close() }
}, 30_000)

test("an unavailable notification machine never opens its Session on the selected machine", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong') !== null`)
    await page.evaluate(`window.remoteDeviceRequests.length = 0; window.dispatchEvent(new CustomEvent('ycoding:open-session', { detail: { sessionID: 'ses_fixture', deviceID: 'dev_unknown' } }))`)
    await wait(page, `document.body.innerText.includes('unavailable to this account')`)
    expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe')`)).toEqual([])
    expect(await page.evaluate<boolean>(`document.querySelector('.remote-conversation-view:not([inert])') === null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("a malformed device in a Session URL cannot fall back to the selected machine", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&session_id=ses_fixture&device_id=${encodeURIComponent(JSON.stringify(["dev_laptop"]))}`)
    await wait(page, `document.body.innerText.includes('Session link is invalid')`)
    expect(await page.evaluate<unknown>(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe')`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("a Session link preserves its machine and Session through the sign-in redirect", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&account=signedout&session_id=ses_fixture&device_id=dev_laptop`)
    await wait(page, `document.querySelector('.sign-in__provider') !== null`)
    await page.evaluate(`document.querySelector('.sign-in__provider').click()`)
    await wait(page, `location.pathname === '/api/auth/google/start'`)
    const destination = await page.evaluate<string>(`new URL(location.href).searchParams.get('redirect_after')`)
    expect(new URL(destination, "https://example.invalid").searchParams.get("session_id")).toBe("ses_fixture")
    expect(new URL(destination, "https://example.invalid").searchParams.get("device_id")).toBe("dev_laptop")
  } finally { await page.close() }
}, 30_000)

test("an unavailable origin repository blocks creation instead of replacing it", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&workspace_id=workspace_missing&source=sessions`)
    await wait(page, `document.body.innerText.includes('originating repository is unavailable')`)
    expect(await page.evaluate<boolean>(`document.querySelector('.new-session-composer button[aria-label="Repository"]').disabled`)).toBe(true)
    expect(await page.evaluate<boolean>(`document.querySelector('.new-session-composer button[aria-label="Create session"]').disabled`)).toBe(true)
    expect(await page.evaluate<number>(`window.requestLog.filter(item => item.operation === 'session.create').length`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("rejecting an older snapshot preserves the displayed live reply without a warning banner", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong') !== null`)
    await page.evaluate(`[...document.querySelectorAll('.fixture__controls button')].find(item => item.textContent.includes('Simulate streaming step')).click()`)
    await wait(page, `document.body.innerText.includes('Streaming through the relay with bounded tool output.')`)
    await page.evaluate(`window.remoteReloadMessages()`)
    expect(await page.evaluate<string>(`document.body.innerText`)).toContain("Streaming through the relay with bounded tool output.")
    expect(await page.evaluate<string>(`document.body.innerText`)).not.toContain("An older session snapshot arrived and was ignored.")
    expect(await page.evaluate<boolean>(`document.querySelector('.remote-conversation-view:not([inert]) .loading-placeholder--screen') === null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("new session opens in the main area with repository names, selected model and prompt", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
    await wait(page, `document.querySelector('.sessions-page__content .sessions-page__toolbar .new-session__trigger:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.workspace-new-session .new-session__trigger')?.click()`)
    await wait(page, `document.querySelector('.workspace__main .new-session-composer textarea') !== null`)
    expect(await page.evaluate<boolean>(`document.querySelector('dialog[aria-label="New session"]') === null`)).toBe(true)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]')?.click()`)
    await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
    expect(await page.evaluate<string[]>(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].map(item => item.textContent.trim())`)).toEqual(["YCoding", "Other repository"])
    await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.trim() === 'Other repository')?.click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Model"]:not([disabled])') !== null`)
    await type(page, ".new-session-composer textarea", "Start a new task")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.create')`)
    expect(await page.evaluate<unknown>(`window.remoteMutationReport().find(item => item.operation === 'session.create')?.input`)).toMatchObject({ workspace: "workspace_other", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } })
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.prompt' && item.input?.text === 'Start a new task')`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)
  } finally { await page.close() }
}, 30_000)

test("unknown creation retries the same admission without a second create", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&creation=unknown`)
    await wait(page, `document.querySelector('.sessions-page__content .sessions-page__toolbar .new-session__trigger:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.sessions-page__content .sessions-page__toolbar .new-session__trigger')?.click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Create session"]:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]')?.click()`)
    await wait(page, `document.querySelector('.new-session__outcome--unknown') !== null`)
    expect(await page.evaluate<string>(`document.querySelector('.new-session__outcome--unknown')?.textContent`)).toContain("Check Sessions before dismissing")
    await page.evaluate(`document.querySelector('.new-session__outcome--unknown button')?.click()`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)
    expect(await page.evaluate<number>(`window.remoteMutationReport().filter(item => item.operation === 'session.create').length`)).toBe(1)
  } finally { await page.close() }
}, 30_000)

for (const command of [false, true]) test(`first ${command ? "command" : "prompt"} keeps its attachment upload when the created Conversation opens`, async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&attachmentGate=1`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Create session"]:not([disabled])') !== null`)
    await type(page, ".new-session-composer textarea", command ? "/plan Inspect screenshot" : "Inspect screenshot")
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(30_000)], 'capture.png', { type: 'image/png' })); document.querySelector('.new-session-composer .composer__row').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); })()`)
    await wait(page, `document.querySelector('.new-session-composer .composer__attachment') !== null`)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Create session"]').click()`)
    await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)
    expect(await page.evaluate<number>(`window.requestLog.filter(item => item.operation === 'session.subscribe').length`)).toBe(1)
    expect(await page.evaluate<string>(`document.querySelector('.composer-resident:not([inert]) .composer__upload')?.textContent ?? ''`)).toContain("capture.png · 0%")
    await page.evaluate(`window.remoteReleaseAttachments()`)
    const operation = command ? "session.command" : "session.prompt"
    await wait(page, `window.remoteMutationReport().some(item => item.operation === '${operation}')`)
    const sent = await page.evaluate<readonly { readonly input: { readonly files: readonly { readonly uri: string; readonly name: string }[] } }[]>(`window.remoteMutationReport().filter(item => item.operation === '${operation}')`)
    expect(sent).toHaveLength(1)
    expect(sent[0]?.input.files).toEqual([{ uri: expect.stringMatching(/^ycoding-upload:\/\//), name: "capture.png" }])
    expect(await page.evaluate<string>(`document.body.innerText`)).not.toContain("cancelled by Session selection")
  } finally { await page.evaluate(`window.remoteReleaseAttachments?.()`); await page.close() }
}, 30_000)

test("new-session hero centers in both Conversation placements and remains top-scrollable on a short phone", async () => {
  for (const noSelection of [false, true]) for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}${noSelection ? "&noSelection=1" : ""}`)
      if (!noSelection) {
        const plus = width! < 768 ? ".overlay--sessions-sheet .pane__head--sessions button" : ".workspace__rail .pane__head--sessions button"
        if (width! < 768) await page.evaluate(`document.querySelector('[aria-label="Open sessions"]')?.click()`)
        await wait(page, `document.querySelector(${JSON.stringify(plus)}+':not([disabled])') !== null`)
        await page.evaluate(`document.querySelector(${JSON.stringify(plus)})?.click()`)
      }
      await wait(page, `document.querySelector('.workspace__scroll .new-session-composer textarea') !== null`)
      if (width === 390 || width === 1440) expect(await page.evaluate<boolean>(`document.querySelector('.new-session-composer__close, .new-session-composer [aria-label="Close new session"]') === null`)).toBe(true)
      const measure = () => page.evaluate<{ centerX: number; centerY: number; repositoryEdge: number; heroRatio: number; mark: number; name: number; fullLockup: boolean; ordered: boolean; overflow: boolean }>(`(() => { const scroll=document.querySelector('.workspace__scroll'), block=scroll.querySelector('.new-session-composer'), brand=block.querySelector('.new-session-composer__brand'), repository=block.querySelector('.new-session-composer__repository'), card=block.querySelector('.composer__row'), mark=brand.querySelector('img'), name=brand.querySelector('.brand__name'), descriptor=brand.querySelector('.brand__descriptor'), s=scroll.getBoundingClientRect(), b=block.getBoundingClientRect(), a=brand.getBoundingClientRect(), c=card.getBoundingClientRect(), r=repository.getBoundingClientRect(); return { centerX:Math.abs((b.left+b.right-s.left-s.right)/2), centerY:Math.abs((a.top+c.bottom-s.top-s.bottom)/2), repositoryEdge:Math.abs(r.left-c.left), heroRatio:a.width/c.width, mark:mark.getBoundingClientRect().height, name:parseFloat(getComputedStyle(name).fontSize), fullLockup:!!descriptor && descriptor.getBoundingClientRect().height>0, ordered:a.bottom<=r.top && r.bottom<=c.top, overflow:document.documentElement.scrollWidth>innerWidth || scroll.scrollWidth>scroll.clientWidth+1 } })()`)
      const layout = await measure()
      expect(layout.centerX).toBeLessThanOrEqual(8)
      expect(layout.centerY).toBeLessThanOrEqual(8)
      expect(layout.repositoryEdge).toBeLessThanOrEqual(1)
      expect(layout.mark).toBeGreaterThanOrEqual(width! < 480 ? 40 : 56)
      expect(layout.name).toBeGreaterThanOrEqual(width! < 480 ? 32 : 40)
      expect(layout.fullLockup).toBe(true)
      expect(layout.heroRatio).toBeGreaterThanOrEqual(width! < 480 ? .5 : .6)
      expect(layout.ordered).toBe(true)
      expect(layout.overflow).toBe(false)
      if (!noSelection) await Bun.write(new URL(`../../../.cache/tmp/new-session-hero-${width}-${theme}.png`, import.meta.url), Buffer.from(await page.screenshot(), "base64"))
      if (width !== 390) continue
      await page.setViewport(390, 320)
      const short = await page.evaluate<{ top: number; scrollTop: number; scrollable: boolean; composerReachable: boolean; overflow: boolean }>(`(() => { const scroll=document.querySelector('.workspace__scroll'), brand=scroll.querySelector('.new-session-composer__brand'), card=scroll.querySelector('.new-session-composer .composer__row'); const top=brand.getBoundingClientRect().top-scroll.getBoundingClientRect().top; const scrollable=scroll.scrollHeight>scroll.clientHeight; scroll.scrollTop=scroll.scrollHeight; return { top, scrollTop:scroll.scrollTop, scrollable, composerReachable:card.getBoundingClientRect().bottom<=scroll.getBoundingClientRect().bottom-8, overflow:document.documentElement.scrollWidth>innerWidth } })()`)
      expect(short.top).toBeGreaterThanOrEqual(8)
      expect(short.top).toBeLessThanOrEqual(48)
      expect(short.scrollable).toBe(true)
      expect(short.scrollTop).toBeGreaterThan(0)
      expect(short.composerReachable).toBe(true)
      expect(short.overflow).toBe(false)
    } finally { await page.close() }
  }
}, 60_000)

test("repository loading holds the picker's box and keeps Refresh in place", async () => {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/composer-fixture.html`)
      await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]') !== null`)
      await page.evaluate(`window.composerSetWorkspaceLoading(true)`)
      await wait(page, `document.querySelector('.new-session-composer__repository .loading-placeholder--repository') !== null`)
      const loading = await page.evaluate<{ width: number; height: number; left: number; refresh: number; announced: boolean; pickerAbsent: boolean; disabled: boolean }>(`(() => { const row=document.querySelector('.new-session-composer__repository'), placeholder=row.querySelector('.loading-placeholder--repository'), shape=placeholder.querySelector('.loading-placeholder__shape').getBoundingClientRect(), refresh=row.querySelector('.new-session-composer__refresh'); return { width:shape.width, height:shape.height, left:shape.left, refresh:refresh.getBoundingClientRect().left, announced:placeholder.getAttribute('role')==='status' && placeholder.textContent.includes('Loading previously opened repositories…'), pickerAbsent:row.querySelector('[aria-label="Repository"]')===null, disabled:refresh.disabled } })()`)
      expect(loading.announced).toBe(true)
      expect(loading.pickerAbsent).toBe(true)
      expect(loading.disabled).toBe(true)
      expect(loading.height).toBe(width! < 768 ? 44 : 36)
      await page.evaluate(`window.composerSetWorkspaceLoading(false)`)
      await wait(page, `document.querySelector('.new-session-composer__repository button[aria-label="Repository"]') !== null`)
      const ready = await page.evaluate<{ width: number; height: number; left: number; refresh: number }>(`(() => { const row=document.querySelector('.new-session-composer__repository'), picker=row.querySelector('[aria-label="Repository"]').getBoundingClientRect(); return { width:picker.width, height:picker.height, left:picker.left, refresh:row.querySelector('.new-session-composer__refresh').getBoundingClientRect().left } })()`)
      expect(Math.abs(ready.width - loading.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(ready.height - loading.height)).toBeLessThanOrEqual(1)
      expect(Math.abs(ready.left - loading.left)).toBeLessThanOrEqual(1)
      expect(Math.abs(ready.refresh - loading.refresh)).toBeLessThanOrEqual(1)
    } finally { await page.close() }
  }
}, 30_000)

test("phone Sessions sheet returns focus to its opener and opens Conversation from New session", async () => {
  for (const theme of ["light", "dark"]) for (const [reduced, method] of [[false, "close"], [false, "select"], [false, "new-session"], [true, "close"]] as const) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(390, 844)
      await page.setReducedMotion(reduced)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}`)
      await wait(page, `document.querySelector('.app-header__menu[aria-label="Open sessions"]') !== null`)
      await page.evaluate(`(() => { const trigger=document.querySelector('.app-header__menu'); window.sessionsOpener=trigger; trigger.focus() })()`)
      await page.pressKey(" ", "Space", 32)
      await wait(page, `document.querySelector('dialog.overlay--sessions-sheet[open] .session-row') !== null`)
      if (method === "close") await page.evaluate(`document.querySelector('.overlay--sessions-sheet .overlay__close').click()`)
      if (method === "select") await page.evaluate(`[...document.querySelectorAll('.overlay--sessions-sheet .session-row')].find((row) => row.textContent.includes('Archived: release notes'))?.click()`)
      if (method === "new-session") await page.evaluate(`document.querySelector('.overlay--sessions-sheet .new-session__trigger').click()`)
      expect(await page.evaluate<boolean>(`document.activeElement === window.sessionsOpener && window.sessionsOpener.getAttribute('aria-expanded') === 'false'`)).toBe(true)
      if (reduced) expect(await page.evaluate<boolean>(`document.querySelector('dialog.overlay--sessions-sheet') === null`)).toBe(true)
      else {
        expect(await page.evaluate<boolean>(`(() => { const sheet=document.querySelector('dialog.overlay--sessions-sheet'); return sheet?.inert === true && sheet?.getAttribute('aria-hidden') === 'true' && !sheet.open })()`)).toBe(true)
        for (let attempt = 0; attempt < 30 && await page.evaluate<boolean>(`document.querySelector('dialog.overlay--sessions-sheet') !== null`); attempt += 1) await Bun.sleep(25)
        expect(await page.evaluate<boolean>(`document.querySelector('dialog.overlay--sessions-sheet') === null`)).toBe(true)
      }
      if (method === "select") {
        await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Archived: release notes') === true`)
        expect(await page.evaluate<boolean>(`document.activeElement === window.sessionsOpener`)).toBe(true)
      }
      if (method === "new-session") {
        await wait(page, `document.querySelector('.new-session-composer textarea') !== null`)
        await page.evaluate(`window.sessionsOpener.focus()`)
        await page.pressKey(" ", "Space", 32)
        await wait(page, `document.querySelector('dialog.overlay--sessions-sheet[open] .session-row') !== null`)
        await page.evaluate(`[...document.querySelectorAll('.overlay--sessions-sheet .session-row')].find((row) => row.textContent.includes('Archived: release notes'))?.click()`)
        await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Archived: release notes') === true`)
        await wait(page, `document.activeElement === document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb')`)
      }
    } finally { await page.close() }
  }
}, 90_000)

async function type(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, selector: string, text: string) {
  await page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}
async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}; ${await page.evaluate<string>(`JSON.stringify({ url: location.href, breadcrumb: document.querySelector('.conversation-breadcrumb')?.textContent, composer: document.querySelector('.new-session-composer')?.outerHTML?.slice(0, 800), body: document.body.innerText.slice(-500), requests: window.remoteMutationReport?.().slice(-3) })`)} `)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false) }
