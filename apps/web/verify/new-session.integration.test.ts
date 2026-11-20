import { afterAll, beforeAll, expect, test } from "bun:test"
import { launchBrowser, decodeArray, decodeBoolean, decodeNumber, decodeRecord, decodeString } from "./cdp"
import { chooseWorkspace } from "./workspace-controls"

const port = 4326
const browserPath = process.env.YCODING_WEB_CHROME
if (!browserPath) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

test("new chat retains its draft across navigation and preserves it when choosing a required repository", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1`)
    await wait(page, `document.querySelector('.new-session-composer textarea') !== null`)
    expect(await page.evaluate(`document.querySelectorAll('.new-session-composer > p').length`)).toBe(1)
    expect(await page.evaluate(`document.querySelector('.new-session-composer__helper').textContent`)).toContain("requires selecting a repository")
    expect(await page.evaluate(`document.querySelector('.new-session-composer__repository').classList.contains('new-session-composer__repository--required')`)).toBe(true)
    expect(await page.evaluate(`(() => {
      const repo = document.querySelector('.new-session-composer button[aria-label="Repository"]');
      const helper = document.querySelector('.new-session-composer__helper');
      const card = document.querySelector('.new-session-composer .composer__row');
      const send = document.querySelector('.new-session-composer .mini-composer__send');
      const repoStyle = getComputedStyle(repo);
      const sendStyle = getComputedStyle(send);
      return {
        ariaRequired: repo.getAttribute('aria-required'),
        describedByMatches: repo.getAttribute('aria-describedby') === helper.id && helper.id.length > 0,
        badge: repo.querySelector('.mini-picker__badge')?.textContent?.trim() ?? null,
        compact: repo.getBoundingClientRect().width < card.getBoundingClientRect().width / 2,
        neutralFill: repoStyle.backgroundColor !== sendStyle.backgroundColor && repoStyle.borderColor !== sendStyle.backgroundColor,
      };
    })()`)).toEqual({ ariaRequired: "true", describedByMatches: true, badge: "Required", compact: true, neutralFill: true })
    expect(await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]').disabled`)).toBe(true)
    await type(page, ".new-session-composer textarea", "Separate draft")
    await pickLandingRepository(page, "YCoding")
    expect(await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"] .mini-picker__badge') === null`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('.new-session-composer textarea').value`)).toBe("Separate draft")
    expect(await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]').disabled`)).toBe(false)
    expect(await page.evaluate(`document.querySelector('.new-session-composer__helper').textContent`)).toContain("Starting in YCoding")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]').click()`)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.create')`)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.prompt' && item.input?.text === 'Separate draft')`)
    expect(await page.evaluate(`window.remoteMutationReport().find(item => item.operation === 'session.prompt' && item.input?.text === 'Separate draft')?.input?.text`)).toBe("Separate draft")
  } finally { await page.close() }
}, 30_000)

test("keyboard repository selection preserves the draft and sends with Enter", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`)
    await type(page, ".new-session-composer textarea", "Keyboard flow draft")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]').focus()`)
    await page.pressKey("ArrowDown", "ArrowDown", 40)
    await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `document.querySelector('.mini-picker__surface') === null`)
    expect(await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]')?.textContent?.trim()`)).toBe("Other repository")
    expect(await page.evaluate(`document.activeElement === document.querySelector('.new-session-composer button[aria-label="Repository"]')`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('.new-session-composer textarea').value`)).toBe("Keyboard flow draft")
    await page.evaluate(`document.querySelector('.new-session-composer textarea').focus()`)
    await page.pressKey("Enter", "Enter", 13)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.create')`)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.prompt' && item.input?.text === 'Keyboard flow draft')`)
    expect(await page.evaluate(`window.remoteMutationReport().find(item => item.operation === 'session.create')?.input`)).toMatchObject({ workspace: "workspace_other" })
  } finally { await page.close() }
}, 30_000)

test("new chat with optional repository keeps send ready and never emits required copy", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&repositoryOptional=1`)
    await wait(page, `document.querySelector('.new-session-composer textarea') !== null`)
    expect(await page.evaluate(`document.querySelector('.new-session-composer__repository').classList.contains('new-session-composer__repository--required')`)).toBe(false)
    expect(await page.evaluate(`document.querySelector('.new-session-composer__helper').textContent`)).toContain("optional")
    expect(await page.evaluate(`document.querySelector('.new-session-composer__helper').textContent`)).not.toMatch(/requires selecting/i)
    expect(await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]').disabled`)).toBe(false)
    await type(page, ".new-session-composer textarea", "Standalone optional draft")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]').click()`)
    await wait(page, `window.requestLog.some(item => item.operation === 'session.create')`)
    expect(await page.evaluate(`window.requestLog.find(item => item.operation === 'session.create')?.input`)).toMatchObject({ directory: "/workspace/standalone", prompt: { text: "Standalone optional draft" } })
  } finally { await page.close() }
}, 30_000)

