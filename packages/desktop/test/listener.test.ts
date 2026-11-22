import { expect, test } from "bun:test"
import { ownsListener, parseListeners, parseProcess, type ProcessRecord } from "./isolation"

const BACKEND = "/synthetic/backend/ycoding"
const RUNTIME = "/synthetic/private/cache/ycoding/bin/runtime/0.13.0/digest/ycoding-runtime"
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

test("accepts only the reviewed runtime listener under the packaged CLI and bound launcher when supplied", () => {
  const port = [{ pid: 11, ppid: 10 }]
  const frontend = process_(10, HARNESS, BACKEND)
  expect(ownsListener(port, process_(11, 10, RUNTIME), frontend, RUNTIME, BACKEND, HARNESS)).toBe(true)
  expect(ownsListener(port, process_(11, 10, RUNTIME), frontend, RUNTIME, BACKEND, HARNESS, 10)).toBe(true)
  expect(ownsListener(port, process_(11, 10, RUNTIME), frontend, RUNTIME, BACKEND, HARNESS, 9)).toBe(false)
})

test("denies GUI chains, orphans, two listeners, wrong executables and missing or inconsistent records", () => {
  const one = (pid: number, ppid: number) => [{ pid, ppid }]
  const deny = (listeners: Parameters<typeof ownsListener>[0], native: ProcessRecord | undefined, parent: ProcessRecord | undefined) =>
    expect(ownsListener(listeners, native, parent, RUNTIME, BACKEND, HARNESS)).toBe(false)
  const native = process_(11, 10, RUNTIME)
  const frontend = process_(10, HARNESS, BACKEND)
  deny(one(11, 50), process_(11, 50, RUNTIME), process_(50, HARNESS, "/synthetic/Fixture.app/Contents/MacOS/fixture"))
  deny(one(11, 1), process_(11, 1, RUNTIME), process_(1, 0, "/sbin/launchd"))
  deny(one(11, HARNESS), process_(11, HARNESS, RUNTIME), undefined)
  deny([...one(11, 10), ...one(12, 10)], native, frontend)
  deny(one(11, 10), process_(11, 10, BACKEND), frontend)
  deny(one(11, 10), process_(11, 10, `${RUNTIME}-other`), frontend)
  deny(one(11, 10), process_(11, 10, undefined), frontend)
  deny(one(11, 10), native, process_(10, HARNESS, undefined))
  deny(one(11, 10), native, process_(10, 77, BACKEND))
  deny(one(11, 10), native, process_(12, HARNESS, BACKEND))
  deny(one(11, 77), native, frontend)
  deny(one(99, 10), native, frontend)
  deny(one(11, 10), undefined, frontend)
  deny(one(11, 10), native, undefined)
  deny(undefined, native, frontend)
  deny([], undefined, undefined)
})
