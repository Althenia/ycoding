import { describe, expect, test } from "bun:test"
import { keyboardLayoutMax, keyboardOcclusion, keyboardOpenThreshold, paintKeyboardChrome, visualViewportFrame, type KeyboardChromeTarget } from "./visual-viewport"

function chrome(): KeyboardChromeTarget & { readonly props: Map<string, string> } {
  const props = new Map<string, string>()
  const dataset: { keyboardOpen?: string } = {}
  return {
    props,
    dataset,
    style: { setProperty: (name, value) => { props.set(name, value) } },
  }
}

describe("keyboard occlusion", () => {
  test("treats a covered inset above 80px below 1200px as an open keyboard", () => {
    expect(keyboardOpenThreshold).toBe(80)
    expect(keyboardLayoutMax).toBe(1200)
    expect(keyboardOcclusion({ layoutWidth: 390, layoutHeight: 844, offsetTop: 0, height: 420 })).toEqual({ open: true, inset: 424 })
    expect(keyboardOcclusion({ layoutWidth: 820, layoutHeight: 1180, offsetTop: 40, height: 700 })).toEqual({ open: true, inset: 440 })
  })

  test("stays closed for a small inset, a desktop width, and an unreported viewport", () => {
    expect(keyboardOcclusion({ layoutWidth: 390, layoutHeight: 844, offsetTop: 0, height: 800 })).toEqual({ open: false, inset: 0 })
    expect(keyboardOcclusion({ layoutWidth: 1440, layoutHeight: 900, offsetTop: 0, height: 400 })).toEqual({ open: false, inset: 0 })
    expect(keyboardOcclusion({ layoutWidth: 390, layoutHeight: 844, offsetTop: 0, height: 0 })).toEqual({ open: false, inset: 0 })
    expect(keyboardOcclusion({ layoutWidth: 390, layoutHeight: 844, offsetTop: -12, height: 400 })).toEqual({ open: true, inset: 444 })
  })
})

describe("visual viewport frame", () => {
  test("rounds a reported viewport and omits an unreported one", () => {
    expect(visualViewportFrame({ offsetTop: 40.4, height: 700.2 })).toEqual({ top: 40, height: 700 })
    expect(visualViewportFrame({ offsetTop: -12, height: 400 })).toEqual({ top: 0, height: 400 })
    expect(visualViewportFrame(undefined)).toBeUndefined()
    expect(visualViewportFrame({ offsetTop: 0, height: 0 })).toBeUndefined()
  })
})

describe("keyboard chrome", () => {
  test("sets the open attribute and inset, then clears both when closed", () => {
    const element = chrome()
    paintKeyboardChrome(element, { open: true, inset: 424 })
    expect(element.dataset.keyboardOpen).toBe("")
    expect(element.props.get("--yc-keyboard-inset")).toBe("424px")
    paintKeyboardChrome(element, { open: false, inset: 0 })
    expect(element.dataset.keyboardOpen).toBeUndefined()
    expect(propsOf(element)).toBe("0px")
  })
})

function propsOf(element: { readonly props: Map<string, string> }): string | undefined {
  return element.props.get("--yc-keyboard-inset")
}
