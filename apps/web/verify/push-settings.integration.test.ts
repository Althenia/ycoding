import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { launchBrowser } from "./cdp"

const port = 4417
const executable = process.env.YCODING_WEB_CHROME
if (!executable) throw new Error("Set YCODING_WEB_CHROME to an installed Chromium or Chrome executable.")
let server: ReturnType<typeof Bun.spawn> | undefined
let browser: Awaited<ReturnType<typeof launchBrowser>> | undefined

beforeAll(async () => {
  server = Bun.spawn(["bun", "run", "dev", "--", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "ignore", stderr: "ignore",
  })
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await fetch(`http://127.0.0.1:${port}/verify/push-settings-fixture.html`).then((response) => response.ok, () => false)) {
      browser = await launchBrowser(executable, 1024, 900)
      return
    }
    await Bun.sleep(100)
  }
  throw new Error("Push settings fixture did not start")
})
afterAll(async () => { await browser?.close(); server?.kill(); if (server) await server.exited })

const platform = (initial: { readonly permission: "default" | "granted"; readonly subscribed: boolean }) => `(() => {
  const state = window.__push = { permission: ${JSON.stringify(initial.permission)}, posts: [], tests: [], unsubscribed: 0, gates: {}, answers: {} };
  const gate = (name) => new Promise((resolve) => { state.gates[name] = resolve });
  state.heldStorage = [];
  const listen = window.addEventListener.bind(window);
  window.addEventListener = (type, listener, options) => type === 'storage'
    ? listen(type, (event) => state.holdStorage ? state.heldStorage.push(() => listener(event)) : listener(event), options)
    : listen(type, listener, options);
  Object.defineProperty(Notification, 'permission', { configurable: true, get: () => state.permission });
  Notification.requestPermission = async () => { if (state.holdPermission) await gate('permission'); state.permission = 'granted'; return 'granted' };
  const key = new Uint8Array(65); key[0] = 4;
  const subscription = { endpoint: 'https://fcm.googleapis.com/send/fixture', options: { applicationServerKey: key.buffer },
    getKey: (name) => new Uint8Array(name === 'p256dh' ? 65 : 16).buffer,
    unsubscribe: async () => { state.unsubscribed += 1; state.subscribed = false; return true } };
  state.subscribed = ${initial.subscribed};
  const registration = { pushManager: { getSubscription: async () => state.subscribed ? subscription : null,
    subscribe: async () => { state.subscribed = true; return subscription } } };
  Object.defineProperty(ServiceWorkerContainer.prototype, 'ready', { configurable: true, get: () => Promise.resolve(registration) });
  const network = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.pathname === '/api/push/key') {
      if (state.holdKey) await gate('key');
      return Response.json({ publicKey: 'BA' + 'A'.repeat(85) });
    }
    if (url.pathname === '/api/push/subscriptions') {
      const body = init && init.body ? JSON.parse(init.body) : undefined;
      state.posts.push({ method: init && init.method, body });
      if (state.holdPost) await gate('post' + state.posts.length);
      const failure = state.answers.post;
      return failure ? Response.json({ error: { code: 'internal_error', message: failure } }, { status: 503 }) : Response.json({ subscribed: true });
    }
    if (url.pathname === '/api/push/test') {
      state.tests.push(init && init.body ? JSON.parse(init.body) : undefined);
      if (state.holdTest) await gate('test');
      const answer = state.answers.test || { status: 200, body: { outcome: 'accepted', status: 201 } };
      return Response.json(answer.body, { status: answer.status });
    }
    return network(input, init);
  };
})()`

async function open(initial: { readonly permission: "default" | "granted"; readonly subscribed: boolean }, keepStorage = false) {
  if (!browser) throw new Error("Browser not started")
  const page = await browser.openPage()
  await page.injectOnNewDocument(platform(initial))
  await page.navigate(`http://127.0.0.1:${port}/verify/push-settings-fixture.html`)
  if (!keepStorage) {
    await page.evaluate(`localStorage.clear()`)
    await page.navigate(`http://127.0.0.1:${port}/verify/push-settings-fixture.html`)
  }
  await until(page, `document.querySelector('[aria-label="Push to this device"]') !== null && !document.querySelector('[aria-label="Push to this device"]').textContent.includes('Checking')`)
  return page
}

