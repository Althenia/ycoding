import { createRequire } from "node:module"
import type { Native } from "./user-activity"

const require = createRequire(import.meta.url)

export function openUserActivity(): Native | undefined {
  const ffi = (() => {
    try {
      return require("node:ffi") as typeof import("node:ffi")
    } catch {
      return undefined
    }
  })()
  if (!ffi) return undefined
  const cf = ffi.dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFStringCreateWithCString: { arguments: ["pointer", "cstring", "uint32"], return: "pointer" },
    CFRelease: { arguments: ["pointer"], return: "void" },
  })
  const name = cf.functions.CFStringCreateWithCString(null, "YCoding keep-awake", 0x08000100)
  if (!name) {
    cf.lib.close()
    throw new Error("Activity assertion name could not be created")
  }
  try {
    const iokit = ffi.dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", {
      IOPMAssertionDeclareUserActivity: { arguments: ["pointer", "uint32", "pointer"], return: "int32" },
      IOPMAssertionRelease: { arguments: ["uint32"], return: "int32" },
    })
    return {
      declare: (id) => {
        const output = new Uint32Array([id])
        const code = Number(iokit.functions.IOPMAssertionDeclareUserActivity(name, 0, output))
        return { code, id: output[0] }
      },
      release: (id) => Number(iokit.functions.IOPMAssertionRelease(id)),
      close: () => { iokit.lib.close(); cf.functions.CFRelease(name); cf.lib.close() },
    }
  } catch (error) {
    cf.functions.CFRelease(name)
    cf.lib.close()
    throw error
  }
}
