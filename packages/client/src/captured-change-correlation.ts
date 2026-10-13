import { createHash } from "node:crypto"
export const capturedChangeSendID = (parentID: string, messageID: string, callID: string) =>
  `msg_task_send_${createHash("sha256").update(`${parentID}\0${messageID}\0${callID}`).digest("hex").slice(0, 24)}`