test("a draft and attachments remain editable without an available repository", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&workspaces=recoverable`)
    await wait(page, `document.querySelector('.new-session-composer [role="status"]')?.textContent.includes('No previously opened repositories')`)
    expect(await page.evaluate(`document.querySelector('.new-session-composer textarea').disabled`)).toBe(false)
    await type(page, ".new-session-composer textarea", "Keep this draft")
    await page.evaluate(`(() => { const input=document.querySelector('.new-session-composer input[type=file]'); const files=new DataTransfer(); files.items.add(new File(['hello'],'draft.txt')); input.files=files.files; input.dispatchEvent(new Event('change',{bubbles:true})); })()`)
    await wait(page, `document.querySelector('.new-session-composer .composer__attachments-summary')`)
    expect(await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]').disabled`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('.new-session-composer [role="status"]').textContent`)).toContain("draft stays here")
    await page.pressKey("Enter", "Enter", 13)
    expect(await page.evaluate(`document.querySelector('.new-session-composer textarea').value`)).toBe("Keep this draft")
    expect(await page.evaluate(`window.requestLog.filter(item => item.operation === 'session.create').length`)).toBe(0)
    await page.evaluate(`window.remoteExposeWorkspaces(); document.querySelector('[aria-label="Refresh repositories"]').click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`)
    await pickLandingRepository(page, "YCoding")
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="New chat"]:not([disabled])')`)
    expect(await page.evaluate(`document.querySelector('.new-session-composer textarea').value`)).toBe("Keep this draft")
    expect(await page.evaluate(`document.querySelector('.new-session-composer .composer__attachments-summary') !== null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("a file still being read survives repository selection", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&workspaces=recoverable`)
    await wait(page, `document.querySelector('.new-session-composer [role="status"]')?.textContent.includes('No previously opened repositories')`)
    await page.evaluate(`(() => { const original = File.prototype.arrayBuffer; File.prototype.arrayBuffer = function() { return new Promise(resolve => { window.releaseFile = () => { File.prototype.arrayBuffer = original; void original.call(this).then(resolve) } }) }; const input = document.querySelector('.new-session-composer input[type=file]'), files = new DataTransfer(); files.items.add(new File(['hello'], 'draft.txt')); input.files = files.files; input.dispatchEvent(new Event('change', { bubbles: true })); })()`)
    await wait(page, `typeof window.releaseFile === 'function'`)
    await page.evaluate(`window.remoteExposeWorkspaces(); document.querySelector('[aria-label="Refresh repositories"]').click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`)
    await pickLandingRepository(page, "YCoding")
    await page.evaluate(`window.releaseFile()`)
    await wait(page, `document.querySelector('.new-session-composer .composer__attachments-summary')`)
    expect(await page.evaluate(`document.querySelector('.new-session-composer .composer__attachments-summary').textContent`)).toContain("1/64 files")
  } finally { await page.close() }
}, 30_000)

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
    expect(await page.evaluate(`document.querySelector('.conversation-breadcrumb [aria-label="New conversation"]') === null`)).toBe(true)
    await page.evaluate(`document.querySelector('.workspace-new-session .new-session__trigger').click()`)
    await wait(page, `document.querySelector('.route-panel:not([inert]) .new-session-composer textarea') !== null`)
    expect(await page.evaluate(`new URL(location.href).pathname`)).toBe("/remote")
    expect(await page.evaluate(`new URL(location.href).searchParams.get('workspace_id')`)).toBeNull()
    expect(await page.evaluate(`new URL(location.href).searchParams.get('device_id')`)).toBe("dev_studio")
    await page.evaluate(`document.querySelector('.workspace-resume[href^="/remote/session?"]').click()`)
    await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong') !== null`)
    expect(await page.evaluate(`new URL(location.href).pathname`)).toBe("/remote/session")
    expect(await page.evaluate(`new URL(location.href).searchParams.get('session_id')`)).toBe("ses_fixture")
    expect(await page.evaluate(`new URL(location.href).searchParams.get('device_id')`)).toBe("dev_studio")
    expect(await page.evaluate(`window.requestLog.filter(item => item.operation === 'session.create').length`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("Session without a selected ID settles to its empty state rather than loading forever", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=session&noSelection=1`)
    await wait(page, `window.remoteInventoryReport().listStatus === 'ready'`)
    expect(await page.evaluate(`document.querySelector('.remote-conversation-view:not([inert]) .empty-conversation') !== null`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('.remote-conversation-view:not([inert]) .loading-placeholder--screen') === null`)).toBe(true)
    expect(await page.evaluate(`window.requestLog.filter(item => item.operation === 'session.create').length`)).toBe(0)
  } finally { await page.close() }
}, 30_000)