async function until(page: { evaluate: <T>(expression: string) => Promise<T> }, expression: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await page.evaluate<boolean>(expression)) return
    await Bun.sleep(30)
  }
  throw new Error(`Timed out waiting for ${expression}`)
}

const toggle = (label: string) => `document.querySelector('[aria-label="${label} via System"]').click()`
const lastCategories = `window.__push.posts.filter(post => post.method === 'POST').at(-1)?.body?.categories`
const status = `document.getElementById('push-device-status').textContent`
const pushButton = `document.querySelector('[aria-label="Push to this device"]')`

describe("Settings push to this device", () => {
  test("System switches changed during the permission prompt, key read, and registration all reach the relay in order", async () => {
    const page = await open({ permission: "default", subscribed: false })
    try {
      await page.evaluate(`window.__push.holdPermission = true; window.__push.holdKey = true; window.__push.holdPost = true`)
      await page.evaluate(`${pushButton}.click()`)
      await until(page, `window.__push.gates.permission !== undefined`)
      expect(await page.evaluate<string>(`${pushButton}.textContent`)).toBe("Checking…")
      await page.evaluate(toggle("Work finished"))
      await page.evaluate(`window.__push.gates.permission()`)
      await until(page, `window.__push.gates.key !== undefined`)
      await page.evaluate(toggle("Machine offline"))
      await page.evaluate(`window.__push.gates.key()`)
      await until(page, `window.__push.posts.length === 1`)
      expect(await page.evaluate<unknown>(lastCategories)).toEqual({ "agent-completed": false, "approval-requested": true, "machine-offline": false })
      await page.evaluate(toggle("Needs your attention"))
      await Bun.sleep(100)
      expect(await page.evaluate<number>(`window.__push.posts.length`)).toBe(1)
      await page.evaluate(`window.__push.gates.post1()`)
      await until(page, `window.__push.posts.length === 2`)
      expect(await page.evaluate<unknown>(lastCategories)).toEqual({ "agent-completed": false, "approval-requested": false, "machine-offline": false })
      await page.evaluate(`window.__push.gates.post2()`)
      await until(page, `${pushButton}.textContent === 'Turn off'`)
      expect(await page.evaluate<string>(status)).toBe("Push is registered on this device for the System alerts chosen above.")
    } finally { await page.close() }
  })

  test("two open Settings pages keep each other's System choices", async () => {
    const first = await open({ permission: "granted", subscribed: true })
    const second = await open({ permission: "granted", subscribed: true }, true)
    try {
      await until(second, `${pushButton}.textContent === 'Turn off'`)
      await first.evaluate(toggle("Work finished"))
      await until(second, `!document.querySelector('[aria-label="Work finished via System"]').checked`)
      await second.evaluate(toggle("Machine offline"))
      await until(second, `window.__push.posts.length === 2`)
      expect(await second.evaluate<unknown>(lastCategories)).toEqual({ "agent-completed": false, "approval-requested": true, "machine-offline": false })
      expect(await first.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.notifications'))`)).toMatchObject({
        "agent-completed": { desktop: false }, "machine-offline": { desktop: false } })
    } finally { await first.close(); await second.close() }
  })

  test("a page whose storage event has not arrived yet keeps another page's System choice", async () => {
    const first = await open({ permission: "granted", subscribed: true })
    const second = await open({ permission: "granted", subscribed: true }, true)
    try {
      await until(first, `${pushButton}.textContent === 'Turn off'`)
      await until(second, `${pushButton}.textContent === 'Turn off'`)
      await second.evaluate(`window.__push.holdStorage = true`)
      await first.evaluate(toggle("Work finished"))
      await until(first, `window.__push.posts.length === 2`)
      await until(second, `window.__push.heldStorage.length === 1`)
      expect(await second.evaluate<boolean>(`document.querySelector('[aria-label="Work finished via System"]').checked`)).toBe(true)
      await second.evaluate(toggle("Machine offline"))
      await until(second, `window.__push.posts.length === 2`)
      expect(await second.evaluate<unknown>(lastCategories)).toEqual({ "agent-completed": false, "approval-requested": true, "machine-offline": false })
      expect(await second.evaluate<unknown>(`JSON.parse(localStorage.getItem('ycoding.notifications'))`)).toMatchObject({
        "agent-completed": { desktop: false }, "machine-offline": { desktop: false } })
      await second.evaluate(`window.__push.holdStorage = false; window.__push.heldStorage.splice(0).forEach(deliver => deliver())`)
      expect(await second.evaluate<boolean>(`document.querySelector('[aria-label="Work finished via System"]').checked`)).toBe(false)
    } finally { await first.close(); await second.close() }
  })

  test("a failed save says the choice stayed on this device", async () => {
    const page = await open({ permission: "granted", subscribed: true })
    try {
      await until(page, `${pushButton}.textContent === 'Turn off'`)
      await page.evaluate(`window.__push.answers.post = 'Web Push is unavailable'`)
      await page.evaluate(toggle("Work finished"))
      await until(page, `${status}.startsWith('Saved on this device only')`)
      expect(await page.evaluate<string>(status)).toBe("Saved on this device only. Closed-app alerts still use the previous choice: Web Push is unavailable")
      expect(await page.evaluate<boolean>(`document.querySelector('[aria-label="Work finished via System"]').checked`)).toBe(false)
    } finally { await page.close() }
  })

  test("Send test alert stays busy until the relay answers, then reports acceptance, refusal, or an expired subscription", async () => {
    const page = await open({ permission: "granted", subscribed: true })
    const testButton = `[...document.querySelectorAll('button')].find(button => button.textContent === 'Send test alert')`
    try {
      await until(page, `${pushButton}.textContent === 'Turn off'`)
      await page.evaluate(`window.__push.holdTest = true; ${testButton}.click()`)
      await until(page, `window.__push.gates.test !== undefined`)
      expect(await page.evaluate<{ test: boolean; push: boolean }>(`({ test: ${testButton}.disabled, push: ${pushButton}.disabled })`)).toEqual({ test: true, push: true })
      expect(await page.evaluate<unknown>(`window.__push.tests`)).toEqual([{ endpoint: "https://fcm.googleapis.com/send/fixture" }])
      await page.evaluate(`window.__push.gates.test()`)
      await until(page, `${status}.startsWith('The push service accepted')`)
      expect(await page.evaluate<boolean>(`${testButton}.disabled`)).toBe(false)
      await page.evaluate(`window.__push.holdTest = false; window.__push.answers.test = { status: 200, body: { outcome: 'rejected', status: 403 } }; ${testButton}.click()`)
      await until(page, `${status} === 'The push service refused the test alert (HTTP 403).'`)
      expect(await page.evaluate<string>(`${pushButton}.textContent`)).toBe("Retry setup")
      await page.evaluate(`window.__push.answers.test = { status: 200, body: { outcome: 'expired', status: 410 } }; ${pushButton}.click()`)
      await until(page, `${pushButton}.textContent === 'Turn off'`)
      await page.evaluate(`${testButton}.click()`)
      await until(page, `${pushButton}.textContent === 'Re-enable'`)
      expect(await page.evaluate<string>(status)).toBe("The push service reports this subscription expired. Use Re-enable to register this device again.")
      expect(await page.evaluate<{ unsubscribed: number; visible: boolean }>(`({ unsubscribed: window.__push.unsubscribed, visible: ${testButton} !== undefined })`)).toEqual({ unsubscribed: 1, visible: false })
    } finally { await page.close() }
  })
})
