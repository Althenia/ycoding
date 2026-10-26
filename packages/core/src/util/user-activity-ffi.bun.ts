import { dlopen, ptr } from "bun:ffi"
import type { Native } from "./user-activity"

export function openUserActivity(): Native {
  const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFStringCreateWithCString: { args: ["ptr", "ptr", "u32"], returns: "ptr" },
    CFRelease: { args: ["ptr"], returns: "void" },
  })
  const name = cf.symbols.CFStringCreateWithCString(null, ptr(new TextEncoder().encode("YCoding keep-awake\0")), 0x08000100)
  if (!name) {
    cf.close()
    throw new Error("Activity assertion name could not be created")
  }
  try {
    const iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", {
      IOPMAssertionDeclareUserActivity: { args: ["ptr", "u32", "ptr"], returns: "i32" },
      IOPMAssertionRelease: { args: ["u32"], returns: "i32" },
    })
    return {
      declare: (id) => {
        const output = new Uint32Array([id])
        const code = iokit.symbols.IOPMAssertionDeclareUserActivity(name, 0, ptr(output))
        return { code, id: output[0] }
      },
      release: (id) => iokit.symbols.IOPMAssertionRelease(id),
      close: () => { iokit.close(); cf.symbols.CFRelease(name); cf.close() },
    }
  } catch (error) {
    cf.symbols.CFRelease(name)
    cf.close()
    throw error
  }
}
