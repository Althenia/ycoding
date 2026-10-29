import { afterEach, describe, expect, test } from "bun:test"
import net from "node:net"
import {
  CCA_HTTP_NETWORK_ACTION,
  MAX_HTTP_BODY_DELTA_BYTES,
  createCcaHttpHandler,
  type CcaHttpBodyDelta,
  type CcaHttpHandler,
  type CcaHttpRequestParams,
} from "../src/cca/http"
import { CcaExecutorError, type CcaAuthorizationInput } from "../src/cca/errors"

interface CapturedRequest {
  readonly socket: net.Socket
  readonly requestLine: string
  readonly headers: Map<string, string>
  readonly body: Buffer
}

interface LoopbackServer {
  readonly base: string
  readonly next: () => Promise<CapturedRequest>
  readonly connections: () => number
}

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function loopback(): Promise<LoopbackServer> {
  const queued: CapturedRequest[] = []
  const waiting: Array<(request: CapturedRequest) => void> = []
  const sockets = new Set<net.Socket>()
  let connections = 0
  const server = net.createServer((socket) => {
    connections++
    sockets.add(socket)
    socket.on("close", () => sockets.delete(socket))
    socket.on("error", () => {})
    let buffered = Buffer.alloc(0)
    const onData = (data: Buffer) => {
      buffered = Buffer.concat([buffered, data])
      const end = buffered.indexOf("\r\n\r\n")
      if (end < 0) return
      const lines = buffered.subarray(0, end).toString("latin1").split("\r\n")
      const headers = new Map<string, string>()
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":")
        headers.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim())
      }
      const length = Number(headers.get("content-length") ?? "0")
      if (buffered.length < end + 4 + length) return
      socket.off("data", onData)
      const request = {
        socket,
        requestLine: lines[0],
        headers,
        body: buffered.subarray(end + 4, end + 4 + length),
      }
      const waiter = waiting.shift()
      if (waiter) waiter(request)
      else queued.push(request)
    }
    socket.on("data", onData)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("loopback server has no TCP address")
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  )
  return {
    base: `http://127.0.0.1:${address.port}`,
    next: () => {
      const request = queued.shift()
      if (request) return Promise.resolve(request)
      return new Promise<CapturedRequest>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("no HTTP request arrived")), 5_000)
        waiting.push((value) => {
          clearTimeout(timer)
          resolve(value)
        })
      })
    },
    connections: () => connections,
  }
}

function respond(
  request: CapturedRequest,
  status: string,
  headers: ReadonlyArray<readonly [string, string]>,
  body: string | Buffer,
) {
  const payload = typeof body === "string" ? Buffer.from(body) : body
  const extra = headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")
  request.socket.write(
    Buffer.from(
      `HTTP/1.1 ${status}\r\ncontent-type: text/plain\r\ncontent-length: ${payload.length}\r\nconnection: close\r\n${extra}\r\n`,
      "latin1",
    ),
  )
  request.socket.end(payload)
}

function respondChunked(request: CapturedRequest, headers: ReadonlyArray<readonly [string, string]>, chunks: string[], finish = true) {
  const extra = headers.map(([name, value]) => `${name}: ${value}\r\n`).join("")
  request.socket.write(
    `HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\nconnection: close\r\n${extra}\r\n`,
  )
  for (const chunk of chunks) request.socket.write(`${Buffer.byteLength(chunk).toString(16)}\r\n${chunk}\r\n`)
  if (finish) request.socket.end("0\r\n\r\n")
}

interface Harness {
  readonly handler: CcaHttpHandler
  readonly authorizations: CcaAuthorizationInput[]
  readonly released: () => number
  readonly emitted: CcaHttpBodyDelta[]
  readonly run: (params: Partial<CcaHttpRequestParams> & Pick<CcaHttpRequestParams, "url">) => ReturnType<CcaHttpHandler["request"]>
}

