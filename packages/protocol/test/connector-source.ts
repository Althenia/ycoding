export const connectorOperations = {
  "provider.auth.list": [5000, "provider.auth.list", "C", "READ"],
  "provider.auth.key": [5001, "provider.auth.key", "C", "MUTATION"],
  "provider.auth.begin": [5002, "provider.auth.begin", "C", "MUTATION"],
  "provider.auth.status": [5003, "provider.auth.status", "C", "MUTATION"],
  "provider.auth.complete": [5004, "provider.auth.complete", "C", "MUTATION"],
  "provider.auth.cancel": [5005, "provider.auth.cancel", "C", "MUTATION"],
  "workspace.list": [5006, "workspace.list", "C", "READ"],
  "session.list": [4038, "session.list", "B-reuse", "READ"],
  "session.active": [4008, "session.active", "B-reuse", "READ"],
  "session.get": [4030, "session.get", "A", "READ"],
  "session.messages": [4041, "session.messages", "A", "READ"],
  "session.capturedChanges.list": [5008, "session.capturedChanges.list", "C", "READ"],
  "session.compaction.list": [4081, "session.compaction.list", "B-reuse", "READ"],
  "session.compact": [4015, "session.compact", "B-reuse", "MUTATION"],
  "session.snapshot": [4063, "session.snapshot", "B-reuse", "READ"],
  "session.pending.list": [4044, "session.pending.list", "B-reuse", "READ"],
  "session.attachment.read": [4010, "session.attachment.read", "B-reuse", "READ"],
  "session.message.stream": [4040, "session.message", "B-reuse", "READ"],
  "session.todo.list": [4073, "session.todo.list", "A", "READ"],
  "session.subagent.list": [4067, "session.subagent.list", "B-reuse", "READ"],
  "session.pin": [4049, "session.pin", "B-reuse", "MUTATION"],
  "session.unpin": [4076, "session.unpin", "B-reuse", "MUTATION"],
  "session.subagent.cancel": [4065, "session.subagent.cancel", "B-reuse", "MUTATION"],
  "session.subagent.answer": [4064, "session.subagent.answer", "B-reuse", "MUTATION"],
  "session.team.economics": [5013, "session.team.economics", "C", "READ"],
  "session.team.shell.list": [5014, "session.team.shell.list", "C", "READ"],
  "session.team.shell.kill": [5015, "session.team.shell.kill", "B-distinct", "MUTATION"],
  "session.side-chat.list": [5016, "session.side-chat.list", "C", "READ"],
  "session.side-chat.create": [5017, "session.side-chat.create", "C", "MUTATION"],
  "session.family.activity": [5018, "session.family.activity", "C", "READ"],
  "session.log": [4039, "session.log", "B-reuse", "READ"],
  "session.subscribe": [4000, "event.subscribe", "B-reuse", "MUTATION"],
  "session.unsubscribe": [4001, "event.unsubscribe", "B-reuse", "MUTATION"],
  "session.prompt": [4050, "session.prompt", "B-reuse", "MUTATION"],
  "session.attachment.upload": [5023, "session.attachment.upload", "C", "MUTATION"],
  "session.interrupt": [4037, "session.interrupt", "A", "MUTATION"],
  "session.prediction": [4082, "session.prediction", "B-reuse", "MUTATION"],
  "session.promptGenerate": [4083, "session.promptGenerate", "B-reuse", "MUTATION"],
  "session.permission.list": [4047, "session.permission.list", "A", "READ"],
  "session.permission.reply": [4048, "session.permission.reply", "B-reuse", "MUTATION"],
  "session.guardrail.status": [4033, "session.guardrail.status", "A", "READ"],
  "session.guardrail.request.list": [4031, "session.guardrail.request.list", "A", "READ"],
  "session.guardrail.reply": [4032, "session.guardrail.request.reply", "B-reuse", "MUTATION"],
  "session.form.list": [4026, "session.form.list", "B-reuse", "READ"],
  "session.form.reply": [4027, "session.form.reply", "B-reuse", "MUTATION"],
  "session.form.cancel": [4023, "session.form.cancel", "B-reuse", "MUTATION"],
  "session.shell.output": [3043, "shell.output", "B-reuse", "READ"],
  "session.autonomy.get": [4011, "session.autonomy.get", "A", "READ"],
  "session.autonomy.set": [4012, "session.autonomy.set", "B-reuse", "MUTATION"],
  "session.goal.set": [4012, "session.autonomy.set", "B-reuse", "MUTATION"],
  "session.goal.stop": [4012, "session.autonomy.set", "B-reuse", "MUTATION"],
  "session.create": [4018, "session.create", "B-reuse", "MUTATION"],
  "session.status": [5030, "session.status", "C", "READ"],
  "session.catalog": [5043, "catalog.get", "C", "READ"],
  "workspace.catalog": [5043, "catalog.get", "C", "READ"],
  "session.file.find": [3013, "fs.find", "B-reuse", "READ"],
  "workspace.file.find": [3013, "fs.find", "B-reuse", "READ"],
  "session.switchModel": [4071, "session.switchModel", "B-reuse", "MUTATION"],
  "session.switchAgent": [4070, "session.switchAgent", "B-reuse", "MUTATION"],
  "session.command": [4014, "session.command", "B-reuse", "MUTATION"],
  "session.skill": [4061, "session.skill", "B-reuse", "MUTATION"],
  "usage.providers": [2055, "providerUsage.list", "B-reuse", "READ"],
  "usage.summary": [2058, "usage.get", "A", "READ"],
  "usage.report": [2059, "usage.report", "A", "READ"],
  "machine.keepAwake.get": [3025, "keepAwake.get", "A", "READ"],
  "machine.keepAwake.set": [3026, "keepAwake.set", "A", "MUTATION"],
  "machine.telemetry.consent.get": [3047, "telemetry.consent.get", "A", "READ"],
  "machine.telemetry.consent.set": [3048, "telemetry.consent.set", "A", "MUTATION"],
  "machine.latency.append": [3046, "telemetry.append", "B-reuse", "MUTATION"],
  "machine.latency.list": [3049, "telemetry.list", "B-reuse", "READ"],
} as const

export const noticeOperations = {
  "notice.subscribe": [5039, "notice.subscribe", "C", "MUTATION"],
  "notice.list": [5040, "notice.list", "C", "READ"],
  "notice.read": [5041, "notice.read", "C", "MUTATION"],
  "notice.readAll": [5042, "notice.readAll", "C", "MUTATION"],
} as const

export const connectorRoles = (name: string) =>
  Object.values(connectorOperations).some(([id, target]) => id < 5000 && target === name)
    ? "      roles: REMOTE_CLIENT\n      roles: RELAY\n" +
      connectorScopeOptions(name) +
      (name === "event.subscribe"
        ? '      event_types: "ycoding.v5.PublicEvent"\n'
        : name === "session.log"
          ? '      event_types: "ycoding.v5.SessionLogItem"\n'
          : "")
    : ""

export function connectorScopeOptions(name: string) {
  const scopes = {
    "event.subscribe": ["SESSION"],
    "event.unsubscribe": ["SESSION"],
    "fs.find": ["SESSION", "WORKSPACE"],
    "catalog.get": ["SESSION", "WORKSPACE"],
    "shell.output": ["SESSION"],
    "session.create": ["WORKSPACE"],
    "providerUsage.list": ["MACHINE"],
  }[name]
  return scopes
    ? ["REMOTE_CLIENT", "RELAY"]
        .map((role) => `      role_scopes: { role: ${role} ${scopes.map((scope) => `scopes: ${scope}`).join(" ")} }\n`)
        .join("")
    : ""
}
