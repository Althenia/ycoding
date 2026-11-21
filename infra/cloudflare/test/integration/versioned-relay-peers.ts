import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import type { WebSocketOptions } from "bun"
import { enroll, generateDeviceKey, signChallenge } from "../../../../packages/cli/src/remote-credentials"
import { FrameSchema, PeerRole, decodeStrict, type Frame } from "../../../../packages/remote/src/index"
import { TestPeer } from "../../../../packages/remote/test/peer"
import { eventually, isolatedEnvironment, record } from "./versioned-relay-worker"

export type Check = (label: string, run: () => Promise<void>) => Promise<void>
export type Device = { deviceID: string; accessToken: string }
const NativeSocket = WebSocket as typeof WebSocket & { new (url: string, options: WebSocketOptions): WebSocket }

export function connectSocket(url: string, headers: Record<string, string>) {
  return new NativeSocket(url, { headers })
}

export function socketURL(origin: string, version: "v4" | "v5", deviceID?: string) {
  const url = new URL(`/ws/${version}/${deviceID ? "client" : "agent"}`, origin)
  if (deviceID) url.searchParams.set("device", deviceID)
  url.protocol = "ws:"
  return url.toString()
}

export function browserHeaders(origin: string, cookie: string) {
  return { cookie, origin, "sec-fetch-site": "same-origin" }
}

export async function registration(origin: string, cookie: string) {
  const response = await fetch(`${origin}/api/devices/enrollments`, {
    method: "POST",
    headers: browserHeaders(origin, cookie),
  })
  assert.ok(response.ok, `Enrollment creation returned ${response.status}`)
  const body: unknown = await response.json()
  assert.ok(
    record(body) && typeof body.enrollmentID === "string" && typeof body.code === "string",
    "The browser did not receive a one-use enrollment",
  )
  return { enrollmentID: body.enrollmentID, code: body.code }
}

