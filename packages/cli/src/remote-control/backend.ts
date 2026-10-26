import path from "node:path"
import { SessionID } from "@ycoding-ai/schema/session-id"
import type { SessionInfo } from "@ycoding-ai/client/promise"
import { findSession, listSessions, type LocalLocation, type LocalServer } from "../remote-local"
import type { RemoteControlBackend, RemoteControlMessage, RemoteControlThread } from "./app-server"

function threadOf(info: SessionInfo): RemoteControlThread {
  return {
    id: info.id,
    title: info.title,
    directory: info.location.directory,
    updatedAt: info.time.updated,
  }
}

function locationOf(info: SessionInfo): LocalLocation {
  return info.location.workspaceID === undefined
    ? { directory: info.location.directory }
    : { directory: info.location.directory, workspaceID: info.location.workspaceID }
}

function samePath(left: string, right: string) {
  return path.resolve(left) === path.resolve(right)
}

function messageText(message: Awaited<ReturnType<LocalServer["messages"]>>[number]): RemoteControlMessage | undefined {
  if (message.type === "user") return { id: message.id, role: "user", text: message.text }
  if (message.type === "assistant") {
    const text = message.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("")
    return { id: message.id, role: "assistant", text }
  }
  if (message.type === "compaction" && message.status === "completed" && message.summary)
    return { id: message.id, role: "user", text: message.summary }
  if (message.type === "synthetic" || message.type === "system") return { id: message.id, role: "user", text: message.text }
  return undefined
}

export function createRemoteControlBackend(input: {
  readonly local: LocalServer
  readonly profile: () => Promise<string | undefined>
}): RemoteControlBackend {
  const local = input.local

  async function sessions() {
    return listSessions(local)
  }

  async function sessionByID(threadID: string) {
    return findSession(local, threadID)
  }

  return {
    resolveLocation: async (directory) => {
      const inventory = await sessions()
      const fromSession = inventory.find((info) => samePath(info.location.directory, directory))
      if (fromSession) return locationOf(fromSession)
      const projects = await local.projectList()
      for (const project of projects) {
        const directories = await local.projectDirectories(project.id)
        const match = directories.find((entry) => samePath(entry.directory, directory))
        if (match) return { directory: match.directory }
      }
      return undefined
    },
    createThread: async ({ location, title }) => {
      const info = await local.createSession(SessionID.create(), location, undefined, undefined, title)
      return threadOf(info)
    },
    getThread: async (threadID) => {
      const info = await sessionByID(threadID)
      return info === undefined ? undefined : threadOf(info)
    },
    listThreads: async () => (await sessions()).map(threadOf),
    readMessages: async (threadID) => {
      const info = await sessionByID(threadID)
      if (info === undefined) return []
      const messages = await local.messages(threadID, locationOf(info))
      return messages.flatMap((message) => {
        const mapped = messageText(message)
        return mapped === undefined ? [] : [mapped]
      })
    },
    prompt: async (threadID, prompt) => {
      const info = await sessionByID(threadID)
      if (info === undefined) throw new Error("Session is unavailable")
      const admitted = await local.prompt(threadID, locationOf(info), {
        text: prompt.text,
        delivery: prompt.delivery,
        externalSource: prompt.externalSource,
      })
      const messageID =
        typeof admitted === "object" && admitted !== null && "id" in admitted && typeof admitted.id === "string"
          ? admitted.id
          : threadID
      return { messageID }
    },
    interrupt: async (threadID) => {
      const info = await sessionByID(threadID)
      if (info === undefined) throw new Error("Session is unavailable")
      await local.interrupt(threadID, locationOf(info))
    },
    models: async () => {
      const inventory = await sessions()
      const first = inventory[0]
      if (first === undefined) return []
      const models = await local.modelList(locationOf(first))
      return models.map((model) => ({
        id: model.id,
        providerID: model.providerID,
        ...(model.name === undefined ? {} : { name: model.name }),
      }))
    },
    skills: async () => {
      const inventory = await sessions()
      const first = inventory[0]
      if (first === undefined) return []
      const skills = await local.skillList(locationOf(first))
      return skills.map((skill) => ({ id: skill.id, ...(skill.name === undefined ? {} : { name: skill.name }) }))
    },
    account: async () => {
      const profile = await input.profile()
      return profile === undefined ? undefined : { profile }
    },
    pendingApprovals: async (threadID) => {
      const info = await sessionByID(threadID)
      if (info === undefined) return []
      const location = locationOf(info)
      const pending: Array<{ id: string; kind: string }> = []
      const collect = (value: unknown, kind: string) => {
        if (!Array.isArray(value)) return
        for (const entry of value) {
          if (typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string")
            pending.push({ id: entry.id, kind })
        }
      }
      collect(await local.permissionList(threadID, location).catch(() => []), "permission")
      collect(await local.guardrailRequestList(threadID, location).catch(() => []), "guardrail")
      collect(await local.formList(threadID, location).catch(() => []), "form")
      return pending
    },
  }
}
