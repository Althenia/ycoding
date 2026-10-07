import { expect, test } from "bun:test"
import { readSessionSearch, sessionSearch, sessionURL } from "./alert"

test("Session query helpers preserve optional device and notice independently", () => {
  expect(sessionSearch("ses_1")).toEqual({ session_id: "ses_1" })
  expect(sessionSearch("ses_1", "dev_2")).toEqual({ session_id: "ses_1", device_id: "dev_2" })
  expect(sessionSearch("ses_1", "dev_2", "ntc_3")).toEqual({ session_id: "ses_1", device_id: "dev_2", notice_id: "ntc_3" })
  expect(sessionURL("ses_1")).toBe("/remote/session?session_id=ses_1")
  expect(sessionURL("ses_1", "dev_2")).toBe("/remote/session?session_id=ses_1&device_id=dev_2")
  expect(sessionURL("ses_1", "dev_2", "ntc_3")).toBe("/remote/session?session_id=ses_1&device_id=dev_2&notice_id=ntc_3")
  expect(sessionURL("ses_1&x=1", "dev 2", "ntc_3")).toBe("/remote/session?session_id=ses_1%26x%3D1&device_id=dev+2&notice_id=ntc_3")
})

test("Session query reader validates the Session and each optional identifier", () => {
  expect(readSessionSearch({ session_id: "ses_1" })).toEqual({ sessionID: "ses_1" })
  expect(readSessionSearch({ session_id: "ses_1", device_id: "dev_2" })).toEqual({ sessionID: "ses_1", deviceID: "dev_2" })
  expect(readSessionSearch({ session_id: "ses_1", device_id: "dev_2", notice_id: "ntc_3" })).toEqual({ sessionID: "ses_1", deviceID: "dev_2", noticeID: "ntc_3" })
  expect(readSessionSearch({ session_id: "ses_1", device_id: "bad!", notice_id: "ntc_3" })).toBeUndefined()
  expect(readSessionSearch({ session_id: "ses_1", device_id: undefined })).toBeUndefined()
  expect(readSessionSearch({ session_id: "ses_1", device_id: ["dev_2"] })).toBeUndefined()
  expect(readSessionSearch({ session_id: "ses_1", device_id: "dev_2", notice_id: "ntc_0" })).toEqual({ sessionID: "ses_1", deviceID: "dev_2" })
  expect(readSessionSearch({ session_id: "ses_1", device_id: "dev_2", notice_id: ["ntc_3"] })).toEqual({ sessionID: "ses_1", deviceID: "dev_2" })
  expect(readSessionSearch({ session_id: "ses_1", notice_id: "ntc_3" })).toEqual({ sessionID: "ses_1" })
  for (const search of [undefined, "session_id=ses_1", [], {}, { session_id: ["ses_1"] }, { session_id: "wrong" }])
    expect(readSessionSearch(search)).toBeUndefined()
})
