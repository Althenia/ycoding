import { describe, expect, test } from "bun:test"
import { isAllowedCorsOrigin } from "../src/cors"

describe("TUI-only CORS policy", () => {
  test("allows loopback and explicitly configured origins", () => {
    expect(isAllowedCorsOrigin("http://localhost:3000")).toBe(true)
    expect(isAllowedCorsOrigin("http://127.0.0.1:8787")).toBe(true)
    expect(isAllowedCorsOrigin("https://terminal.example", { cors: ["https://terminal.example"] })).toBe(true)
  })

  test("does not implicitly allow removed GUI schemes or an unconfigured product domain", () => {
    expect(isAllowedCorsOrigin("oc://renderer")).toBe(false)
    expect(isAllowedCorsOrigin("tauri://localhost")).toBe(false)
    expect(isAllowedCorsOrigin("https://ycoding.ai")).toBe(false)
  })
})