test("choosing a Session from Sessions hands focus to its selected workspace heading", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
    await wait(page, `document.querySelector('.sessions-table__select') !== null`)
    await page.evaluate(`[...document.querySelectorAll('.sessions-table__select')].find(item => item.textContent.includes('Archived: release notes')).click()`)
    await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong')?.textContent?.includes('Archived: release notes') === true`)
    expect(await page.evaluate(`document.activeElement === document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb')`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("the first inventory read holds a named loading frame before Conversation reveals its landing", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&inventoryGate=1`)
    await wait(page, `window.requestLog.some(item => item.operation === 'workspace.list' && item.input?.sessionsOnly === true)`)
    expect(await page.evaluate(`document.querySelector('.route-panel:not([inert]) .loading-placeholder--screen') !== null`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('.route-panel:not([inert]) .new-session-composer') === null`)).toBe(true)
    await page.evaluate(`window.remoteReleaseInventory()`)
    await wait(page, `document.querySelector('.route-panel:not([inert]) .new-session-composer') !== null`)
  } finally { await page.evaluate(`window.remoteReleaseInventory?.()`); await page.close() }
}, 30_000)

test("a workspace plus button locks its source repository instead of choosing the first repository", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions&inventoryCount=20`)
    await wait(page, `document.querySelector('.sessions-page__workspace-select [aria-label="Workspace"]') !== null`)
    await chooseWorkspace(page, "Other repository")
    await wait(page, `document.querySelector('.sessions-page__content .sessions-page__toolbar .new-session__trigger:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.sessions-page__content .sessions-page__toolbar .new-session__trigger').click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]') !== null`)
    expect(await page.evaluate(`(() => { const repository = document.querySelector('.new-session-composer button[aria-label="Repository"]'); const params = new URL(location.href).searchParams; return { label: repository.textContent.trim(), locked: repository.disabled, workspace: params.get('workspace_id'), source: params.get('source') } })()`)).toMatchObject({ label: "Other repository", locked: true, workspace: "workspace_other", source: "sessions" })
    await type(page, ".new-session-composer textarea", "Stay in this repository")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]').click()`)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.create')`)
    expect(await page.evaluate(`window.remoteMutationReport().find(item => item.operation === 'session.create').input`)).toMatchObject({ workspace: "workspace_other" })
  } finally { await page.close() }
}, 30_000)

for (const notice of [false, true]) test(`notification selects its owning machine before opening its Session${notice ? " and reading its notice" : " without a notice ID"}`, async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong') !== null`)
    await page.evaluate(`window.remoteDeviceRequests.length = 0; window.dispatchEvent(new CustomEvent('ycoding:open-session', { detail: { sessionID: 'ses_fixture', deviceID: 'dev_laptop'${notice ? ", noticeID: 'ntc_3'" : ""} } }))`)
    await wait(page, `window.remoteDeviceRequests.some(item => item.operation === 'session.subscribe' && item.deviceID === 'dev_laptop')`)
    expect(await page.evaluate(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe').map(item => ({ deviceID: item.deviceID, sessionID: item.sessionID }))`)).toEqual([{ deviceID: "dev_laptop", sessionID: "ses_fixture" }])
    expect(await page.evaluate(`new URL(location.href).searchParams.get('device_id')`)).toBe("dev_laptop")
    expect(await page.evaluate(`new URL(location.href).searchParams.get('session_id')`)).toBe("ses_fixture")
    if (notice) {
      await wait(page, `window.remoteDeviceRequests.some(item => item.operation === 'notice.read')`)
      expect(await page.evaluate(`window.remoteDeviceRequests.filter(item => item.operation === 'notice.read').map(item => item.deviceID)`)).toEqual(["dev_laptop"])
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
    expect(await page.evaluate(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe')`)).toEqual([])
    expect(await page.evaluate(`document.querySelector('.remote-conversation-view:not([inert])') === null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("a malformed device in a Session URL cannot fall back to the selected machine", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&session_id=ses_fixture&device_id=${encodeURIComponent(JSON.stringify(["dev_laptop"]))}`)
    await wait(page, `document.body.innerText.includes('Session link is invalid')`)
    expect(await page.evaluate(`window.remoteDeviceRequests.filter(item => item.operation === 'session.subscribe')`)).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("a Session link preserves its machine and Session through the sign-in redirect", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&account=signedout&session_id=ses_fixture&device_id=dev_laptop`)
    await wait(page, `document.querySelector('.sign-in__provider') !== null`)
    await page.evaluate(`document.querySelector('.sign-in__provider').click()`)
    await wait(page, `location.pathname === '/api/auth/google/start'`)
    const destination = await page.evaluate(`new URL(location.href).searchParams.get('redirect_after')`, decodeString)
    expect(new URL(destination, "https://example.invalid").searchParams.get("session_id")).toBe("ses_fixture")
    expect(new URL(destination, "https://example.invalid").searchParams.get("device_id")).toBe("dev_laptop")
  } finally { await page.close() }
}, 30_000)

test("an unavailable origin repository blocks creation instead of replacing it", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&workspace_id=workspace_missing&source=sessions`)
    await wait(page, `document.body.innerText.includes('originating repository is unavailable')`)
    expect(await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]').disabled`)).toBe(true)
    expect(await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]').disabled`)).toBe(true)
    expect(await page.evaluate(`window.requestLog.filter(item => item.operation === 'session.create').length`)).toBe(0)
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
    expect(await page.evaluate(`document.body.innerText`)).toContain("Streaming through the relay with bounded tool output.")
    expect(await page.evaluate(`document.body.innerText`)).not.toContain("An older session snapshot arrived and was ignored.")
    expect(await page.evaluate(`document.querySelector('.remote-conversation-view:not([inert]) .loading-placeholder--screen') === null`)).toBe(true)
  } finally { await page.close() }
}, 30_000)

test("new session opens in the main area with repository names, selected model and prompt", async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=sessions`)
    await wait(page, `document.querySelector('.sessions-page__content .sessions-page__toolbar .new-session__trigger:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.workspace-new-session .new-session__trigger')?.click()`)
    await wait(page, `document.querySelector('.workspace__main .new-session-composer textarea') !== null`)
    expect(await page.evaluate(`document.querySelector('dialog[aria-label="New session"]') === null`)).toBe(true)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]')?.click()`)
    await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
    expect(await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].map(item => item.textContent.trim())`)).toEqual(["YCoding", "Other repository"])
    await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.trim() === 'Other repository')?.click()`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Model"]:not([disabled])') !== null`)
    await type(page, ".new-session-composer textarea", "Start a new task")
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]')?.click()`)
    await wait(page, `window.remoteMutationReport().some(item => item.operation === 'session.create')`)
    expect(await page.evaluate(`window.remoteMutationReport().find(item => item.operation === 'session.create')?.input`)).toMatchObject({ workspace: "workspace_other", model: { providerID: "anthropic", id: "claude-opus-5-5", variant: "high" } })
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
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="New chat"]:not([disabled])') !== null`)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]')?.click()`)
    await wait(page, `document.querySelector('.new-session__outcome--unknown') !== null`)
    expect(await page.evaluate(`document.querySelector('.new-session__outcome--unknown')?.textContent`)).toContain("Check Sessions before dismissing")
    await page.evaluate(`document.querySelector('.new-session__outcome--unknown button')?.click()`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)
    expect(await page.evaluate(`window.remoteMutationReport().filter(item => item.operation === 'session.create').length`)).toBe(1)
  } finally { await page.close() }
}, 30_000)

for (const command of [false, true]) test(`first ${command ? "command" : "prompt"} keeps its attachment upload when the created Conversation opens`, async () => {
  const page = await browser!.openPage()
  try {
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&attachmentGate=1`)
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`)
    await pickLandingRepository(page, "YCoding")
    await wait(page, `document.querySelector('.new-session-composer button[aria-label="New chat"]:not([disabled])') !== null`)
    await type(page, ".new-session-composer textarea", command ? "/plan Inspect screenshot" : "Inspect screenshot")
    await page.evaluate(`(() => { const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(30_000)], 'capture.png', { type: 'image/png' })); document.querySelector('.new-session-composer .composer__row').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })); })()`)
    await wait(page, `document.querySelector('.new-session-composer .composer__attachment') !== null`)
    await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="New chat"]').click()`)
    await wait(page, `document.querySelector('.workspace__topbar:not([inert]) .conversation-breadcrumb strong')?.textContent?.trim() === 'New session'`)
    expect(await page.evaluate(`window.requestLog.filter(item => item.operation === 'session.subscribe').length`)).toBe(1)
    expect(await page.evaluate(`document.querySelector('.composer-resident:not([inert]) .composer__upload')?.textContent ?? ''`)).toContain("capture.png · 0%")
    await page.evaluate(`window.remoteReleaseAttachments()`)
    const operation = command ? "session.command" : "session.prompt"
    await wait(page, `window.remoteMutationReport().some(item => item.operation === '${operation}')`)
    const sent = await page.evaluate(`window.remoteMutationReport().filter(item => item.operation === '${operation}')`, decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, input: ((value: unknown) => { const record = decodeRecord(value); return { ...record, files: (decodeArray((value: unknown) => { const record = decodeRecord(value); return { ...record, uri: (decodeString)(record["uri"]), name: (decodeString)(record["name"]) } }))(record["files"]) } })(record["input"]) } }))
    expect(sent).toHaveLength(1)
    expect(sent[0]?.input.files).toEqual([{ uri: expect.stringMatching(/^ycoding-upload:\/\//), name: "capture.png" }])
    expect(await page.evaluate(`document.body.innerText`)).not.toContain("cancelled by Session selection")
  } finally { await page.evaluate(`window.remoteReleaseAttachments?.()`); await page.close() }
}, 30_000)

test("new-session landing centers on desktop, stays compact on phone, and remains top-scrollable on a short phone", async () => {
  for (const noSelection of [false, true]) for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]]) for (const theme of ["light", "dark"]) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width!, height!)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=${theme}${noSelection ? "&noSelection=1" : ""}`)
      if (!noSelection) {
        if (width! < 768) {
          await page.evaluate(`document.querySelector('[aria-label="Open sessions"]')?.click()`)
          await wait(page, `document.querySelector('.overlay--sessions-sheet .new-session__trigger:not([disabled])') !== null`)
          await page.evaluate(`document.querySelector('.overlay--sessions-sheet .new-session__trigger')?.click()`)
        } else {
          await wait(page, `document.querySelector('.workspace__rail .workspace__new-chat:not([disabled])') !== null`)
          await page.evaluate(`document.querySelector('.workspace__rail .workspace__new-chat')?.click()`)
        }
      }
      await wait(page, `document.querySelector('.workspace__scroll .new-session-composer textarea') !== null`)
      if (width === 390 || width === 1440) expect(await page.evaluate(`document.querySelector('.new-session-composer__close, .new-session-composer [aria-label="Close new session"], .new-session-composer__brand') === null`)).toBe(true)
      const measure = () => page.evaluate(`(() => { const scroll=document.querySelector('.workspace__scroll'), block=scroll.querySelector('.new-session-composer'), header=block.querySelector('.new-session-composer__header'), repository=block.querySelector('.new-session-composer__repository'), card=block.querySelector('.composer__row'), helper=block.querySelector('.new-session-composer__helper'), s=scroll.getBoundingClientRect(), b=block.getBoundingClientRect(), h=header.getBoundingClientRect(), c=card.getBoundingClientRect(), r=repository.getBoundingClientRect(), hp=helper.getBoundingClientRect(); return { centerX:Math.abs((b.left+b.right-s.left-s.right)/2), centerY:Math.abs((h.top+hp.bottom-s.top-s.bottom)/2), repositoryEdge:Math.abs(r.left-c.left), ordered:h.bottom<=r.top && r.bottom<=c.top && c.bottom<=hp.top, overflow:document.documentElement.scrollWidth>innerWidth || scroll.scrollWidth>scroll.clientWidth+1 } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, centerX: (decodeNumber)(record["centerX"]), centerY: (decodeNumber)(record["centerY"]), repositoryEdge: (decodeNumber)(record["repositoryEdge"]), ordered: (decodeBoolean)(record["ordered"]), overflow: (decodeBoolean)(record["overflow"]) } })
      const layout = await measure()
      expect(layout.centerX).toBeLessThanOrEqual(8)
      if (width! >= 768) expect(layout.centerY).toBeLessThanOrEqual(8)
      expect(layout.repositoryEdge).toBeLessThanOrEqual(1)
      expect(layout.ordered).toBe(true)
      expect(layout.overflow).toBe(false)
      if (width !== 390) continue
      await page.setViewport(390, 320)
      const short = await page.evaluate(`(() => { const scroll=document.querySelector('.workspace__scroll'), header=scroll.querySelector('.new-session-composer__header'), card=scroll.querySelector('.new-session-composer .composer__row'); const top=header.getBoundingClientRect().top-scroll.getBoundingClientRect().top; const scrollable=scroll.scrollHeight>scroll.clientHeight; scroll.scrollTop=scroll.scrollHeight; return { top, scrollTop:scroll.scrollTop, scrollable, composerReachable:card.getBoundingClientRect().bottom<=scroll.getBoundingClientRect().bottom-8, overflow:document.documentElement.scrollWidth>innerWidth } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, top: (decodeNumber)(record["top"]), scrollTop: (decodeNumber)(record["scrollTop"]), scrollable: (decodeBoolean)(record["scrollable"]), composerReachable: (decodeBoolean)(record["composerReachable"]), overflow: (decodeBoolean)(record["overflow"]) } })
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
      const loading = await page.evaluate(`(() => { const row=document.querySelector('.new-session-composer__repository'), placeholder=row.querySelector('.loading-placeholder--repository'), shape=placeholder.querySelector('.loading-placeholder__shape').getBoundingClientRect(), refresh=row.querySelector('.new-session-composer__refresh'); return { width:shape.width, height:shape.height, left:shape.left, refresh:refresh.getBoundingClientRect().left, announced:placeholder.getAttribute('role')==='status' && placeholder.textContent.includes('Loading previously opened repositories…'), pickerAbsent:row.querySelector('[aria-label="Repository"]')===null, disabled:refresh.disabled } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), height: (decodeNumber)(record["height"]), left: (decodeNumber)(record["left"]), refresh: (decodeNumber)(record["refresh"]), announced: (decodeBoolean)(record["announced"]), pickerAbsent: (decodeBoolean)(record["pickerAbsent"]), disabled: (decodeBoolean)(record["disabled"]) } })
      expect(loading.announced).toBe(true)
      expect(loading.pickerAbsent).toBe(true)
      expect(loading.disabled).toBe(true)
      expect(loading.height).toBe(width! < 768 ? 44 : 36)
      await page.evaluate(`window.composerSetWorkspaceLoading(false)`)
      await wait(page, `document.querySelector('.new-session-composer__repository button[aria-label="Repository"]') !== null`)
      const ready = await page.evaluate(`(() => { const row=document.querySelector('.new-session-composer__repository'), picker=row.querySelector('[aria-label="Repository"]').getBoundingClientRect(); return { width:picker.width, height:picker.height, left:picker.left, refresh:row.querySelector('.new-session-composer__refresh').getBoundingClientRect().left } })()`, (value: unknown) => { const record = decodeRecord(value); return { ...record, width: (decodeNumber)(record["width"]), height: (decodeNumber)(record["height"]), left: (decodeNumber)(record["left"]), refresh: (decodeNumber)(record["refresh"]) } })
      expect(Math.abs(ready.width - loading.width)).toBeLessThanOrEqual(1)
      expect(Math.abs(ready.height - loading.height)).toBeLessThanOrEqual(1)
      expect(Math.abs(ready.left - loading.left)).toBeLessThanOrEqual(1)
      expect(Math.abs(ready.refresh - loading.refresh)).toBeLessThanOrEqual(1)
    } finally { await page.close() }
  }
}, 30_000)

