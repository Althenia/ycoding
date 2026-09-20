#!/usr/bin/env python3
from pathlib import Path
import argparse,json

def render(root:Path):
 tasks=json.loads((root/'tracking/tasks.json').read_text())['tasks']; milestones=json.loads((root/'tracking/milestones.json').read_text())['milestones']
 lines=['# Current tracking','','Generated from tracking/tasks.json; application verification is distinct from kit verification.','','| Milestone | Done / total | Status |','|---|---|---|']
 for m in milestones:
  ts=[t for t in tasks if t['milestone']==m['id']];done=sum(t['status']=='done' for t in ts)
  lines.append(f'| {m["id"]} — {m["title"]} | {done}/{len(ts)} | '+('verified' if done==len(ts) else 'pending')+' |')
 (root/'TRACKING.md').write_text('\n'.join(lines)+'\n')
 lines=['# Implementation task list','','Generated from canonical JSON. Only actual evidence can close a task.']
 for m in milestones:
  lines+=['',f'## {m["id"]} — {m["title"]}','']
  for t in tasks:
   if t['milestone']!=m['id']: continue
   lines+=[f'- [{"x" if t["status"]=="done" else " "}] **{t["id"]} {t["title"]}** — {t["status"]}',f'  Acceptance: {" ".join(t["acceptance"])}',f'  Dependencies: {", ".join(t["depends_on"]) or "none"}.']
 (root/'TODO.md').write_text('\n'.join(lines)+'\n')
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parent.parent);render(p.parse_args().root)
