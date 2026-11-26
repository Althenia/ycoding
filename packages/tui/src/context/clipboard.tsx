import { createContext, type JSX, useContext } from "solid-js"
import { read, write, type ClipboardFile } from "../clipboard"

export type ClipboardContent = Readonly<{ type: "text"; text: string; mime: "text/plain" }> | ClipboardFile
export type ClipboardService = Readonly<{
  read?(): Promise<ClipboardContent | undefined>
  write?(text: string): Promise<void>
}>
const clipboard = { read, write }
const ClipboardContext = createContext<ClipboardService>(clipboard)

export function ClipboardProvider(props: { value?: ClipboardService; warn?: (message: string) => void; children: JSX.Element }) {
  const service = props.warn ? { read, write: (text: string) => write(text, props.warn) } : clipboard
  return (
    <ClipboardContext.Provider value={props.value ?? service}>
      {props.children}
    </ClipboardContext.Provider>
  )
}

export function useClipboard() {
  return useContext(ClipboardContext)
}
