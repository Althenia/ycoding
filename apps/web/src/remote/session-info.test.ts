import { describe, expect, test } from "bun:test"
import { readSessionInfo } from "./store"

describe("remote Session location metadata", () => {
  test("retains the project and directory already carried by Session.Info", () => {
    expect(readSessionInfo({
      id: "ses_api",
      title: "Inspect API",
      projectID: "prj_api",
      location: { directory: "/work/api", workspaceID: "ws_local" },
      time: { updated: 42 },
    })).toEqual({
      id: "ses_api",
      title: "Inspect API",
      projectID: "prj_api",
      directory: "/work/api",
      updatedAt: 42,
      archived: false,
    })
  })

  test("does not infer project metadata from a title or malformed fields", () => {
    for (const metadata of [
      {},
      { projectID: "", location: { directory: "" } },
      { projectID: 7, location: { directory: ["/work/api"] } },
      { projectID: null, location: null },
    ]) {
      expect(readSessionInfo({ id: "ses_api", title: "/work/api", ...metadata })).toEqual({
        id: "ses_api", title: "/work/api", updatedAt: 0, archived: false,
      })
    }
  })
})
