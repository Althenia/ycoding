import { expect, test } from "bun:test"
import { composerByteLimit, inlineFileSize } from "../src/composer-files"

test("inline composer attachments use bounded base64 byte counts without accepting directory declarations", () => {
  expect(inlineFileSize("data:image/png;base64,AAEC")).toBe(3)
  expect(inlineFileSize("data:text/plain;base64,a2VlcA==")).toBe(4)
  expect(inlineFileSize("data:application/octet-stream;base64,")).toBe(0)
  for (const uri of ["file:///synthetic/image.png", "data:text/plain,hello", "data:text/plain;base64,AA=A", "data:text/plain;base64,AA!A", "data:application/x-directory;base64,AAEC", "data:text/plain;base64,AAA", `data:text/plain;base64,${"AAAA".repeat(Math.ceil(composerByteLimit / 3) + 1)}`]) {
    expect(inlineFileSize(uri)).toBeUndefined()
  }
})
