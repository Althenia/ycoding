#!/usr/bin/env python3
"""Validate handoff integrity, not YCoding application completeness."""
from pathlib import Path
import argparse,ast,hashlib,json,re,sys
sys.path.insert(0,str(Path(__file__).resolve().parent))

def verify(root:Path)->list[str]:
 errors=[]
 for p in root.rglob('*.json'):
  try:json.loads(p.read_text())
  except Exception as e:errors.append(f'Invalid JSON: {p.relative_to(root)}: {e}')
 for p in root.rglob('*.py'):
  try:ast.parse(p.read_text(),filename=str(p))
  except SyntaxError as e:errors.append(str(e))
 tasks=json.loads((root/'tracking/tasks.json').read_text())['tasks']; ids={t['id'] for t in tasks}
 if len(ids)!=len(tasks): errors.append('Duplicate task IDs')
 evidence={r['id']:r for r in json.loads((root/'tracking/evidence.json').read_text())['records']}
 graph={t['id']:t['depends_on'] for t in tasks};seen=set();active=set()
 def visit(k):
  if k in active: raise ValueError('Task dependency cycle: '+k)
  if k in seen:return
  active.add(k)
  for d in graph[k]:
   if d not in graph:raise ValueError('Missing dependency: '+d)
   visit(d)
  active.remove(k);seen.add(k)
 try:
  for k in graph:visit(k)
 except ValueError as e:errors.append(str(e))
 for t in tasks:
  if t['status'] not in ['not_started','in_progress','blocked','done']:errors.append('Invalid task status '+t['id'])
  if t['status']=='done':
   records=[evidence.get(e,{}) for e in t['evidence']]
   if not records or any(r.get('result')!='pass' or r.get('synthetic') or not r.get('redaction_reviewed') for r in records):errors.append('Done without real reviewed evidence: '+t['id'])
   kinds={r.get('kind') for r in records}
   if not set(t['required_evidence'])<=kinds:errors.append('Required evidence kinds missing: '+t['id'])
   if any(next(x for x in tasks if x['id']==d)['status']!='done' for d in t['depends_on']):errors.append('Done with incomplete dependency: '+t['id'])
 for r in evidence.values():
  for name in r.get('artifacts',[]):
   p=(root/name).resolve()
   if root.resolve() not in p.parents or not p.is_file():errors.append('Missing/unsafe evidence artifact '+name)
 for p in root.rglob('*.md'):
  for target in re.findall(r'\]\(([^\s)]+)(?:\s+"[^"]*")?\)',p.read_text()):
   if re.match(r'^[a-z]+:',target) or target.startswith('#'):continue
   path=target.split('#')[0]
   if path and not (p.parent/path).exists():errors.append(f'Broken link {p.relative_to(root)} -> {target}')
 manifest=json.loads((root/'references/manifest.json').read_text())
 for im in manifest['images']:
  p=root/'references'/im['file']
  if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest()!=im['sha256']:errors.append('Reference mismatch '+im['file'])
 if any(p.suffix.lower() in ('.ttf','.otf','.woff','.woff2') for p in root.rglob('*')):errors.append('Font file unexpectedly included')
 # R6-06: every live TUI action is classified, and no action was silently removed. A prose
 # ledger cannot hold that claim, so the pack gate carries the check itself.
 import action_parity
 errors.extend(action_parity.check(root))
 return errors
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--root',type=Path,default=Path(__file__).resolve().parent.parent);a=p.parse_args()
 errs=verify(a.root)
 print('\n'.join(errs) if errs else 'Pack structure, task dependencies, source-reference hashes and local links: PASS. This is not application acceptance.')
 raise SystemExit(1 if errs else 0)
