export * as BrowserOperation from "./operation"

import { Browser } from "@ycoding-ai/schema/browser"
import { Hash } from "../util/hash"

export type Element = Browser.Element & { readonly identity: string }
export type Identity = { readonly digest: string; readonly reusable: boolean }

export function elementIdentity(url: string, element: Browser.Element, destination?: string) {
  return Hash.json({ url, role: element.role, name: element.name, description: element.description ?? "",
    disabled: element.disabled ?? false, destination: destination ?? element.destination })
}

export function actionIdentity(tab: Pick<Browser.Tab, "id"> & { readonly pageIdentity: string; readonly mode?: Browser.Tab["mode"] | "isolated" }, action: Browser.Action, elements: ReadonlyMap<string, Element>): Identity | undefined {
  const element = action.type === "click" || action.type === "type" ? elements.get(action.ref) : undefined
  if (action.type === "click" || action.type === "type") {
    if (!element || element.disabled) return undefined
    return { reusable: Array.from(elements.values()).filter((candidate) => candidate.identity === element.identity).length === 1,
      digest: Hash.json({ tabID: tab.id, mode: tab.mode, page: tab.pageIdentity,
        action: { type: action.type, ...(action.type === "type" ? { text: action.text } : {}), target: element.identity } }) }
  }
  return { reusable: true, digest: Hash.json({ tabID: tab.id, mode: tab.mode, page: tab.pageIdentity, action }) }
}
