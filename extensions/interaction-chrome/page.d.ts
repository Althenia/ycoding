export const MARK: string
export function pageOperation(input: Readonly<Record<string, unknown>>): unknown
export function safeTree(root: unknown): boolean
export function withinPreviewSize(width: unknown, height: unknown): boolean
export function previewFrame(mimeType: unknown, base64: unknown): {
  mimeType: "image/png" | "image/jpeg"
  base64: string
  width: number
  height: number
} | undefined
