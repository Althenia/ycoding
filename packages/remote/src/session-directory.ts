export function isSessionDirectoryPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) return false
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\") || value.startsWith("/")) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  const unc = /^\\\\([^\\/]+)[\\/]([^\\/]+)/.exec(value)
  return unc !== null && unc[1] !== "?" && unc[1] !== "." && unc[1]!.trim() !== "" && unc[2]!.trim() !== ""
}
