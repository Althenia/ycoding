import { expect, test } from "bun:test"
import { isWellFormedBase64 } from "../src"

test("accepts the existing base64 grammar without checking canonical trailing bits", () => {
  for (const value of ["", "AAAA", "AA==", "AAA=", "////", "AQ==", "AR=="])
    expect(isWellFormedBase64(value)).toBe(true)
  for (const value of ["A", "AAA", "AA!A", "AA=A", "A===", "AAAA=", "AAA==", "AAAA\n"])
    expect(isWellFormedBase64(value)).toBe(false)
})
