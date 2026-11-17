import { DatabaseSync } from "node:sqlite"

export function open(filename: string) {
  const database = new DatabaseSync(filename, { readOnly: true })
  return {
    query: (sql: string) => database.prepare(sql),
    close: () => database.close(),
  }
}
