import type { Pointer } from "bun:ffi"

export const DESKTOP_MIN_WINDOW_WIDTH = 1000
export const DESKTOP_MIN_WINDOW_HEIGHT = 600
export const DESKTOP_DEFAULT_WINDOW_WIDTH = 1360
export const DESKTOP_DEFAULT_WINDOW_HEIGHT = 860
export const DESKTOP_MIN_WINDOW_SIZE = {
  width: DESKTOP_MIN_WINDOW_WIDTH,
  height: DESKTOP_MIN_WINDOW_HEIGHT,
} as const

export type WindowBounds = {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type WindowSize = {
  readonly width: number
  readonly height: number
}

export type EnforceableNativeWindow = {
  readonly ptr?: Pointer
  readonly setSize: (width: number, height: number) => void
  readonly on: (name: string, handler: (event: unknown) => void) => void
}

export function clampDesktopWindowSize(size: WindowSize, min: WindowSize = DESKTOP_MIN_WINDOW_SIZE): WindowSize {
  const width = Number.isFinite(size.width) ? Math.max(min.width, Math.round(size.width)) : min.width
  const height = Number.isFinite(size.height) ? Math.max(min.height, Math.round(size.height)) : min.height
  return { width, height }
}

export function clampDesktopWindowFrame(frame: WindowBounds, min: WindowSize = DESKTOP_MIN_WINDOW_SIZE): WindowBounds {
  const size = clampDesktopWindowSize(frame, min)
  return { x: frame.x, y: frame.y, width: size.width, height: size.height }
}

function readResizeSize(event: unknown): WindowSize | undefined {
  if (!event || typeof event !== "object" || !("data" in event)) return undefined
  const data = event.data
  if (!data || typeof data !== "object") return undefined
  const width = "width" in data ? data.width : undefined
  const height = "height" in data ? data.height : undefined
  if (typeof width !== "number" || typeof height !== "number") return undefined
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined
  return { width, height }
}

function toPointerAddress(value: Pointer | number | bigint) {
  if (typeof value === "bigint") return value
  return BigInt(value)
}

// Use u64 + CFunction because Bun 1.3.13 truncates high-bit tagged/PAC Objective-C pointers when returned as FFIType.ptr.
function applyMacOSContentMinSize(windowPtr: Pointer, min: WindowSize) {
  const { CFunction, dlopen, FFIType, ptr } = require("bun:ffi") as typeof import("bun:ffi")
  dlopen("/System/Library/Frameworks/Foundation.framework/Foundation", {
    NSLog: { args: [FFIType.ptr], returns: FFIType.void },
  })
  const sys = dlopen("/usr/lib/libSystem.B.dylib", {
    dlopen: { args: [FFIType.cstring, FFIType.i32], returns: FFIType.u64 },
    dlsym: { args: [FFIType.u64, FFIType.cstring], returns: FFIType.ptr },
  })
  const objc = dlopen("/usr/lib/libobjc.A.dylib", {
    objc_getClass: { args: [FFIType.cstring], returns: FFIType.u64 },
    sel_registerName: { args: [FFIType.cstring], returns: FFIType.u64 },
  })
  const objcHandle = sys.symbols.dlopen(Buffer.from("/usr/lib/libobjc.A.dylib\0"), 1)
  if (!objcHandle) return false
  const msgSendPtr = sys.symbols.dlsym(objcHandle, Buffer.from("objc_msgSend\0"))
  if (!msgSendPtr) return false

  const send0 = CFunction({ ptr: msgSendPtr, args: [FFIType.u64, FFIType.u64], returns: FFIType.u64 })
  const send1 = CFunction({ ptr: msgSendPtr, args: [FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.u64 })
  const sendU8 = CFunction({ ptr: msgSendPtr, args: [FFIType.u64, FFIType.u64, FFIType.u64], returns: FFIType.u8 })
  const sendSetArg = CFunction({ ptr: msgSendPtr, args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.i64], returns: FFIType.void })
  const sendMain = CFunction({ ptr: msgSendPtr, args: [FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u64, FFIType.u8], returns: FFIType.void })

  const sel = (name: string) => objc.symbols.sel_registerName(Buffer.from(`${name}\0`))
  const cls = (name: string) => objc.symbols.objc_getClass(Buffer.from(`${name}\0`))
  const target = toPointerAddress(windowPtr)
  const setContentMinSizeSel = sel("setContentMinSize:")
  if ((sendU8(target, sel("respondsToSelector:"), setContentMinSizeSel) & 1) === 0) return false

  const signature = send1(target, sel("methodSignatureForSelector:"), setContentMinSizeSel)
  if (!signature) return false

  const invocation = send1(cls("NSInvocation"), sel("invocationWithMethodSignature:"), signature)
  if (!invocation) return false

  const sizeBuffer = new Float64Array([min.width, min.height])
  send1(invocation, sel("setTarget:"), target)
  send1(invocation, sel("setSelector:"), setContentMinSizeSel)
  sendSetArg(invocation, sel("setArgument:atIndex:"), toPointerAddress(ptr(sizeBuffer)), 2)
  send0(invocation, sel("retainArguments"))
  sendMain(invocation, sel("performSelectorOnMainThread:withObject:waitUntilDone:"), sel("invoke"), 0n, 1)
  return true
}

export function enforceNativeWindowMinimumSize(
  window: EnforceableNativeWindow,
  min: WindowSize = DESKTOP_MIN_WINDOW_SIZE,
) {
  let macApplied = false
  if (process.platform === "darwin" && window.ptr) {
    macApplied = applyMacOSContentMinSize(window.ptr, min)
  }
  let clamping = false
  window.on("resize", (event) => {
    if (clamping) return
    const size = readResizeSize(event)
    if (!size) return
    if (size.width >= min.width && size.height >= min.height) return
    clamping = true
    try {
      const next = clampDesktopWindowSize(size, min)
      window.setSize(next.width, next.height)
    } finally {
      clamping = false
    }
  })
  return macApplied
}