test("phone Sessions drawer stays full-height at the left with search, selection and five navigation destinations", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(390, 844)
    await page.setCoarsePointer(true)
    await page.setReducedMotion(true)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=dark&paletteAcceptance=1`)
    await wait(page, `document.querySelector('.composer__input') !== null`)
    await page.evaluate(`(()=>{window.sessionsOpener=document.querySelector('.app-header__menu[aria-label="Open sessions"]');window.sessionsOpener.focus();window.sessionsOpener.click()})()`)
    await wait(page, `document.querySelector('.overlay--sessions-sheet[open] .session-row') !== null`)
    const drawer = await page.evaluate(`(()=>{const d=document.querySelector('.overlay--sessions-sheet'),s=d.querySelector('.overlay__surface'),b=s.getBoundingClientRect(),nav=d.querySelector('.bottom-nav'),links=[...d.querySelectorAll('.bottom-nav__item')],n=nav?.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height,radius:getComputedStyle(s).borderRadius,focus:d.contains(document.activeElement),destinations:links.map(e=>e.textContent.trim()),targets:links.every(e=>{const r=e.getBoundingClientRect();return r.width>=44&&r.height>=44}),contained:!!n&&n.top>=b.top&&n.bottom<=b.bottom}})()`)
    expect(drawer).toEqual({ x: 0, y: 0, width: 320, height: 844, radius: "0px", focus: true, destinations: ["Projects", "Sessions", "Workspaces", "Usage", "Settings"], targets: true, contained: true })
    await type(page, '.overlay--sessions-sheet [aria-label="Search sessions"]', "Archived")
    await wait(page, `document.querySelectorAll('.overlay--sessions-sheet .session-row').length===1 && document.querySelector('.overlay--sessions-sheet .session-row').textContent.includes('Archived: release notes')`)
    await page.evaluate(`document.querySelector('.overlay--sessions-sheet .session-row').click()`)
    await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Archived: release notes')===true && document.querySelector('.overlay--sessions-sheet')===null`)
    expect(await page.evaluate(`document.activeElement===window.sessionsOpener`)).toBe(true)
    await page.evaluate(`window.sessionsOpener.click()`)
    await wait(page, `document.querySelector('.overlay--sessions-sheet[open]')!==null`)
    await page.evaluate(`(()=>{const d=document.querySelector('.overlay--sessions-sheet');window.drawerFirst=d.querySelector('button');window.drawerLast=[...d.querySelectorAll('a[href],button,input')].filter(e=>e.getClientRects().length&&!e.disabled).at(-1);window.drawerLast.focus()})()`)
    await page.pressKey("Tab", "Tab", 9)
    expect(await page.evaluate(`document.activeElement===window.drawerFirst`)).toBe(true)
    await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true,cancelable:true}))`)
    expect(await page.evaluate(`document.activeElement===window.drawerLast`)).toBe(true)
    await page.pressKey("Escape", "Escape", 27)
    await wait(page, `document.querySelector('.overlay--sessions-sheet')===null`)
    expect(await page.evaluate(`document.activeElement===window.sessionsOpener`)).toBe(true)
    await page.evaluate(`window.sessionsOpener.click()`)
    await wait(page, `document.querySelector('.overlay--sessions-sheet[open]')!==null`)
    await page.evaluate(`document.querySelector('.overlay--sessions-sheet .overlay__close').click()`)
    await wait(page, `document.querySelector('.overlay--sessions-sheet')===null`)
    expect(await page.evaluate(`document.activeElement===window.sessionsOpener`)).toBe(true)
    await page.evaluate(`window.sessionsOpener.click()`)
    await wait(page, `document.querySelector('.overlay--sessions-sheet[open]')!==null`)
    await page.evaluate(`document.querySelector('.overlay--sessions-sheet a[href="/remote/usage"]').click()`)
    await wait(page, `document.querySelector('.usage-page')!==null&&document.querySelector('.overlay--sessions-sheet')===null`)
    expect(await page.evaluate(`[...document.querySelectorAll('.app > .bottom-nav .bottom-nav__item')].every(e=>e.getBoundingClientRect().height>=44)`)).toBe(true)
    await page.evaluate(`document.querySelector('.app-header__menu[aria-label="Open sessions"]').click()`)
    await wait(page, `document.querySelector('.overlay--sessions-sheet[open]')!==null`)
    await page.evaluate(`document.querySelector('.overlay--sessions-sheet .new-session__trigger').click()`)
    await wait(page, `document.querySelector('.new-session-composer')!==null&&document.querySelector('.overlay--sessions-sheet')===null`)
  } finally { await page.close() }
}, 30000)

test("phone Sessions drawer enters from the left and keeps its closing surface inert", async () => {
  const page = await browser!.openPage()
  try {
    await page.setViewport(390, 844)
    await page.setCoarsePointer(true)
    await page.setReducedMotion(false)
    await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&theme=dark`)
    await wait(page, `document.querySelector('.composer__input')!==null`)
    await page.setAnimationPlaybackRate(0)
    await page.evaluate(`(()=>{window.sessionsOpener=document.querySelector('.app-header__menu[aria-label="Open sessions"]');window.sessionsOpener.focus();window.sessionsOpener.click()})()`)
    await wait(page, `document.querySelector('.overlay--sessions-sheet[open]')!==null`)
    expect(await page.evaluate(`(()=>{const s=document.querySelector('.overlay--sessions-sheet .overlay__surface'),css=getComputedStyle(s);return parseFloat(css.translate)<0&&s.getBoundingClientRect().y===0})()`)).toBe(true)
    await page.setAnimationPlaybackRate(1)
    await page.evaluate(`Promise.all(document.querySelector('.overlay--sessions-sheet .overlay__surface').getAnimations().map(a=>a.finished))`)
    await page.evaluate(`document.querySelector('.overlay--sessions-sheet .overlay__close').click()`)
    expect(await page.evaluate(`(()=>{const d=document.querySelector('.overlay--sessions-sheet');return !!d&&!d.open&&d.inert&&d.getAttribute('aria-hidden')==='true'&&document.activeElement===window.sessionsOpener})()`)).toBe(true)
    await wait(page, `document.querySelector('.overlay--sessions-sheet')===null`)
  } finally { await page.close() }
}, 15000)

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
      expect(await page.evaluate(`document.activeElement === window.sessionsOpener && window.sessionsOpener.getAttribute('aria-expanded') === 'false'`)).toBe(true)
      if (reduced) expect(await page.evaluate(`document.querySelector('dialog.overlay--sessions-sheet') === null`)).toBe(true)
      else {
        expect(await page.evaluate(`(() => { const sheet=document.querySelector('dialog.overlay--sessions-sheet'); return sheet?.inert === true && sheet?.getAttribute('aria-hidden') === 'true' && !sheet.open })()`)).toBe(true)
        for (let attempt = 0; attempt < 30 && await page.evaluate(`document.querySelector('dialog.overlay--sessions-sheet') !== null`, decodeBoolean); attempt += 1) await Bun.sleep(25)
        expect(await page.evaluate(`document.querySelector('dialog.overlay--sessions-sheet') === null`)).toBe(true)
      }
      if (method === "select") {
        await wait(page, `document.querySelector('.conversation-breadcrumb strong')?.textContent?.includes('Archived: release notes') === true`)
        expect(await page.evaluate(`document.activeElement === window.sessionsOpener`)).toBe(true)
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

test("repository picker keeps a compact neutral layout and cobalt focus-visible ring across viewports and themes", async () => {
  const luminance = (rgb: string) => {
    const channels = rgb.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
    if (!channels || channels.length !== 3) throw new Error(`Expected RGB color, got ${rgb}`)
    return channels.map((c) => c / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, idx) => sum + c * [0.2126, 0.7152, 0.0722][idx]!, 0)
  }
  const contrast = (fg: string, bg: string) => {
    const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a)
    return (hi! + 0.05) / (lo! + 0.05)
  }
  for (const theme of ["light", "dark"] as const) for (const [width, height] of [[1440, 900], [1000, 600], [390, 844]] as const) {
    const page = await browser!.openPage()
    try {
      await page.setViewport(width, height)
      await page.setColorScheme(theme)
      await page.navigate(`http://127.0.0.1:${port}/verify/remote.html?view=chat&noSelection=1&theme=${theme}`)
      await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`)
      await page.evaluate(`(() => {
        const repo = document.querySelector('.new-session-composer button[aria-label="Repository"]');
        const all = [...document.querySelectorAll('a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])')]
          .filter(el => el.getClientRects().length > 0 && !el.closest('[inert],[aria-hidden="true"]'));
        const idx = all.indexOf(repo);
        if (idx > 0) all[idx - 1].focus();
      })()`)
      await page.pressKey("Tab", "Tab", 9)
      const report = await page.evaluate(`(() => {
        const repo = document.querySelector('.new-session-composer button[aria-label="Repository"]');
        const refresh = document.querySelector('.new-session-composer__refresh');
        const card = document.querySelector('.new-session-composer .composer__row');
        const send = document.querySelector('.new-session-composer .mini-composer__send');
        const repoRect = repo.getBoundingClientRect();
        const refreshRect = refresh.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        const repoStyle = getComputedStyle(repo);
        const sendStyle = getComputedStyle(send);
        const pageBg = getComputedStyle(document.body).backgroundColor;
        return {
          focused: document.activeElement === repo,
          focusVisible: repo.matches(':focus-visible'),
          outlineStyle: repoStyle.outlineStyle,
          outlineWidth: parseFloat(repoStyle.outlineWidth),
          outlineColor: repoStyle.outlineColor,
          pageBg,
          repoBg: repoStyle.backgroundColor,
          repoBorder: repoStyle.borderColor,
          sendBg: sendStyle.backgroundColor,
          repoWidth: repoRect.width,
          cardWidth: cardRect.width,
          alignedLeft: Math.abs(repoRect.left - cardRect.left) <= 1,
          refreshBeside: refreshRect.left >= repoRect.right && Math.abs(refreshRect.top - repoRect.top) <= 6,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
        };
      })()`, (value: unknown) => {
        const record = decodeRecord(value)
        return {
          focused: decodeBoolean(record["focused"]),
          focusVisible: decodeBoolean(record["focusVisible"]),
          outlineStyle: decodeString(record["outlineStyle"]),
          outlineWidth: decodeNumber(record["outlineWidth"]),
          outlineColor: decodeString(record["outlineColor"]),
          pageBg: decodeString(record["pageBg"]),
          repoBg: decodeString(record["repoBg"]),
          repoBorder: decodeString(record["repoBorder"]),
          sendBg: decodeString(record["sendBg"]),
          repoWidth: decodeNumber(record["repoWidth"]),
          cardWidth: decodeNumber(record["cardWidth"]),
          alignedLeft: decodeBoolean(record["alignedLeft"]),
          refreshBeside: decodeBoolean(record["refreshBeside"]),
          overflow: decodeBoolean(record["overflow"]),
        }
      })
      expect(report.focused).toBe(true)
      expect(report.focusVisible).toBe(true)
      expect(report.outlineStyle).toBe("solid")
      expect(report.outlineWidth).toBeGreaterThanOrEqual(2)
      expect(contrast(report.outlineColor, report.pageBg)).toBeGreaterThanOrEqual(3)
      expect(contrast(report.outlineColor, report.repoBg)).toBeGreaterThanOrEqual(3)
      expect(report.outlineColor).not.toBe(report.repoBorder)
      expect(report.repoBg).not.toBe(report.sendBg)
      expect(report.repoBorder).not.toBe(report.sendBg)
      expect(report.alignedLeft).toBe(true)
      expect(report.refreshBeside).toBe(true)
      expect(report.overflow).toBe(false)
      if (width >= 768) expect(report.repoWidth).toBeLessThan(report.cardWidth / 2)
    } finally { await page.close() }
  }
}, 30_000)

async function pickLandingRepository(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, label: string) {
  await wait(page, `document.querySelector('.new-session-composer button[aria-label="Repository"]:not([disabled])') !== null`)
  await page.evaluate(`document.querySelector('.new-session-composer button[aria-label="Repository"]').click()`)
  await wait(page, `document.querySelector('.mini-picker__surface [role="option"]') !== null`)
  await page.evaluate(`[...document.querySelectorAll('.mini-picker__surface [role="option"]')].find(item => item.textContent.trim() === ${JSON.stringify(label)})?.click()`)
  await wait(page, `document.querySelector('.mini-picker__surface') === null`)
}
async function type(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, selector: string, text: string) {
  await page.evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); field.focus(); field.value = ${JSON.stringify(text)}; field.dispatchEvent(new InputEvent('input', { bubbles: true })); })()`)
}
async function wait(page: Awaited<ReturnType<Awaited<ReturnType<typeof launchBrowser>>["openPage"]>>, expression: string) {
  for (let index = 0; index < 50; index++) {
    if (await page.evaluate(expression)) return
    await Bun.sleep(100)
  }
  throw new Error(`Timed out: ${expression}; ${await page.evaluate(`JSON.stringify({ url: location.href, breadcrumb: document.querySelector('.conversation-breadcrumb')?.textContent, composer: document.querySelector('.new-session-composer')?.outerHTML?.slice(0, 800), body: document.body.innerText.slice(-500), requests: window.remoteMutationReport?.().slice(-3) })`, decodeString)} `)
}
async function ready() { return fetch(`http://127.0.0.1:${port}/verify/remote.html`).then((response) => response.ok, () => false) }
