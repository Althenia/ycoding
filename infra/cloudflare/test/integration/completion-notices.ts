import { spawn } from "bun"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"

const root = new URL("../../../../", import.meta.url).pathname
const wrangler = join(root, "node_modules/.bin/wrangler")
const port = 49000 + Math.floor(Math.random() * 1000)
const origin = `http://127.0.0.1:${port}`
const config = "infra/cloudflare/wrangler.jsonc"
let worker: { kill: () => unknown; exited: Promise<number> } | undefined
let home: string | undefined

try {
  await mkdir(join(root, ".cache/tmp"), { recursive: true })
  home = await mkdtemp(join(root, ".cache/tmp/completion-notices-"))
  const entry = join(home, "worker.js")
  const persist = join(home, "wrangler")
  await Bun.write(entry, `
import { DurableObject } from "cloudflare:workers"
import { createNoticeStore } from ${JSON.stringify(join(root, "infra/cloudflare/src/relay/notice-store.ts"))}
import { createRelay } from ${JSON.stringify(join(root, "infra/cloudflare/src/relay/core.ts"))}
export class DeviceRelay extends DurableObject {
  frames = []
  pushes = []
  fail = false
  attached = false
  store = createNoticeStore({sql:this.ctx.storage.sql,kv:this.ctx.storage.kv,transactionSync:(operation)=>this.ctx.storage.transactionSync(()=>{
    const result=operation()
    if(this.fail){this.fail=false;throw new Error("Synthetic commit failure")}
    return result
  })})
  relay = createRelay({now:()=>Date.now(),newID:()=>"fixture",send:(_id,message)=>this.frames.push(JSON.parse(message)),close:()=>{},
    saveSubscriptions:()=>{},savePending:()=>{},loadStatus:async()=>undefined,saveStatus:async()=>{},
    loadOfflineCheck:async()=>undefined,saveOfflineCheck:async()=>{},notices:this.store,saveNoticeSubscription:()=>{},
    authorizeClientCommand:async()=>({ok:true}),authorizeAgentCommand:async()=>({ok:true}),authorityTtlMs:0,
    notifyPush:async(_account,event)=>{this.pushes.push(event);return []}})
  async fetch(request){
    if(!this.attached){
      const connection={ownerID:"usr_local",deviceID:"dev_local",browserSessionID:"local",credentialExpiresAt:Date.now()+600000,subscriptions:[],pending:[]}
      await this.relay.attach({...connection,connectionID:"agent",role:"agent",noticesSubscribed:false})
      await this.relay.attach({...connection,connectionID:"client",role:"client",noticesSubscribed:true})
      this.attached=true
    }
    this.frames=[];this.pushes=[]
    const body=await request.json()
    this.fail=body.fail===true
    if(body.readAll)await this.relay.handleClientMessage("client",JSON.stringify({type:"request",id:"clear",operation:"notice.readAll"}))
    if(body.frame)await this.relay.handleAgentMessage("agent",JSON.stringify(body.frame))
    await this.relay.settleDeliveries()
    return Response.json({page:this.store.page(),frames:this.frames,pushes:this.pushes})
  }
}
export default {async fetch(request,env){
  if(new URL(request.url).pathname==="/health"){await env.DB.prepare("SELECT 1").first();return new Response("ready")}
  return env.DEVICE_RELAY.getByName("completion-local-proof").fetch(request)
}}
`)
  const occupied = await fetch(`${origin}/health`).then(() => true, () => false)
  check(!occupied, "Chosen port belongs to another process")
  const start = async () => {
    worker = spawn([wrangler, "dev", entry, "--local", "--config", config, "--persist-to", persist, "--port", String(port)],
      { cwd: root, stdout: "ignore", stderr: "ignore" })
    for (let attempt = 0; attempt < 150; attempt += 1) {
      try { if ((await fetch(`${origin}/health`)).status === 200) return } catch {}
      await Bun.sleep(100)
    }
    throw new Error("Local workerd did not start")
  }
  await start()
  const call = async (body: unknown) => {
    const response = await fetch(origin, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    check(response.status === 200, `Completion fixture returned ${response.status}`)
    return await response.json() as { page: { total: number; notices: { id: string; sessionID: string }[] }; frames: { type: string }[]; pushes: { noticeID: string; sessionID: string }[] }
  }
  const receipt = (sessionID: string, seq: number) => ({ id: `evt_${sessionID}_${seq}`, sessionID, seq, created: 1000 + seq })
  const frame = (data: ReturnType<typeof receipt>[], more = false) => ({ type: "completions", data, more })
  const initial = Array.from({ length: 200 }, (_, index) => receipt(`ses_${index}`, 10))
  for (const baseline of [frame(initial, true), frame([], true), frame([receipt("ses_last", 50)])]) {
    const result = await call({ frame: baseline })
    check(result.page.total === 0 && result.pushes.length === 0 && result.frames.length === 0, "Initial receipt synchronization notified")
  }
  const live = await call({ frame: frame([receipt("ses_0", 11), receipt("ses_new", 1)]) })
  check(live.page.total === 2 && live.pushes.length === 2 && live.frames.map((entry) => entry.type).join() === "notice.added,notice.present,notice.present", `Explicit receipts failed to publish and present two stored notices: ${JSON.stringify(live.frames.map((entry) => entry.type))}`)
  check(live.pushes.every((push) => live.page.notices.some((notice) => notice.id === push.noticeID)), "Push lacks its durable notice identity")
  const duplicate = await call({ frame: frame([receipt("ses_0", 11), receipt("ses_last", 49)]) })
  check(duplicate.page.total === 2 && duplicate.pushes.length === 0 && duplicate.frames.length === 0, "Duplicate or older receipts notified")
  await call({ frame: { type: "status", running: ["ses_busy"], attention: [] } })
  const idle = await call({ frame: { type: "status", running: [], attention: [] } })
  check(idle.page.total === 2 && idle.pushes.length === 0, "Idle status synthesized completion")
  const failed = await call({ frame: frame([receipt("ses_0", 12)]), fail: true })
  check(failed.page.total === 2 && failed.pushes.length === 0 && failed.frames.map((entry) => entry.type).join() === "notice.unavailable",
    "Failed KV+SQL transaction advanced notices or published completion")
  const retry = await call({ frame: frame([receipt("ses_0", 12)]) })
  check(retry.page.total === 3 && retry.pushes.length === 1 && retry.pushes[0]?.noticeID === "ntc_3", "Rolled-back receipt could not retry exactly once")
  const cleared = await call({ readAll: true })
  check(cleared.page.total === 0, "Read all left notices")
  worker?.kill()
  if (worker) await worker.exited
  worker = undefined
  await start()
  const restored = await call({ frame: frame([receipt("ses_0", 12), receipt("ses_new", 1)]) })
  check(restored.page.total === 0 && restored.pushes.length === 0 && restored.frames.length === 0, "Restart or readAll erased completion dedup")
  const newer = await call({ frame: frame([receipt("ses_0", 13)]) })
  check(newer.page.total === 1 && newer.pushes.length === 1 && newer.pushes[0]?.noticeID === "ntc_4", "Restart lost initial-sync marker or notice sequence")
  const status = (attention: string[]) => ({ type: "status", running: attention.length === 0 ? ["ses_retry"] : [], attention, failed: attention })
  await call({ frame: status([]) })
  const attention = await call({ frame: status(["ses_retry"]) })
  check(attention.page.total === 2 && attention.pushes.length === 1, "New attention did not notify")
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await call({ frame: status([]) })
    const repeated = await call({ frame: status(["ses_retry"]) })
    check(repeated.page.total === 2 && repeated.pushes.length === 0 && repeated.frames.every((item) => !item.type.startsWith("notice.")),
      "Retry repeated an unread attention notice or alert")
  }
  await call({ frame: status([]) })
  const another = await call({ frame: status(["ses_retry", "ses_other"]) })
  check(another.page.total === 3 && another.pushes.length === 1 && another.pushes[0]?.sessionID === "ses_other" &&
    another.page.notices.some((notice) => notice.id === another.pushes[0]?.noticeID && notice.sessionID === "ses_other"),
    "Coalesced attention hid or mismatched another Session's alert")
  worker?.kill()
  if (worker) await worker.exited
  worker = undefined
  await start()
  await call({ frame: status([]) })
  const persistedAttention = await call({ frame: status(["ses_retry"]) })
  check(persistedAttention.page.total === 3 && persistedAttention.pushes.length === 0 &&
    persistedAttention.frames.every((item) => !item.type.startsWith("notice.")), "Restart replayed unread attention")
  await call({ readAll: true })
  await call({ frame: status([]) })
  const afterRead = await call({ frame: status(["ses_retry"]) })
  check(afterRead.page.total === 1 && afterRead.pushes.length === 1 && afterRead.pushes[0]?.sessionID === "ses_retry",
    "Marking attention read did not permit a fresh alert")
  console.log("PASS: local workerd+D1 health, real Durable Object kv+SQL transaction rollback/retry, paged silent baseline, receipt-only completions, unread attention coalescing, distinct Sessions, readAll and process restart; push dispatch captured locally")
} finally {
  worker?.kill()
  if (worker) await worker.exited
  if (home) await rm(home, { recursive: true, force: true })
}

function check(condition: boolean, message: string) {
  if (!condition) throw new Error(message)
}
