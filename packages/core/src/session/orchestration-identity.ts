export * as SessionOrchestrationIdentity from "./orchestration-identity"

import type { NotificationType, QuestionID } from "@ycoding-ai/schema/session-orchestration"
import { Hash } from "../util/hash"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

export const launch = (parentID: SessionSchema.ID, messageID: SessionMessage.ID, callID: string) => {
  const digest = Hash.sha256(`${parentID}\0${messageID}\0${callID}`)
  return {
    childID: SessionSchema.ID.make(`ses_task_${digest.slice(0, 24)}`),
    inputID: SessionMessage.ID.make(`msg_task_${digest.slice(0, 24)}`),
    launchEventID: `evt_task_${digest.slice(0, 24)}`,
    answer: (questionID: QuestionID) =>
      SessionMessage.ID.make(`msg_task_answer_${Hash.sha256(`${digest}\0${questionID}`).slice(0, 24)}`),
    notification: (revision: number, type: NotificationType) =>
      SessionMessage.ID.make(`msg_task_notice_${Hash.sha256(`${digest}\0${revision}\0${type}`).slice(0, 24)}`),
  }
}

export const send = (parentID: string, messageID: string, callID: string) =>
  SessionMessage.ID.make(`msg_task_send_${Hash.sha256(`${parentID}\0${messageID}\0${callID}`).slice(0, 24)}`)
