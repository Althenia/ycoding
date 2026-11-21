import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { pageOperation } from "../page.js"
import { redactText, redactURL, redactionPatterns } from "../redact.js"

const secrets = [
  "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----",
  "sk-proj-AbCdEfGhIjKlMnOpQrStUvWx",
  "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  "AKIAIOSFODNN7EXAMPLE",
  "AIzaSyA1234567890abcdefghijklmnopqrstu",
  "xoxb-1234567890-abcdefghij",
  "alice.smith+test@example.test",
  "+1 (415) 555-0134",
  "415-555-0134",
  "4111 1111 1111 1111",
  "5500-0000-0000-0004",
  "378282246310005",
  "123-45-6789",
]

test("redactText masks every sensitive pattern and keeps ordinary prose", () => {
  for (const secret of secrets) {
    const masked = redactText(`Before ${secret} after`)
    expect(masked).toStartWith("Before ")
    expect(masked).toEndWith(" after")
    expect(masked).toContain("[redacted]")
    for (const part of secret.split(/[\s.@()+-]+/).filter((value) => value.length >= 4)) expect(masked).not.toContain(part)
  }
  expect(redactText("password=hunter2 and token: s3cr3t-value")).toBe("password=[redacted] and token: [redacted]")
  expect(redactText("https://example.test/a?api_key=abc&step=2")).toBe("https://example.test/a?api_key=[redacted]&step=2")
  expect(redactText("Checkout — order 2026 · 3 items · Example Store")).toBe("Checkout — order 2026 · 3 items · Example Store")
  expect(redactText("Version 1.2.3 released on page 42")).toBe("Version 1.2.3 released on page 42")
})

test("redactText scans long unbroken runs in linear time and keeps them when nothing matches", () => {
  for (const run of ["a".repeat(1 << 20), "a-".repeat(1 << 19), "a.".repeat(1 << 19), "eyJa-".repeat(1 << 18), "-".repeat(1 << 20), `a@${"b".repeat(1 << 20)}`,
    "a@".repeat(1 << 19)])
    expect(redactText(run)).toBe(run)
  expect(redactText(`x ${"a".repeat(1 << 20)}@example.test y`)).toBe("x [redacted] y")
})

test("redactText masks an email with a long local part in full", () => {
  for (const length of [70, 10_000]) expect(redactText(`Before ${"a".repeat(length)}@example.test after`)).toBe("Before [redacted] after")
})

test("capture boxes cover a long local-part email from its first character through the domain", () => {
  const text = `Contact ${"a".repeat(70)}@example.test today`
  const start = "Contact ".length
  const end = text.indexOf(" today")
  const node = { data: text }
  const document = {
    querySelector: () => null,
    querySelectorAll: () => [],
    createTreeWalker: () => {
      const nodes = [node]
      return { nextNode: () => nodes.shift() ?? null }
    },
    createRange: () => {
      const range = { from: 0, to: 0 }
      return {
        setStart: (_, offset) => { range.from = offset },
        setEnd: (_, offset) => { range.to = offset },
        getClientRects: () => [{ left: 10 + range.from * 8, top: 20, width: (range.to - range.from) * 8, height: 16,
          right: 10 + range.to * 8, bottom: 36 }],
      }
    },
  }
  const location = { origin: "https://example.test", pathname: "/" }
  const input = { operation: "sensitiveBoxes", patterns: redactionPatterns, origin: location.origin, pathname: location.pathname, isolated: true }
  const result = JSON.parse(runInNewContext(`JSON.stringify((${pageOperation.toString()})(input))`,
    { location, window: { frames: { length: 0 } }, document, innerWidth: 1280, innerHeight: 800, NodeFilter: { SHOW_TEXT: 4 }, input }))
  expect(result.boxes).toEqual([[10 + start * 8 - 2, 18, (end - start) * 8 + 4, 20]])
})

test("redactText masks tokens and JWTs inside hyphenated runs", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
  expect(redactText(`--a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6-- x`)).toBe("--[redacted]-- x")
  expect(redactText(`xeyJ-${jwt} y`)).toBe("xeyJ-[redacted] y")
  expect(redactText(`id-${jwt}`)).toBe("id-[redacted]")
})

test("redactText accepts only strings", () => {
  expect(redactText(undefined)).toBe("")
  expect(redactText(42)).toBe("")
})

test("redactURL drops userinfo and fragment and masks sensitive query values", () => {
  expect(redactURL("https://user:pass@example.test/reset?token=abc123&step=2#private"))
    .toBe("https://example.test/reset?token=[redacted]&step=2")
  expect(redactURL("https://example.test/u/alice@example.test?Password=x&q=call%20415-555-0134"))
    .toBe("https://example.test/u/[redacted]?Password=[redacted]&q=call%20[redacted]")
  expect(redactURL("http://127.0.0.1:8080/")).toBe("http://127.0.0.1:8080/")
  expect(redactURL("https://example.test/path?client_secret=1&code=2&sig=3&session=4&auth=5"))
    .toBe("https://example.test/path?client_secret=[redacted]&code=[redacted]&sig=[redacted]&session=[redacted]&auth=[redacted]")
})

test("redactURL refuses non-web and malformed input", () => {
  expect(redactURL("javascript:alert(1)")).toBeUndefined()
  expect(redactURL("file:///etc/passwd")).toBeUndefined()
  expect(redactURL("not a url")).toBeUndefined()
  expect(redactURL(undefined)).toBeUndefined()
  expect(redactURL(`https://example.test/${"a".repeat(2100)}`)).toBeUndefined()
})
