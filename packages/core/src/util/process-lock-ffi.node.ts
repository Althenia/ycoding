import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
let ffi: typeof import("node:ffi") | undefined

function loadFfi() {
  ffi ??= require("node:ffi") as typeof import("node:ffi")
  return ffi
}

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
  const { dlopen } = loadFfi()
  return dlopen("/usr/lib/libSystem.B.dylib", {
    flock: { arguments: ["int32", "int32"], return: "int32" },
    __error: { arguments: [], return: "pointer" },
  })
}

function openLinux() {
  const { dlopen } = loadFfi()
  return dlopen("libc.so.6", {
    flock: { arguments: ["int32", "int32"], return: "int32" },
    __errno_location: { arguments: [], return: "pointer" },
  })
}

export function lockDarwin(fd: number): LockResult {
  const { getInt32 } = loadFfi()
  darwin ??= openDarwin()
  const result = darwin.functions.flock(fd, LOCK_EX | LOCK_NB)
  if (result === 0) return { acquired: true }
  const code = getInt32(darwin.functions.__error(), 0)
  if (code === DARWIN_EWOULDBLOCK) return { acquired: false, held: true }
  return { acquired: false, held: false, code }
}

export function lockLinux(fd: number): LockResult {
  const { getInt32 } = loadFfi()
  linux ??= openLinux()
  const result = linux.functions.flock(fd, LOCK_EX | LOCK_NB)
  if (result === 0) return { acquired: true }
  const code = getInt32(linux.functions.__errno_location(), 0)
  if (code === LINUX_EWOULDBLOCK) return { acquired: false, held: true }
  return { acquired: false, held: false, code }
}