function harness(options: { env?: Record<string, string>; deny?: (input: CcaAuthorizationInput) => boolean } = {}): Harness {
  const authorizations: CcaAuthorizationInput[] = []
  let released = 0
  const emitted: CcaHttpBodyDelta[] = []
  const handler = createCcaHttpHandler({
    authorize: async (input) => {
      authorizations.push(input)
      if (options.deny?.(input)) throw new Error("denied")
      return {
        release: async () => {
          released++
        },
      }
    },
    env: options.env ?? {},
  })
  cleanups.push(() => handler.close())
  const signal = new AbortController().signal
  return {
    handler,
    authorizations,
    released: () => released,
    emitted,
    run: (params) =>
      handler.request(
        {
          method: "GET",
          headers: [],
          redirectPolicy: "follow",
          requestId: "request-1",
          streamResponse: false,
          ...params,
        },
        {
          signal,
          emit: (delta) => {
            emitted.push(delta)
          },
        },
      ),
  }
}

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8")

async function rejection(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    if (error instanceof CcaExecutorError) return error
    throw error
  }
  throw new Error("expected rejection")
}

describe("CCA executor http/request", () => {
  test("buffers a response and sends literal and environment-sourced headers", async () => {
    const server = await loopback()
    const h = harness({ env: { NODE_REPL_AUTH_TOKEN: "executor-token", LINEAR_API_KEY: "linear-token" } })
    const url = `${server.base}/mcp?case=buffered`
    const pending = h.run({
      method: "POST",
      url,
      headers: [
        { name: "x-codex-test", value: "buffered" },
        { name: "authorization", value: "Bearer ", valueEnvVar: "NODE_REPL_AUTH_TOKEN" },
        { name: "x-linear-authorization", value: "Bearer ", valueEnvVar: "LINEAR_API_KEY" },
      ],
      body: Buffer.from("request-body"),
      timeoutMs: 5_000,
      requestId: "buffered-request",
    })
    const captured = await server.next()
    expect({
      requestLine: captured.requestLine,
      test: captured.headers.get("x-codex-test"),
      authorization: captured.headers.get("authorization"),
      linear: captured.headers.get("x-linear-authorization"),
      host: captured.headers.get("host"),
      body: captured.body.toString(),
    }).toEqual({
      requestLine: "POST /mcp?case=buffered HTTP/1.1",
      test: "buffered",
      authorization: "Bearer executor-token",
      linear: "Bearer linear-token",
      host: server.base.slice("http://".length),
      body: "request-body",
    })
    respond(captured, "201 Created", [["x-mcp-test", "buffered"]], "response-body")
    const outcome = await pending
    expect(outcome.stream).toBeUndefined()
    expect(outcome.response.status).toBe(201)
    expect(outcome.response.headers.filter((header) => header.name === "x-mcp-test")).toEqual([
      { name: "x-mcp-test", value: "buffered" },
    ])
    expect(text(outcome.response.body)).toBe("response-body")
    expect(h.authorizations).toEqual([
      {
        action: CCA_HTTP_NETWORK_ACTION,
        resources: [url],
        metadata: { method: "POST", headerEnvVars: "NODE_REPL_AUTH_TOKEN,LINEAR_API_KEY" },
      },
    ])
    expect(JSON.stringify(h.authorizations)).not.toContain("-token")
    expect(h.released()).toBe(1)
  })

  test("names the environment variables each hop sends, dropping those removed on a cross-origin redirect", async () => {
    const first = await loopback()
    const second = await loopback()
    const h = harness({ env: { SHARED_TOKEN: "shared-secret", LINEAR_API_KEY: "linear-secret" } })
    const pending = h.run({
      url: `${first.base}/start`,
      headers: [
        { name: "x-plain", value: "plain" },
        { name: "authorization", value: "Bearer ", valueEnvVar: "SHARED_TOKEN" },
        { name: "x-linear-authorization", value: "Bearer ", valueEnvVar: "LINEAR_API_KEY" },
        { name: "x-linear-copy", value: "", valueEnvVar: "LINEAR_API_KEY" },
      ],
    })
    respond(await first.next(), "302 Found", [["location", `${second.base}/next`]], "")
    const hop = await second.next()
    expect([hop.headers.has("authorization"), hop.headers.get("x-linear-authorization")]).toEqual([false, "Bearer linear-secret"])
    respond(hop, "200 OK", [], "done")
    await pending
    expect(h.authorizations.map((input) => input.metadata)).toEqual([
      { method: "GET", headerEnvVars: "SHARED_TOKEN,LINEAR_API_KEY" },
      { method: "GET", headerEnvVars: "LINEAR_API_KEY" },
    ])
    expect(JSON.stringify(h.authorizations)).not.toContain("secret")
  })

  test("moves URL credentials into a Basic authorization header and redacts them everywhere", async () => {
    const server = await loopback()
    const h = harness()
    const host = server.base.slice("http://".length)
    const pending = h.run({ url: `http://us%40er:p%3Ass%20word@${host}/creds?x=1` })
    const captured = await server.next()
    expect({
      requestLine: captured.requestLine,
      authorization: captured.headers.get("authorization"),
      host: captured.headers.get("host"),
    }).toEqual({
      requestLine: "GET /creds?x=1 HTTP/1.1",
      authorization: `Basic ${Buffer.from("us@er:p:ss word").toString("base64")}`,
      host,
    })
    respond(captured, "302 Found", [["location", `http://other:hop-secret@${host}/final`]], "")
    const final = await server.next()
    expect([final.requestLine, final.headers.get("authorization")]).toEqual(["GET /final HTTP/1.1", captured.headers.get("authorization")])
    respond(final, "200 OK", [], "ok")
    expect(text((await pending).response.body)).toBe("ok")
    expect(h.authorizations.map((input) => input.resources)).toEqual([[`${server.base}/creds?x=1`], [`${server.base}/final`]])
    expect(JSON.stringify(h.authorizations)).not.toMatch(/word|secret|us%40er|other/)
  })

  test("URL credentials yield to an explicit authorization header and default to an empty password", async () => {
    const server = await loopback()
    const h = harness()
    const host = server.base.slice("http://".length)
    const explicit = h.run({ url: `http://user:pass@${host}/explicit`, headers: [{ name: "Authorization", value: "Bearer explicit" }] })
    const first = await server.next()
    expect(first.headers.get("authorization")).toBe("Bearer explicit")
    respond(first, "200 OK", [], "")
    await explicit
    const userOnly = h.run({ url: `http://user@${host}/user-only` })
    const second = await server.next()
    expect(second.headers.get("authorization")).toBe(`Basic ${Buffer.from("user:").toString("base64")}`)
    respond(second, "200 OK", [], "")
    await userOnly
  })

  test("failures never echo URL credentials", async () => {
    const closed = await loopback()
    const port = new URL(closed.base).port
    await cleanups.pop()!()
    const h = harness()
    const error = await rejection(h.run({ url: `http://user:hunter2@127.0.0.1:${port}/x` }))
    expect(error).toMatchObject({
      code: -32603,
      message: `http/request failed: error sending request for url (http://127.0.0.1:${port}/x)`,
    })
    const server = await loopback()
    const pending = h.run({ url: `${server.base}/redirect` })
    respond(await server.next(), "302 Found", [["location", "ftp://user:hunter2@127.0.0.1/file"]], "")
    expect(await rejection(pending)).toMatchObject({
      code: -32603,
      message: "http/request failed: builder error for url (ftp://127.0.0.1/file)",
    })
    expect(h.authorizations).toHaveLength(2)
    expect(h.released()).toBe(2)
    expect(JSON.stringify(h.authorizations)).not.toContain("hunter2")
  })

  test("reports url-crate parse errors", async () => {
    const h = harness()
    const cases: Array<[string, string]> = [
      ["not a url", "relative URL without a base"],
      ["http://127.0.0.1:99999/", "invalid port number"],
      ["http://127.0.0.1:8a/", "invalid port number"],
      ["http://:80/", "empty host"],
      ["http://[::1/", "invalid IPv6 address"],
      ["http://[::g]/", "invalid IPv6 address"],
      ["http://1.2.3.256/", "invalid IPv4 address"],
      ["http://exa mple.test/", "invalid international domain name"],
      ["http://user:secret@exa mple.test/", "invalid international domain name"],
    ]
    for (const [url, reason] of cases) {
      expect(await rejection(h.run({ url }))).toMatchObject({ code: -32602, message: `http/request url is invalid: ${reason}` })
    }
    expect(h.authorizations).toEqual([])
  })

  test("an empty header list sends only the default host and accept headers", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/empty`, headers: [] })
    const captured = await server.next()
    expect([...captured.headers.keys()].filter((name) => name !== "connection").sort()).toEqual(["accept", "host"])
    expect(captured.headers.get("accept")).toBe("*/*")
    respond(captured, "200 OK", [], "")
    await pending
    expect(h.authorizations.map((input) => input.metadata)).toEqual([{ method: "GET" }])
  })

  test("an already-aborted request signal fails before authorization or network", async () => {
    const server = await loopback()
    const h = harness()
    const controller = new AbortController()
    controller.abort()
    const error = await rejection(
      h.handler.request(
        { method: "GET", url: `${server.base}/x`, headers: [], redirectPolicy: "follow", requestId: "r", streamResponse: false },
        { signal: controller.signal, emit: () => {} },
      ),
    )
    expect(error).toMatchObject({ code: -32603, message: "Executor session closed" })
    await Bun.sleep(50)
    expect([server.connections(), h.authorizations.length]).toEqual([0, 0])
  })

  test("a timeout while reading a buffered body fails with the body error and releases the grant", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/stall`, timeoutMs: 200 })
    const captured = await server.next()
    captured.socket.write("HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\npartial")
    expect(await rejection(pending)).toMatchObject({
      code: -32603,
      message: "failed to read http/request response body: error decoding response body",
    })
    expect(h.released()).toBe(1)
  })

  test("an emit failure part-way through a stream stops it without a terminal delta", async () => {
    const server = await loopback()
    const h = harness()
    const emitted: CcaHttpBodyDelta[] = []
    const pending = h.handler.request(
      { method: "GET", url: `${server.base}/stream`, headers: [], redirectPolicy: "follow", requestId: "s", streamResponse: true },
      {
        signal: new AbortController().signal,
        emit: (delta) => {
          if (emitted.length === 1) throw new Error("synthetic emit failure")
          emitted.push(delta)
        },
      },
    )
    const captured = await server.next()
    respondChunked(captured, [], ["one"], false)
    const outcome = await pending
    const started = outcome.stream!.start()
    await Bun.sleep(50)
    captured.socket.write("3\r\ntwo\r\n")
    await started
    expect(emitted.map((delta) => [delta.seq, text(delta.delta), delta.done])).toEqual([[1, "one", false]])
    expect(h.released()).toBe(1)
  })

  test("groups repeated response headers by lowercase name and drops non-visible values", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/headers` })
    respond(
      await server.next(),
      "200 OK",
      [
        ["X-A", "1"],
        ["X-B", "b"],
        ["x-a", "2"],
        ["X-Bad", "caf\u00e9"],
      ],
      "",
    )
    const outcome = await pending
    expect(outcome.response.headers.filter((header) => header.name.startsWith("x-"))).toEqual([
      { name: "x-a", value: "1" },
      { name: "x-a", value: "2" },
      { name: "x-b", value: "b" },
    ])
  })

  test("rejects protected environment variables case-insensitively before any network or authorization", async () => {
    const server = await loopback()
    const h = harness({ env: { CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN: "executor-internal-token", OPENAI_API_KEY: "sk" } })
    for (const envVar of [
      "CODEX_EXEC_SERVER_NOISE_AUTH_TOKEN",
      "codex_exec_server_noise_auth_token",
      "OPENAI_API_KEY",
      "CODEX_GUARDIAN_DECISIONS_API_KEY",
      "codex_guardian_decisions_api_key",
      "CODEX_ACCESS_TOKEN",
      "CODEX_CONNECTORS_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "AZURE_FEDERATED_TOKEN_FILE",
      "OPENAI_IDENTITY_TOKEN_FILE",
    ]) {
      const error = await rejection(
        h.run({ url: `${server.base}/mcp`, headers: [{ name: "authorization", value: "Bearer ", valueEnvVar: envVar }] }),
      )
      expect(error.code).toBe(-32602)
      expect(error.message).toBe(
        `http/request header authorization cannot use executor environment variable ${envVar}`,
      )
    }
    await Bun.sleep(50)
    expect(server.connections()).toBe(0)
    expect(h.authorizations).toEqual([])
  })

  test("requires a present, non-empty environment variable for env-sourced headers", async () => {
    const server = await loopback()
    const h = harness({ env: { EMPTY_TOKEN: "" } })
    const missing = await rejection(
      h.run({ url: `${server.base}/mcp`, headers: [{ name: "x-token", value: "", valueEnvVar: "MISSING_TOKEN" }] }),
    )
    expect(missing).toMatchObject({
      code: -32602,
      message: "http/request header x-token requires executor environment variable MISSING_TOKEN",
    })
    const empty = await rejection(
      h.run({ url: `${server.base}/mcp`, headers: [{ name: "x-token", value: "", valueEnvVar: "EMPTY_TOKEN" }] }),
    )
    expect(empty).toMatchObject({
      code: -32602,
      message: "http/request header x-token requires a non-empty executor environment variable EMPTY_TOKEN",
    })
    expect(server.connections()).toBe(0)
  })

  test("validates method, URL, scheme and headers with invalid-params errors", async () => {
    const h = harness()
    const cases: Array<[Partial<CcaHttpRequestParams> & { url: string }, string]> = [
      [{ method: "GE T", url: "http://127.0.0.1:9/" }, "http/request method is invalid: invalid HTTP method"],
      [{ method: "", url: "http://127.0.0.1:9/" }, "http/request method is invalid: invalid HTTP method"],
      [{ url: "not a url" }, "http/request url is invalid: relative URL without a base"],
      [{ url: "ftp://127.0.0.1/file" }, "http/request only supports http and https URLs, got ftp"],
      [
        { url: "http://127.0.0.1:9/", headers: [{ name: "bad name", value: "x" }] },
        "http/request header name is invalid: invalid HTTP header name",
      ],
      [
        { url: "http://127.0.0.1:9/", headers: [{ name: "x-test", value: "a\nb" }] },
        "http/request header value is invalid for x-test: failed to parse header value",
      ],
    ]
    for (const [params, message] of cases) {
      expect(await rejection(h.run(params))).toMatchObject({ code: -32602, message })
    }
    expect(h.authorizations).toEqual([])
  })

  test("omits the URL fragment from the request target", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/mcp?case=fragment#client-section` })
    const captured = await server.next()
    expect(captured.requestLine).toBe("GET /mcp?case=fragment HTTP/1.1")
    respond(captured, "200 OK", [], "fragment-response")
    const outcome = await pending
    expect([outcome.response.status, text(outcome.response.body)]).toEqual([200, "fragment-response"])
  })

  test("denied authorization fails with permission denied and sends nothing", async () => {
    const server = await loopback()
    const h = harness({ deny: () => true })
    const error = await rejection(h.run({ url: `${server.base}/secret` }))
    expect(error).toMatchObject({ code: -32001, message: "Permission denied" })
    await Bun.sleep(50)
    expect(server.connections()).toBe(0)
  })

  test("stop redirect policy returns the redirect response without requesting its target", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/redirect`, redirectPolicy: "stop", timeoutMs: 5_000 })
    const captured = await server.next()
    expect(captured.requestLine).toBe("GET /redirect HTTP/1.1")
    respond(captured, "302 Found", [["location", `${server.base}/final`]], "redirect")
    const outcome = await pending
    expect({
      status: outcome.response.status,
      location: outcome.response.headers.find((header) => header.name === "location")?.value,
      body: text(outcome.response.body),
    }).toEqual({ status: 302, location: `${server.base}/final`, body: "redirect" })
    await Bun.sleep(100)
    expect(server.connections()).toBe(1)
  })

  test("follow redirect policy authorizes and requests each redirect target", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/redirect`, timeoutMs: 5_000 })
    const first = await server.next()
    expect(first.requestLine).toBe("GET /redirect HTTP/1.1")
    respond(first, "302 Found", [["location", "/final"]], "redirect")
    const final = await server.next()
    expect(final.requestLine).toBe("GET /final HTTP/1.1")
    respond(final, "200 OK", [["x-mcp-test", "redirected"]], "final-response-body")
    const outcome = await pending
    expect([outcome.response.status, text(outcome.response.body)]).toEqual([200, "final-response-body"])
    expect(h.authorizations.map((input) => input.resources)).toEqual([
      [`${server.base}/redirect`],
      [`${server.base}/final`],
    ])
    expect(h.released()).toBe(2)
  })

  test("a denied redirect target fails without requesting it", async () => {
    const server = await loopback()
    const h = harness({ deny: (input) => input.resources[0].endsWith("/final") })
    const pending = h.run({ url: `${server.base}/redirect` })
    respond(await server.next(), "302 Found", [["location", `${server.base}/final`]], "")
    expect(await rejection(pending)).toMatchObject({ code: -32001, message: "Permission denied" })
    await Bun.sleep(50)
    expect(server.connections()).toBe(1)
    expect(h.released()).toBe(1)
  })

  test("303 rewrites POST to a bodiless GET", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ method: "POST", url: `${server.base}/form`, body: Buffer.from("payload") })
    respond(await server.next(), "303 See Other", [["location", "/done"]], "")
    const next = await server.next()
    expect([next.requestLine, next.body.length, next.headers.has("content-length")]).toEqual([
      "GET /done HTTP/1.1",
      0,
      false,
    ])
    respond(next, "200 OK", [], "done")
    expect(text((await pending).response.body)).toBe("done")
  })

  test("more than ten redirects fail as an internal error", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/loop/0` })
    for (let hop = 0; hop <= 10; hop++) {
      respond(await server.next(), "302 Found", [["location", `/loop/${hop + 1}`]], "")
    }
    const error = await rejection(pending)
    expect(error.code).toBe(-32603)
    expect(error.message.startsWith("http/request failed: ")).toBe(true)
    expect(server.connections()).toBe(11)
  })

  test("streams the body as ordered deltas only after the response is handed off", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({
      url: `${server.base}/mcp?case=streaming`,
      headers: [{ name: "accept", value: "text/event-stream" }],
      timeoutMs: 5_000,
      requestId: "stream-1",
      streamResponse: true,
    })
    const captured = await server.next()
    expect([captured.requestLine, captured.headers.get("accept"), captured.body.length]).toEqual([
      "GET /mcp?case=streaming HTTP/1.1",
      "text/event-stream",
      0,
    ])
    respondChunked(captured, [["x-mcp-test", "streaming"]], ["hello ", "world"])
    const outcome = await pending
    expect(outcome.response.status).toBe(200)
    expect(outcome.response.headers.find((header) => header.name === "x-mcp-test")?.value).toBe("streaming")
    expect(outcome.response.body.length).toBe(0)
    await Bun.sleep(50)
    expect(h.emitted).toEqual([])
    expect(h.released()).toBe(0)
    await outcome.stream!.start()
    expect(h.emitted.map((delta) => delta.seq)).toEqual(h.emitted.map((_, index) => index + 1))
    expect(h.emitted.every((delta) => delta.requestId === "stream-1")).toBe(true)
    expect(text(Buffer.concat(h.emitted.map((delta) => delta.delta)))).toBe("hello world")
    expect(h.emitted.slice(0, -1).every((delta) => !delta.done && delta.error === null)).toBe(true)
    const terminal = h.emitted.at(-1)!
    expect([terminal.done, terminal.error, terminal.delta.length]).toEqual([true, null, 0])
    expect(h.released()).toBe(1)
  })

  test("splits streamed bodies into deltas of at most one mebibyte", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/large`, streamResponse: true })
    const payload = Buffer.alloc(MAX_HTTP_BODY_DELTA_BYTES * 2 + 17, 7)
    respond(await server.next(), "200 OK", [], payload)
    const outcome = await pending
    await outcome.stream!.start()
    const data = h.emitted.filter((delta) => !delta.done)
    expect(data.length).toBeGreaterThanOrEqual(3)
    expect(data.every((delta) => delta.delta.length > 0 && delta.delta.length <= MAX_HTTP_BODY_DELTA_BYTES)).toBe(true)
    expect(Buffer.concat(data.map((delta) => delta.delta)).equals(payload)).toBe(true)
    expect(h.emitted.map((delta) => delta.seq)).toEqual(h.emitted.map((_, index) => index + 1))
  })

  test("a broken streamed body ends with one terminal error delta", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/broken`, streamResponse: true })
    const captured = await server.next()
    respondChunked(captured, [], ["partial"], false)
    const outcome = await pending
    const started = outcome.stream!.start()
    await Bun.sleep(50)
    captured.socket.destroy()
    await started
    const terminal = h.emitted.at(-1)!
    expect(terminal.done).toBe(true)
    expect(typeof terminal.error).toBe("string")
    expect(terminal.error!.length).toBeGreaterThan(0)
    expect(h.emitted.filter((delta) => delta.done)).toHaveLength(1)
    expect(h.emitted.map((delta) => delta.seq)).toEqual(h.emitted.map((_, index) => index + 1))
  })

  test("a streamed requestId stays reserved until its body stream finishes", async () => {
    const server = await loopback()
    const h = harness()
    const first = h.run({ url: `${server.base}/dup`, requestId: "stream-dup", streamResponse: true })
    const captured = await server.next()
    respondChunked(captured, [], ["hello"], false)
    const outcome = await first
    expect(
      await rejection(h.run({ url: `${server.base}/dup`, requestId: "stream-dup", streamResponse: true })),
    ).toMatchObject({ code: -32602, message: "http/request streamResponse requestId `stream-dup` is already active" })
    const started = outcome.stream!.start()
    captured.socket.end("0\r\n\r\n")
    await started
    const again = h.run({ url: `${server.base}/dup`, requestId: "stream-dup", streamResponse: true })
    respond(await server.next(), "200 OK", [], "again")
    await (await again).stream!.cancel()
  })

  test("omitted timeout waits for a slow response while a short timeout fails it", async () => {
    const server = await loopback()
    const h = harness()
    const slow = h.run({ url: `${server.base}/slow` })
    const first = await server.next()
    setTimeout(() => respond(first, "200 OK", [], "slow-success"), 100)
    expect(text((await slow).response.body)).toBe("slow-success")

    const timed = h.run({ url: `${server.base}/slow`, timeoutMs: 10 })
    const second = await server.next()
    setTimeout(() => {
      if (!second.socket.destroyed) respond(second, "200 OK", [], "too-late")
    }, 100)
    const error = await rejection(timed)
    expect(error.code).toBe(-32603)
    expect(error.message.startsWith("http/request failed: ")).toBe(true)
    expect(h.released()).toBe(2)
  })

  test("close stops an active stream without a terminal delta and releases its grant", async () => {
    const server = await loopback()
    const h = harness()
    const pending = h.run({ url: `${server.base}/forever`, streamResponse: true })
    respondChunked(await server.next(), [], ["first"], false)
    const outcome = await pending
    const started = outcome.stream!.start()
    await Bun.sleep(50)
    await h.handler.close()
    await started
    expect(h.emitted.some((delta) => delta.done)).toBe(false)
    expect(h.released()).toBe(1)
    expect(await rejection(h.run({ url: `${server.base}/after-close` }))).toMatchObject({ code: -32603 })
  })
})
