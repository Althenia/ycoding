import { constants, Database, type Statement } from "bun:sqlite"
import { pathToFileURL } from "node:url"

export function openImmutableDatabase(file: string): Database {
  // URI parsing is not enabled by default on every platform. Keep immutable
  // reads from creating WAL/SHM sidecars in the frozen baseline.
  return new Database(
    `${pathToFileURL(file).href}?immutable=1`,
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  )
}

export function immutableQuery<Row>(database: Database, sql: string): Statement<Row, []> {
  const statement = database.query<Row, []>(sql)
  // Numeric open flags cannot be combined with Bun's strict/safeIntegers
  // constructor options. These readers accept no bindings, including missing ones.
  if (statement.paramsCount !== 0) {
    statement.finalize()
    throw new Error("Immutable baseline queries must not contain parameters")
  }
  // Bun documents this method, but the installed bun-types omit its declaration.
  return (statement as typeof statement & { safeIntegers(enabled: boolean): typeof statement }).safeIntegers(true)
}
