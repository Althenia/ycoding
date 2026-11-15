import fs from "node:fs/promises"
import path from "node:path"
import { DesktopError, utf8Length, type DesktopAPI } from "./contract"

export async function saveSessionExport(
  exported: Pick<Awaited<ReturnType<DesktopAPI["exportSession"]>>, "filename" | "content">,
  current: () => boolean,
  port: {
    readonly pickDirectory: () => Promise<string | null>
    readonly writeFile?: (file: string, content: string, options: { readonly flag: "wx"; readonly encoding: "utf8" }) => Promise<void>
  },
): Promise<{ readonly saved: boolean; readonly path?: string }> {
  const { filename, content } = exported
  if (!filename || /[/\\\u0000-\u001f\u007f]/.test(filename) || utf8Length(filename) > 255 || !/\.(?:json|md)$/.test(filename)) throw new DesktopError("The export filename is invalid.")
  if (!current()) throw new DesktopError("The connection changed before the export was saved. Open export again.")
  const directory = await port.pickDirectory()
  if (!current()) throw new DesktopError("The connection changed before the export was saved. Open export again.")
  if (directory === null) return { saved: false }
  if (!path.isAbsolute(directory)) throw new DesktopError("Choose an absolute folder for the export.")
  const target = path.join(directory, filename)
  try { await (port.writeFile ?? fs.writeFile)(target, content, { flag: "wx", encoding: "utf8" }) }
  catch (cause) {
    if (cause && typeof cause === "object" && "code" in cause && cause.code === "EEXIST") throw new DesktopError("An export with this filename already exists. Choose another folder.", { cause })
    throw new DesktopError("The export could not be saved. Choose a writable folder and try again.", { cause })
  }
  return { saved: true, path: target }
}
