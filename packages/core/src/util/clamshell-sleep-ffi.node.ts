import { createRequire } from "node:module"

export type ClamshellResult = { readonly ok: true } | { readonly ok: false; readonly code: number; readonly unsupported?: true }

const require = createRequire(import.meta.url)
let ffi: typeof import("node:ffi") | undefined

// kPMSetClamshellSleepState selector on the IOPMrootDomain user client
// (IOKit.framework Headers/pwr_mgt/IOPMLibDefs.h). Scalar input 1 disables
// clamshell (lid-closed) sleep, 0 restores it.
const K_PM_SET_CLAMSHELL_SLEEP_STATE = 12
const KERN_SUCCESS = 0

type IOKit = ReturnType<typeof openIOKit>
type LibSystem = ReturnType<typeof openLibSystem>

function openIOKit() {
  return ffi!.dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", {
    IOServiceMatching: { arguments: ["cstring"], return: "pointer" },
    IOServiceGetMatchingService: { arguments: ["uint32", "pointer"], return: "uint32" },
    IOServiceOpen: { arguments: ["uint32", "uint32", "uint32", "pointer"], return: "int32" },
    IOConnectCallScalarMethod: {
      arguments: ["uint32", "uint32", "pointer", "uint32", "pointer", "pointer"],
      return: "int32",
    },
    IOServiceClose: { arguments: ["uint32"], return: "int32" },
    IOObjectRelease: { arguments: ["uint32"], return: "int32" },
  })
}

function openLibSystem() {
  return ffi!.dlopen("/usr/lib/libSystem.B.dylib", {
    mach_task_self: { arguments: [], return: "uint32" },
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
  current.iokit.functions.IOServiceClose(current.connect)
  current.iokit.functions.IOObjectRelease(current.service)
  current.iokit.lib.close()
  current.system.lib.close()
}

export function setClamshellSleepDisabled(disabled: boolean): ClamshellResult {
  if (process.platform !== "darwin") return { ok: false, code: -1, unsupported: true }
  if (!ffi) {
    try {
      ffi = require("node:ffi")
    } catch {
      return { ok: false, code: -1, unsupported: true }
    }
  }
  if (held) {
    const scalar = new BigUint64Array([disabled ? 1n : 0n])
    const code = Number(
      held.iokit.functions.IOConnectCallScalarMethod(
        held.connect,
        K_PM_SET_CLAMSHELL_SLEEP_STATE,
        scalar,
        1,
        null,
        null,
      ),
    )
    if (!disabled) releaseHeld()
    return code === KERN_SUCCESS ? { ok: true } : { ok: false, code }
  }
  const iokit = openIOKit()
  const system = openLibSystem()
  const closeLibraries = () => {
    iokit.lib.close()
    system.lib.close()
  }
  const matching = iokit.functions.IOServiceMatching("IOPMrootDomain")
  const service = matching ? Number(iokit.functions.IOServiceGetMatchingService(0, matching)) : 0
  if (!service) {
    closeLibraries()
    return { ok: false, code: -1 }
  }
  const out = new Uint32Array(1)
  const opened = Number(iokit.functions.IOServiceOpen(service, Number(system.functions.mach_task_self()), 0, out))
  const connect = out[0]
  if (opened !== KERN_SUCCESS || !connect) {
    iokit.functions.IOObjectRelease(service)
    closeLibraries()
    return { ok: false, code: opened }
  }
  const scalar = new BigUint64Array([disabled ? 1n : 0n])
  const called = Number(
    iokit.functions.IOConnectCallScalarMethod(connect, K_PM_SET_CLAMSHELL_SLEEP_STATE, scalar, 1, null, null),
  )
  if (called !== KERN_SUCCESS) {
    iokit.functions.IOServiceClose(connect)
    iokit.functions.IOObjectRelease(service)
    closeLibraries()
    return { ok: false, code: called }
  }
  if (disabled) {
    releaseHeld()
    held = { iokit, system, service, connect }
    return { ok: true }
  }
  iokit.functions.IOServiceClose(connect)
  iokit.functions.IOObjectRelease(service)
  closeLibraries()
  releaseHeld()
  return { ok: true }
}
