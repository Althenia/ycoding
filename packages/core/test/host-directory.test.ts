import { expect, test } from "bun:test"
import { hostDirectory } from "../src/host-directory"

test("a POSIX host admits absolute and home-relative folders and refuses Windows forms", () => {
  const home = "/Users/me"
  for (const [input, expected] of [
    ["/work/app", "/work/app"],
    ["/work/app/../site/", "/work/site"],
    ["/work/with space", "/work/with space"],
    ["~", home],
    ["~/Workspace/app", "/Users/me/Workspace/app"],
    ["~\\Workspace", undefined],
    ["~other/app", undefined],
    ["relative/app", undefined],
    ["", undefined],
    ["C:\\Users\\me", undefined],
    ["C:project", undefined],
    ["\\\\server\\share\\app", undefined],
    ["/work/a\0b", undefined],
  ] as const) expect([input, hostDirectory(input, home, "darwin")]).toEqual([input, expected])
})

test("a Windows host admits drive-absolute and complete UNC folders and expands both home forms", () => {
  const home = "C:\\Users\\me"
  for (const [input, expected] of [
    ["C:\\Users\\me\\project", "C:\\Users\\me\\project"],
    ["d:/work/app/", "d:\\work\\app"],
    ["C:\\work\\..\\site", "C:\\site"],
    ["C:\\", "C:\\"],
    ["~", home],
    ["~\\Workspace\\app", "C:\\Users\\me\\Workspace\\app"],
    ["~/Workspace/app", "C:\\Users\\me\\Workspace\\app"],
    ["\\\\server\\share", "\\\\server\\share\\"],
    ["\\\\server\\share\\team\\app", "\\\\server\\share\\team\\app"],
    ["//server/share/app", "\\\\server\\share\\app"],
    ["C:project", undefined],
    ["C:", undefined],
    ["\\project", undefined],
    ["/project", undefined],
    ["\\\\server", undefined],
    ["\\\\server\\", undefined],
    ["\\\\", undefined],
    ["\\\\?\\C:\\work", undefined],
    ["\\\\.\\pipe\\work", undefined],
    ["//./C:/work", undefined],
    ["~other\\app", undefined],
    ["relative\\app", undefined],
    ["C:\\work\0", undefined],
  ] as const) expect([input, hostDirectory(input, home, "win32")]).toEqual([input, expected])
})
