import { expect, test } from "bun:test"
import { ownsListener, parseListeners, parseProcess, type ProcessRecord } from "./isolation"

const BACKEND = "/synthetic/backend/ycoding"
const HARNESS = 100

const process_ = (pid: number, ppid: number, exe: string | undefined): ProcessRecord => ({ pid, ppid, exe })

test("parses exactly one pid and parent record per listener and fails closed on anything else", () => {
  expect(parseListeners("p10\nR2\n")).toEqual([{ pid: 10, ppid: 2 }])
  expect(parseListeners("p10\nR2\np11\nR2\n")).toEqual([{ pid: 10, ppid: 2 }, { pid: 11, ppid: 2 }])
  expect(parseListeners("")).toEqual([])
  expect(parseListeners("p10\nR2\nf5\n")).toEqual([{ pid: 10, ppid: 2 }])
  expect(parseListeners("p10\nR2\nf5\np11\nR3\nf6\n")).toEqual([{ pid: 10, ppid: 2 }, { pid: 11, ppid: 3 }])
  for (const bad of ["p10\n", "R2\n", "p10\np11\nR2\n", "p10\nR2\nn/x\n", "p0\nR2\n", "pabc\nR2\n", "p10\nR2\nR3\n", "p99999999999999999999\nR2\n", "p10\nf5\nR2\n", "f5\np10\nR2\n", "p10\nR2\nf\n", "p10\nR2\nfabc\n", "p10\nR2\nn*:4096\n", "p10\nR2\nf5\nR3\n", "p10\nR2\nt4\n"])
    expect(parseListeners(bad), bad).toBeUndefined()
})

test("parses a process record with its first txt path and refuses missing, duplicate or extra fields", () => {
  expect(parseProcess("p10\nR2\nn/synthetic/exe\nn/synthetic/lib\n")).toEqual({ pid: 10, ppid: 2, exe: "/synthetic/exe" })
  expect(parseProcess("p10\nR2\nftxt\nn/synthetic/exe\nftxt\nn/synthetic/lib\n")).toEqual({ pid: 10, ppid: 2, exe: "/synthetic/exe" })
  expect(parseProcess("p10\nR2\nn/synthetic/exe\n")).toEqual({ pid: 10, ppid: 2, exe: "/synthetic/exe" })
  expect(parseProcess("p10\nR2\nftxt\n")).toEqual({ pid: 10, ppid: 2, exe: undefined })
  expect(parseProcess("p10\nR2\n")).toEqual({ pid: 10, ppid: 2, exe: undefined })
  for (const bad of ["p10\n", "R2\nn/x\n", "p10\nR2\np11\n", "p10\nR2\nR3\n", "p0\nR2\n", "p10\nR99999999999999999999\n", "p10\nR2\nx1\n", "p10\nR2\nf3\n", "p10\nftxt\nR2\n", "p10\nn/x\nR2\n", "p10\nR2\nftxt\nR3\n", "p10\nR2\ntREG\n", "p10\nR2\nftxt\nn/x\nR3\n"])
    expect(parseProcess(bad), bad).toBeUndefined()
})

test("allows only a backend-executable listener that is a direct harness child or whose parent is a backend direct harness child", () => {
  const listener = (pid: number, ppid: number) => [{ pid, ppid }]
  expect(ownsListener(listener(10, HARNESS), process_(10, HARNESS, BACKEND), undefined, BACKEND, HARNESS)).toBe(true)
  expect(ownsListener(listener(11, 10), process_(11, 10, BACKEND), process_(10, HARNESS, BACKEND), BACKEND, HARNESS)).toBe(true)
})

test("denies GUI chains, orphans, two listeners, wrong executables and missing or inconsistent records", () => {
  const one = (pid: number, ppid: number) => [{ pid, ppid }]
  const gui = process_(50, 1, "/synthetic/Fixture.app/Contents/MacOS/fixture")
  expect(ownsListener(one(10, 50), process_(10, 50, BACKEND), gui, BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(10, 1), process_(10, 1, BACKEND), process_(1, 0, "/sbin/launchd"), BACKEND, HARNESS)).toBe(false)
  expect(ownsListener([{ pid: 10, ppid: HARNESS }, { pid: 11, ppid: HARNESS }], process_(10, HARNESS, BACKEND), undefined, BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(10, HARNESS), process_(10, HARNESS, "/synthetic/other"), undefined, BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(10, HARNESS), process_(10, HARNESS, undefined), undefined, BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(11, 10), process_(11, 10, "/synthetic/other"), undefined, BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(11, 10), process_(11, 10, BACKEND), process_(10, HARNESS, "/synthetic/other"), BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(11, 10), process_(11, 10, BACKEND), process_(10, 77, BACKEND), BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(11, 10), process_(11, 10, BACKEND), process_(12, HARNESS, BACKEND), BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(10, HARNESS), process_(99, HARNESS, BACKEND), undefined, BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(11, 10), process_(11, 10, "/synthetic/other"), process_(10, HARNESS, BACKEND), BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(11, 10), process_(11, 10, undefined), process_(10, HARNESS, BACKEND), BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(11, 10), process_(11, 10, BACKEND), process_(10, HARNESS, undefined), BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(one(10, HARNESS), undefined, undefined, BACKEND, HARNESS)).toBe(false)
  expect(ownsListener(undefined, process_(10, HARNESS, BACKEND), undefined, BACKEND, HARNESS)).toBe(false)
  expect(ownsListener([], undefined, undefined, BACKEND, HARNESS)).toBe(false)
})