export async function enrollProbe(origin: string, cookie: string, name: string): Promise<Device> {
  const proof = await registration(origin, cookie)
  const key = await generateDeviceKey()
  const { deviceID } = await enroll({ ...proof, ...key, relayURL: origin, name })
  const post = async (operation: string, data: object) => {
    const response = await fetch(`${origin}/api/devices/${operation}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    })
    assert.equal(response.status, 200, `Device ${operation} failed`)
    const result: unknown = await response.json()
    assert.ok(record(result))
    return result
  }
  const { challengeID, nonce } = await post("challenge", { deviceID })
  assert.ok(typeof challengeID === "string" && typeof nonce === "string")
  const signature = await signChallenge(key.privateKey, challengeID, nonce)
  const { accessToken } = await post("token", { deviceID, challengeID, signature })
  assert.ok(typeof accessToken === "string" && accessToken)
  return { deviceID, accessToken }
}

export async function devices(origin: string, cookie: string, version: "v4" | "v5") {
  const response = await fetch(`${origin}/api/devices${version === "v5" ? "?relay=5" : ""}`, { headers: { cookie } })
  assert.equal(response.status, 200, "Browser device inventory")
  const result: unknown = await response.json()
  assert.ok(record(result) && Array.isArray(result.devices))
  return result.devices.map((device: unknown) => {
    assert.ok(
      record(device) &&
        typeof device.id === "string" &&
        typeof device.name === "string" &&
        typeof device.online === "boolean",
    )
    return { id: device.id, name: device.name, online: device.online }
  })
}

export async function authorizationMatrix(
  origin: string,
  owner: string,
  other: string,
  probe: Device,
  foreign: Device,
  check: Check,
) {
  for (const version of ["v4", "v5"] as const) {
    const browser = browserHeaders(origin, owner)
    const cases: { label: string; url: string; status: number; headers: Record<string, string> }[] = [
      { label: "agent absent credential", url: socketURL(origin, version), status: 401, headers: {} },
      {
        label: "agent invalid bearer",
        url: socketURL(origin, version),
        status: 401,
        headers: { authorization: "Bearer invalid-local-token" },
      },
      {
        label: "agent browser cookie instead of a bearer",
        url: socketURL(origin, version),
        status: 401,
        headers: browser,
      },
      {
        label: "client absent credential",
        url: socketURL(origin, version, probe.deviceID),
        status: 401,
        headers: { origin },
      },
      {
        label: "client invalid cookie",
        url: socketURL(origin, version, probe.deviceID),
        status: 401,
        headers: { ...browser, cookie: "yc_session=invalid-local-session" },
      },
      {
        label: "client bearer instead of a browser cookie",
        url: socketURL(origin, version, probe.deviceID),
        status: 401,
        headers: { origin, authorization: `Bearer ${probe.accessToken}` },
      },
      {
        label: "client missing Origin with a valid cookie",
        url: socketURL(origin, version, probe.deviceID),
        status: 403,
        headers: { cookie: owner },
      },
      {
        label: "client foreign Origin with a valid cookie",
        url: socketURL(origin, version, probe.deviceID),
        status: 403,
        headers: { ...browser, origin: "http://unrelated.invalid" },
      },
      {
        label: "other owner's browser cannot reach this device",
        url: socketURL(origin, version, probe.deviceID),
        status: 403,
        headers: browserHeaders(origin, other),
      },
      {
        label: "owner cannot reach another account's device",
        url: socketURL(origin, version, foreign.deviceID),
        status: 403,
        headers: browser,
      },
    ]
    for (const { label, url, status, headers } of cases) {
      await check(`${version} ${label}`, async () => {
        const response = await fetch(url.replace(/^ws:/, "http:"), {
          headers: { upgrade: "websocket", ...headers },
          signal: AbortSignal.timeout(5000),
        })
        assert.equal(response.status, status)
        assert.match(response.headers.get("content-type") ?? "", /^application\/json/)
      })
    }
  }
}

export async function wireMatrix(origin: string, owner: string, probe: Device, check: Check) {
  for (const [name, role, deviceID, headers] of [
    ["agent", PeerRole.AGENT, undefined, { authorization: `Bearer ${probe.accessToken}` }],
    ["client", PeerRole.REMOTE_CLIENT, probe.deviceID, browserHeaders(origin, owner)],
  ] as const) {
    await check(`v4 ${name} rejects a binary WebSocket frame`, async () => {
      await rejectsFrame(socketURL(origin, "v4", deviceID), headers, new Uint8Array([10, 1, 0]), 1003)
    })
    const v5 = socketURL(origin, "v5", deviceID)
    for (const [label, value] of [
      ["text", '{"type":"request","id":"cross","operation":"session.list"}'],
      ["malformed protobuf", new Uint8Array([0xff])],
    ] as const) {
      await check(`v5 ${name} rejects ${label} before any application delivery`, async () => {
        await rejectsFrame(v5, headers, value, 1008, true)
      })
    }
    for (const [label, alter] of [
      [
        "v4 revision",
        (frame: Frame) => {
          frame.revision = 4
          if (frame.body.case === "hello") frame.body.value.revision = 4
        },
      ],
      [
        "wrong role",
        (frame: Frame) => {
          if (frame.body.case === "hello")
            frame.body.value.role = role === PeerRole.AGENT ? PeerRole.REMOTE_CLIENT : PeerRole.AGENT
        },
      ],
    ] as const) {
      await check(`v5 ${name} rejects a valid protobuf Hello with ${label}`, async () => {
        const peer = new TestPeer(v5, headers, role, undefined, (frame) => {
          alter(frame)
          return frame
        })
        try {
          const closed = await Promise.race([peer.closed, Bun.sleep(5000).then(() => undefined)])
          assert.equal(closed?.code, 1008)
          assert.deepEqual(
            peer.raw.map((frame) => frame.body.case),
            [],
            "Rejected Hello disclosed state",
          )
        } finally {
          peer.stop()
        }
      })
    }
  }
}

async function rejectsFrame(
  url: string,
  headers: Record<string, string>,
  payload: string | Uint8Array,
  code: number,
  binary = false,
) {
  const socket = connectSocket(url, headers)
  socket.binaryType = "arraybuffer"
  const received: unknown[] = []
  socket.addEventListener("message", (event) => received.push(event.data))
  socket.addEventListener("open", () => socket.send(payload), { once: true })
  const closed = new Promise<CloseEvent>((resolve) => socket.addEventListener("close", resolve, { once: true }))
  try {
    const result = await Promise.race([closed, Bun.sleep(5000).then(() => undefined)])
    assert.equal(result?.code, code, "The real Durable Object must reject the frame")
    for (const value of received) {
      if (binary) {
        assert.ok(value instanceof ArrayBuffer)
        assert.equal(
          decodeStrict(FrameSchema, new Uint8Array(value)).body.case,
          "hello",
          "Rejected frame disclosed state",
        )
      } else {
        assert.equal(typeof value, "string")
        assert.doesNotMatch(String(value), /"(?:result|response|event)"/, "Rejected frame disclosed state")
      }
    }
  } finally {
    if (socket.readyState < WebSocket.CLOSING) socket.close()
  }
}

export async function startRollback(executable: string, root: string, origin: string, cookie: string) {
  assert.ok(isAbsolute(executable), "Bind YCODING_RELAY_BUN_CLI to the extracted signed Bun 0.12.0 executable")
  const workspace = join(root, "workspace")
  const config = join(root, "fixture-config")
  await mkdir(workspace, { recursive: true })
  await mkdir(config)
  await Bun.write(join(config, "models.json"), "{}")
  const password = crypto.randomUUID()
  const env = {
    ...isolatedEnvironment(root),
    YCODING_CONFIG_DIR: config,
    YCODING_DISABLE_MODELS_FETCH: "1",
    YCODING_CONFIG_PROJECT_DISABLE: "1",
    YCODING_MODELS_PATH: join(config, "models.json"),
    YCODING_PASSWORD: password,
    YCODING_DISABLE_AUTOUPDATE: "1",
  }
  const run = async (args: string[], stdin?: string) => {
    const call = Bun.spawn([executable, ...args], {
      cwd: workspace,
      env,
      stdin: stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    if (stdin !== undefined && typeof call.stdin !== "number" && call.stdin !== undefined) {
      await call.stdin.write(stdin)
      await call.stdin.end()
    }
    const timer = setTimeout(() => call.kill("SIGTERM"), 30_000)
    try {
      const [status, stdout, stderr] = await Promise.all([
        call.exited,
        new Response(call.stdout).text(),
        new Response(call.stderr).text(),
      ])
      assert.equal(
        status,
        0,
        `Rollback CLI ${args.slice(0, 2).join(" ")} failed: ${stderr.replaceAll(password, "[redacted]").slice(-1024)}`,
      )
      return stdout
    } finally {
      clearTimeout(timer)
    }
  }
  assert.match(await run(["--version"]), /\bv0\.12\.0\b/)
  const made = await registration(origin, cookie)
  await run(["remote", "enroll", made.enrollmentID, "--name", "Bun rollback", "--relay", origin], made.code)
  const server = Bun.spawn([executable, "serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: workspace,
    env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = new Response(server.stderr).text()
  const reader = server.stdout.getReader()
  const close = async () => {
    await server.stdin.end()
    const timer = setTimeout(() => server.kill("SIGKILL"), 5000)
    try {
      await server.exited
    } finally {
      clearTimeout(timer)
    }
  }
  try {
    let line = ""
    const decoder = new TextDecoder()
    const timer = setTimeout(() => server.kill("SIGTERM"), 30_000)
    try {
      while (!line.includes("\n")) {
        const next = await reader.read()
        if (next.done) throw new Error(`Bun server did not publish readiness: ${await stderr}`)
        line += decoder.decode(next.value, { stream: true })
      }
    } finally {
      clearTimeout(timer)
    }
    void (async () => {
      try {
        while (!(await reader.read()).done) continue
      } finally {
        reader.releaseLock()
      }
    })().catch(() => undefined)
    const ready: unknown = JSON.parse(line.slice(0, line.indexOf("\n")))
    assert.ok(record(ready) && typeof ready.url === "string")
    const { url } = ready
    assert.equal(new URL(url).hostname, "127.0.0.1")
    const sessionID = "ses_bun_rollback"
    const created = await fetch(new URL("/api/session", url), {
      method: "POST",
      headers: { authorization: `Basic ${btoa(`ycoding:${password}`)}`, "content-type": "application/json" },
      body: JSON.stringify({ id: sessionID, title: "Signed Bun rollback session", location: { directory: workspace } }),
    })
    assert.equal(created.status, 200, "Rollback backend did not create a real Session")
    assert.match(await run(["remote", "connect", "--server", url, "--relay", origin]), /Remote connection on/)
    const device = await eventually("signed Bun agent present on v4", async () =>
      (await devices(origin, cookie, "v4")).find((item) => item.name === "Bun rollback" && item.online),
    )
    return { deviceID: device.id, sessionID, close }
  } catch (error) {
    await close()
    throw error
  }
}

export async function v4SessionList(origin: string, cookie: string, deviceID: string) {
  const socket = connectSocket(socketURL(origin, "v4", deviceID), browserHeaders(origin, cookie))
  const response = Promise.withResolvers<{ ok: boolean; value?: unknown; error?: { code?: string } }>()
  socket.addEventListener(
    "open",
    () => socket.send(JSON.stringify({ type: "request", id: "acceptance", operation: "session.list" })),
    { once: true },
  )
  socket.addEventListener("message", (event) => {
    try {
      assert.equal(typeof event.data, "string", "v4 response was not text")
      const message: unknown = JSON.parse(event.data)
      assert.ok(record(message))
      if (message.id !== "acceptance") return
      assert.ok(typeof message.ok === "boolean")
      const code = record(message.error) && typeof message.error.code === "string" ? message.error.code : undefined
      response.resolve({ ok: message.ok, value: message.value, error: code === undefined ? undefined : { code } })
    } catch (error) {
      response.reject(error)
    }
  })
  socket.addEventListener(
    "close",
    (event) => response.reject(new Error(`v4 browser closed before a response: ${event.code} ${event.reason}`)),
    { once: true },
  )
  const timeout = setTimeout(() => response.reject(new Error("v4 session.list timed out")), 10_000)
  try {
    return await response.promise
  } finally {
    clearTimeout(timeout)
    socket.close()
  }
}
