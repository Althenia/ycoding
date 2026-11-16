import { Database } from "bun:sqlite"

export function open(filename: string) {
  return new Database(filename, { readonly: true, create: false })
}
