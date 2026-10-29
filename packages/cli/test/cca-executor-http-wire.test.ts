import { describe, expect, test } from "bun:test"
import {
  CCA_HTTP_REQUEST_BODY_DELTA_METHOD,
  CCA_HTTP_REQUEST_METHOD,
  decodeCcaHttpRequestParams,
  encodeCcaHttpBodyDelta,
  encodeCcaHttpRequestResponse,
} from "../src/remote-control/cca-executor-http-wire"
import { CcaRpcError } from "../src/remote-control/cca-executor-rpc"

function invalid(params: unknown) {
  try {
    decodeCcaHttpRequestParams(params)
  } catch (error) {
    if (!(error instanceof CcaRpcError)) throw error
    return { code: error.code, message: error.message }
  }
  throw new Error("expected invalid params")
}

describe("CCA executor http wire", () => {
  test("uses the upstream method names", () => {
    expect([CCA_HTTP_REQUEST_METHOD, CCA_HTTP_REQUEST_BODY_DELTA_METHOD]).toEqual([
      "http/request",
      "http/request/bodyDelta",
    ])
  })

  test("decodes a complete camelCase request envelope", () => {
    const decoded = decodeCcaHttpRequestParams({
      method: "POST",
      url: "http://127.0.0.1:8080/mcp?case=buffered",
      headers: [
        { name: "x-codex-test", value: "buffered" },
        { name: "authorization", value: "Bearer ", valueEnvVar: "NODE_REPL_AUTH_TOKEN" },
        { name: "x-null-env", value: "literal", valueEnvVar: null },
      ],
      bodyBase64: Buffer.from("request-body").toString("base64"),
      timeoutMs: 5000,
      redirectPolicy: "stop",
      requestId: "buffered-request",
      streamResponse: true,
      futureField: { ignored: true },
    })
    expect({ ...decoded, body: decoded.body && Buffer.from(decoded.body).toString() }).toEqual({
      method: "POST",
      url: "http://127.0.0.1:8080/mcp?case=buffered",
      headers: [
        { name: "x-codex-test", value: "buffered" },
        { name: "authorization", value: "Bearer ", valueEnvVar: "NODE_REPL_AUTH_TOKEN" },
        { name: "x-null-env", value: "literal" },
      ],
      body: "request-body",
      timeoutMs: 5000,
      redirectPolicy: "stop",
      requestId: "buffered-request",
      streamResponse: true,
    })
  })

  test("applies upstream defaults and treats omitted or null timeout as no timeout", () => {
    const minimal = { method: "GET", url: "https://example.test", requestId: "req-omitted-timeout" }
    const expected = {
      method: "GET",
      url: "https://example.test",
      headers: [],
      redirectPolicy: "follow" as const,
      requestId: "req-omitted-timeout",
      streamResponse: false,
    }
    expect(decodeCcaHttpRequestParams(minimal)).toEqual(expected)
    expect(decodeCcaHttpRequestParams({ ...minimal, timeoutMs: null, bodyBase64: null })).toEqual(expected)
    expect(decodeCcaHttpRequestParams({ ...minimal, timeoutMs: 1234 }).timeoutMs).toBe(1234)
    expect(decodeCcaHttpRequestParams({ ...minimal, timeoutMs: 0 }).timeoutMs).toBe(0)
    expect(decodeCcaHttpRequestParams({ ...minimal, bodyBase64: "" }).body).toEqual(new Uint8Array())
    expect(decodeCcaHttpRequestParams({ ...minimal, headers: [] })).toEqual(expected)
    expect(Buffer.from(decodeCcaHttpRequestParams({ ...minimal, bodyBase64: "aGk=" }).body!).toString()).toBe("hi")
  })

  test("rejects malformed params with invalid-params errors", () => {
    const base = { method: "GET", url: "https://example.test", requestId: "req" }
    const cases: Array<[unknown, string]> = [
      [undefined, "invalid type: null, expected struct HttpRequestParams"],
      [null, "invalid type: null, expected struct HttpRequestParams"],
      [[], "invalid type: sequence, expected struct HttpRequestParams"],
      ["GET", 'invalid type: string "GET", expected struct HttpRequestParams'],
      [{ url: base.url, requestId: "req" }, "missing field `method`"],
      [{ method: "GET", requestId: "req" }, "missing field `url`"],
      [{ method: "GET", url: base.url }, "missing field `requestId`"],
      [{ ...base, method: 1 }, "invalid type: integer `1`, expected a string"],
      [{ ...base, requestId: null }, "invalid type: null, expected a string"],
      [{ ...base, headers: null }, "invalid type: null, expected a sequence"],
      [{ ...base, headers: {} }, "invalid type: map, expected a sequence"],
      [{ ...base, headers: ["x"] }, 'invalid type: string "x", expected struct HttpHeader'],
      [{ ...base, headers: [{ name: "x" }] }, "missing field `value`"],
      [{ ...base, headers: [{ value: "x" }] }, "missing field `name`"],
      [{ ...base, headers: [{ name: "x", value: "y", valueEnvVar: 3 }] }, "invalid type: integer `3`, expected a string"],
      [{ ...base, bodyBase64: 5 }, "invalid type: integer `5`, expected a string"],
      [{ ...base, bodyBase64: "abc" }, "Invalid padding"],
      [{ ...base, bodyBase64: "ab!=" }, "Invalid symbol 33, offset 2."],
      [{ ...base, bodyBase64: "aGk" }, "Invalid padding"],
      [{ ...base, bodyBase64: "aGl=" }, "Invalid last symbol 108, offset 2."],
      [{ ...base, bodyBase64: "a===" }, "Invalid symbol 61, offset 1."],
      [{ ...base, bodyBase64: "aaaaa" }, "Invalid input length: 5"],
      [{ ...base, bodyBase64: "aa==aa==" }, "Invalid symbol 61, offset 2."],
      [{ ...base, timeoutMs: -1 }, "invalid value: integer `-1`, expected u64"],
      [{ ...base, timeoutMs: 1.5 }, "invalid type: floating point `1.5`, expected u64"],
      [{ ...base, timeoutMs: "10" }, 'invalid type: string "10", expected u64'],
      [{ ...base, redirectPolicy: "manual" }, "unknown variant `manual`, expected `follow` or `stop`"],
      [{ ...base, redirectPolicy: null }, "invalid type: null, expected string or map"],
      [{ ...base, redirectPolicy: 1 }, "invalid type: integer `1`, expected string or map"],
      [{ ...base, streamResponse: "true" }, 'invalid type: string "true", expected a boolean'],
      [{ ...base, streamResponse: null }, "invalid type: null, expected a boolean"],
    ]
    for (const [params, message] of cases) {
      expect(invalid(params)).toEqual({ code: -32602, message })
    }
  })

  test("encodes the response with base64 body and omits absent valueEnvVar", () => {
    expect(
      encodeCcaHttpRequestResponse({
        status: 201,
        headers: [
          { name: "x-mcp-test", value: "buffered" },
          { name: "x-mcp-test", value: "repeat" },
        ],
        body: Buffer.from("response-body"),
      }),
    ).toEqual({
      status: 201,
      headers: [
        { name: "x-mcp-test", value: "buffered" },
        { name: "x-mcp-test", value: "repeat" },
      ],
      bodyBase64: Buffer.from("response-body").toString("base64"),
    })
    expect(JSON.stringify(encodeCcaHttpRequestResponse({ status: 200, headers: [], body: new Uint8Array() }))).toBe(
      '{"status":200,"headers":[],"bodyBase64":""}',
    )
  })

  test("encodes body deltas with every upstream field", () => {
    expect(
      JSON.stringify(
        encodeCcaHttpBodyDelta({ requestId: "stream-1", seq: 1, delta: Buffer.from("hello "), done: false, error: null }),
      ),
    ).toBe(`{"requestId":"stream-1","seq":1,"deltaBase64":"${Buffer.from("hello ").toString("base64")}","done":false,"error":null}`)
    expect(
      encodeCcaHttpBodyDelta({ requestId: "stream-1", seq: 3, delta: new Uint8Array(), done: true, error: "broken" }),
    ).toEqual({ requestId: "stream-1", seq: 3, deltaBase64: "", done: true, error: "broken" })
  })
})
