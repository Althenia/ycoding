import { dlopen, ptr } from "bun:ffi"

export type ClamshellResult = { readonly ok: true } | { readonly ok: false; readonly code: number }

// kPMSetClamshellSleepState selector on the IOPMrootDomain user client
// (IOKit.framework Headers/pwr_mgt/IOPMLibDefs.h). Scalar input 1 disables
// clamshell (lid-closed) sleep, 0 restores it.
const K_PM_SET_CLAMSHELL_SLEEP_STATE = 12
const KERN_SUCCESS = 0

type IOKit = ReturnType<typeof openIOKit>
type LibSystem = ReturnType<typeof openLibSystem>

function openIOKit() {
  return dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", {
    IOServiceMatching: { args: ["ptr"], returns: "ptr" },
    IOServiceGetMatchingService: { args: ["u32", "ptr"], returns: "u32" },
    IOServiceOpen: { args: ["u32", "u32", "u32", "ptr"], returns: "i32" },
    IOConnectCallScalarMethod: { args: ["u32", "u32", "ptr", "u32", "ptr", "ptr"], returns: "i32" },
    IOServiceClose: { args: ["u32"], returns: "i32" },
    IOObjectRelease: { args: ["u32"], returns: "i32" },
  })
}

function openLibSystem() {
  return dlopen("/usr/lib/libSystem.B.dylib", {
    mach_task_self: { args: [], returns: "u32" },
  })
}

interface Held {
  readonly iokit: IOKit
  readonly system: LibSystem
  readonly service: number
  readonly connect: number
}

let held: Held | undefined

function releaseHeld() {
  if (!held) return
  const current = held
  held = undefined
  current.iokit.symbols.IOServiceClose(current.connect)
  current.iokit.symbols.IOObjectRelease(current.service)
  current.iokit.close()
  current.system.close()
}

export function setClamshellSleepDisabled(disabled: boolean): ClamshellResult {
  if (held) {
    const scalar = new BigUint64Array([disabled ? 1n : 0n])
    const code = held.iokit.symbols.IOConnectCallScalarMethod(
      held.connect,
      K_PM_SET_CLAMSHELL_SLEEP_STATE,
      ptr(scalar),
      1,
      null,
      null,
    )
    if (!disabled) releaseHeld()
    return code === KERN_SUCCESS ? { ok: true } : { ok: false, code }
  }
  const iokit = openIOKit()
  const system = openLibSystem()
  const closeLibraries = () => {
    iokit.close()
    system.close()
  }
  const name = new TextEncoder().encode("IOPMrootDomain\0")
  const matching = iokit.symbols.IOServiceMatching(ptr(name))
  const service = matching ? iokit.symbols.IOServiceGetMatchingService(0, matching) : 0
  if (!service) {
    closeLibraries()
    return { ok: false, code: -1 }
  }
  const out = new Uint32Array(1)
  const opened = iokit.symbols.IOServiceOpen(service, system.symbols.mach_task_self(), 0, ptr(out))
  const connect = out[0]
  if (opened !== KERN_SUCCESS || !connect) {
    iokit.symbols.IOObjectRelease(service)
    closeLibraries()
    return { ok: false, code: opened }
  }
  const scalar = new BigUint64Array([disabled ? 1n : 0n])
  const called = iokit.symbols.IOConnectCallScalarMethod(
    connect,
    K_PM_SET_CLAMSHELL_SLEEP_STATE,
    ptr(scalar),
    1,
    null,
    null,
  )
  if (called !== KERN_SUCCESS) {
    iokit.symbols.IOServiceClose(connect)
    iokit.symbols.IOObjectRelease(service)
    closeLibraries()
    return { ok: false, code: called }
  }
  if (disabled) {
    releaseHeld()
    held = { iokit, system, service, connect }
    return { ok: true }
  }
  iokit.symbols.IOServiceClose(connect)
  iokit.symbols.IOObjectRelease(service)
  closeLibraries()
  releaseHeld()
  return { ok: true }
}
