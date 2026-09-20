#!/usr/bin/env python3
"""Classify JSON Schema leaves. Coverage is not proof of implemented settings."""
from __future__ import annotations
import argparse,json,re
from pathlib import Path

def schema_paths(schema:dict)->set[str]:
 found=set()
 def walk(node,path,seen):
  if not isinstance(node,dict): return
  ref=node.get('$ref')
  if ref:
   if ref in seen: raise ValueError('Recursive schema needs explicit domain review: '+ref)
   if not ref.startswith('#/'): raise ValueError('External refs must be resolved locally before audit')
   target=schema
   for key in ref[2:].split('/'): target=target[key.replace('~1','/').replace('~0','~')]
   walk(target,path,seen|{ref}); return
  handled=False
  for union in ('oneOf','anyOf','allOf'):
   if union in node:
    handled=True
    for child in node[union]: walk(child,path,seen)
  for key,child in node.get('properties',{}).items():
   handled=True; walk(child, f'{path}.{key}' if path else key,seen)
  if 'items' in node:
   handled=True; walk(node['items'],path+'[]',seen)
  if 'prefixItems' in node:
   handled=True
   for child in node['prefixItems']:walk(child,path+'[]',seen)
  extra=node.get('additionalProperties',False)
  if extra:
   handled=True
   if isinstance(extra,dict): walk(extra, (path+'.*') if path else '*',seen)
   elif path: found.add(path+'.*')
  if not handled and path: found.add(path)
 walk(schema,'',set()); return found

def covers(pattern:str,path:str)->bool:
 # Patterns match canonical schema paths (record members are '*'). Deliberate
 # trailing wildcards classify an opaque provider/options record for an editor.
 expression=re.escape(pattern).replace(r'\*','.*')
 return re.fullmatch(expression,path) is not None

def check(schema:dict,catalog:dict,domain:str,require_verified:bool=False)->dict:
 paths=schema_paths(schema); rows=[x for x in catalog['settings'] if x['domain']==domain]
 missing=[];pending=[]
 for path in sorted(paths):
  matches=[x for x in rows if covers(x['path'],path)]
  if not matches:missing.append(path)
  elif require_verified and not any(x.get('status')=='verified' and x.get('consumer_evidence') for x in matches):pending.append(path)
 return {'domain':domain,'leaf_count':len(paths),'unclassified':missing,'not_verified':pending,'pass':not missing and not pending,'scope':'classification only; verify UI effects and complete TUI command inventory separately'}
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--schema',type=Path,required=True);p.add_argument('--catalog',type=Path,default=Path(__file__).resolve().parent.parent/'tracking/settings_catalog.json');p.add_argument('--domain',choices=['runtime','tui','service','desktop'],required=True);p.add_argument('--require-verified',action='store_true');a=p.parse_args()
 try:r=check(json.loads(a.schema.read_text()),json.loads(a.catalog.read_text()),a.domain,a.require_verified); print(json.dumps(r,indent=2));raise SystemExit(0 if r['pass'] else 1)
 except (OSError,ValueError,KeyError) as e:raise SystemExit(str(e))
