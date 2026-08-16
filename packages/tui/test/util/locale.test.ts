import { expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"

test("truncates text from the right by terminal width", () => {
  expect(Locale.truncateWidth("abcdefgh", 5)).toBe("abcd…")
  expect(Locale.truncateWidth("ab界cd", 5)).toBe("ab界…")
  expect(Locale.truncateWidth("abcdefgh", 1)).toBe("…")
  expect(Locale.truncateWidth("abcdefgh", 0)).toBe("")
})

test("formats compact numbers with lowercase magnitude suffixes", () => {
  expect(Locale.number(1_200)).toBe("1.2k")
  expect(Locale.number(999)).toBe("999")
  expect(Locale.number(1_000_000)).toBe("1.0m")
})
