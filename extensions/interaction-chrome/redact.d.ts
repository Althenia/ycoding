export const redactionPatterns: readonly { readonly source: string; readonly flags: string }[]
export function redactText(text: unknown): string
export function redactURL(url: unknown): string | undefined
