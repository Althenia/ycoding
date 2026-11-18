import { expect, test } from "bun:test"
import { isSessionDirectoryPath, parseClientMessage } from "../src/index"

const accepted = [
  "/",
  "/work/new",
  "//server/share",
  "~",
  "~/projects/new",
  "~\\projects\\new",
  "C:\\",
  "c:/work",
  "D:\\Client Work\\New Project",
  "\\\\server\\share",
  "\\\\server\\share\\folder",
  "\\\\server/share",
  "/".concat("a".repeat(4095)),
]

const rejected: readonly unknown[] = [
  "",
  " ",
  ".",
  "..",
  "./work",
  "../work",
  "work",
  "relative/path",
  "~other",
  "~other/path",
  "C:",
  "C:foo",
  "C:work\\x",
  "\\",
  "\\work",
  "\\\\",
  "\\\\server",
  "\\\\server\\",
  "\\\\server\\ ",
  "\\\\ \\share",
  "\\\\\\share",
  "\\\\?\\C:\\work",
  "\\\\.\\pipe\\name",
  "\\\\?\\UNC\\server\\share",
  "\\\\.",
  "\\\\?",
  "/work/a\u0000b",
  "/".concat("a".repeat(4096)),
  42,
  null,
  undefined,
  {},
]

test("the portable Session directory check accepts only absolute, home-relative, drive and strict UNC paths", () => {
  for (const value of accepted) expect(isSessionDirectoryPath(value), JSON.stringify(value)).toBe(true)
  for (const value of rejected) expect(isSessionDirectoryPath(value), JSON.stringify(value)).toBe(false)
})

test("session.create frames carry the portable directory verbatim and reject every other placement", () => {
  const frame = (directory: unknown) => parseClientMessage(JSON.stringify({ type: "request", id: "a", operation: "session.create", input: { id: "ses_new", directory } }))
  for (const directory of accepted) expect(frame(directory), JSON.stringify(directory)).toEqual({ ok: true, value: { type: "request", id: "a", operation: "session.create", input: { id: "ses_new", directory } } })
  for (const directory of rejected) expect(frame(directory).ok, JSON.stringify(directory)).toBe(false)
})
