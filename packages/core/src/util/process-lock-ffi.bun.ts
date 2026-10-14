import { dlopen, read, type Pointer } from "bun:ffi"
import { existsSync } from "node:fs"

export type LockResult =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly held: true }
  | { readonly acquired: false; readonly held: false; readonly code: number }

const LOCK_EX = 2
const LOCK_NB = 4
const DARWIN_EWOULDBLOCK = 35
const LINUX_EWOULDBLOCK = 11

// libc stays loaded for the process lifetime, so each library is opened once and reused.
let darwin: ReturnType<typeof openDarwin> | undefined
let linux: ReturnType<typeof openLinux> | undefined

function openDarwin() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
  })
}

function openLinux() {
  const musl = `/lib/libc.musl-${process.arch === "arm64" ? "aarch64" : "x86_64"}.so.1`
  return dlopen(existsSync(musl) ? musl : "libc.so.6", {
    flock: { args: ["i32", "i32"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  })
}

export function lockDarwin(fd: number): LockResult {
  darwin ??= openDarwin()
  const result = darwin.symbols.flock(fd, LOCK_EX | LOCK_NB)
  if (result === 0) return { acquired: true }
  const code = errorCode(darwin.symbols.__error())
  if (code === DARWIN_EWOULDBLOCK) return { acquired: false, held: true }
  return { acquired: false, held: false, code }
}

export function lockLinux(fd: number): LockResult {
  linux ??= openLinux()
  const result = linux.symbols.flock(fd, LOCK_EX | LOCK_NB)
  if (result === 0) return { acquired: true }
  const code = errorCode(linux.symbols.__errno_location())
  if (code === LINUX_EWOULDBLOCK) return { acquired: false, held: true }
  return { acquired: false, held: false, code }
}

function errorCode(pointer: Pointer | null) {
  if (pointer === null) throw new Error("Failed to read process lock error code")
  return read.i32(pointer, 0)
}
