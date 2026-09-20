#!/usr/bin/env python3
"""Read-only bounded source inventory. Does not run YCoding or read credentials."""
from __future__ import annotations
import argparse, hashlib, json, os, re, subprocess
from pathlib import Path
SKIP = {'.git','.godot','node_modules','.ycoding','.config','dist','build','vendor','__pycache__','.cache'}
EXT = {'.gd','.ts','.tsx','.md','.godot','.cfg','.yml','.yaml'}
PATTERNS = {'demo_candidates':re.compile(r'\b(mock|demo|fixture|fake|stub|simulat\w*)\b',re.I),
 'settings_candidates':re.compile(r'\b(settings|config|keybind|preference|provider_usage)\b',re.I),
 'provider_candidates':re.compile(r'\b(provider|credential|oauth|request|stream)\b',re.I),
 'project_candidates':re.compile(r'\b(location|workspace|project|directory)\b',re.I)}
def audit(repo:Path,out:Path,max_files:int=6000)->dict:
 repo=repo.resolve(); out=out.absolute()
 if not repo.is_dir() or not (repo/'apps/office/project.godot').is_file(): raise ValueError('Expected existing YCoding checkout with apps/office')
 if out.exists() or out.is_symlink(): raise ValueError('Output must be a new directory')
 if any(p.is_symlink() for p in [out.parent,*out.parents]): raise ValueError('Refusing symlinked output path')
 if out.resolve()==repo or repo in out.resolve().parents: raise ValueError('Output must be outside checkout')
 report={'scope':'bounded source candidate inventory, not runtime audit','files':[], 'matches':[], 'limits':{'max_files':max_files,'max_file_bytes':500000,'max_matches':2000},'truncated':False}
 for cmd,key in [(['git','rev-parse','HEAD'],'revision'),(['git','status','--porcelain=v1','--untracked-files=normal'],'dirty_paths')]:
  c=subprocess.run(cmd,cwd=repo,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20)
  report[key]=c.stdout[:50000] if c.returncode==0 else 'unavailable'
 for base,dirs,names in os.walk(repo,followlinks=False):
  dirs[:]=sorted(d for d in dirs if d not in SKIP and not (Path(base)/d).is_symlink())
  for name in sorted(names):
   p=Path(base)/name
   if p.is_symlink() or p.suffix not in EXT or name.startswith('.env') or re.search(r'(secret|credential|token|password).*\.(json|jsonc|cfg|yml|yaml)$',name,re.I): continue
   if len(report['files'])>=max_files: report['truncated']=True; break
   if p.stat().st_size>500000: continue
   data=p.read_bytes()
   try: text=data.decode('utf-8')
   except UnicodeDecodeError: continue
   rel=str(p.relative_to(repo)); report['files'].append({'path':rel,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
   for number,line in enumerate(text.splitlines(),1):
    if len(report['matches'])>=2000: report['truncated']=True; break
    for kind,rx in PATTERNS.items():
     if rx.search(line): report['matches'].append({'path':rel,'line':number,'kind':kind}) # No text values copied.
  if len(report['files'])>=max_files: break
 out.mkdir(parents=True); (out/'audit.json').write_text(json.dumps(report,indent=2)+'\n')
 (out/'README.md').write_text('# Source candidates only\nNo credential values, source lines or environment dumps were copied. Matches are not proof of defects or exhaustive absence. Read each source and run the native app locally.\n')
 return report
if __name__=='__main__':
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--repo',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args()
 try:
  r=audit(a.repo,a.out); print(f'Indexed {len(r["files"])} files; {len(r["matches"])} candidate locations. Truncated={r["truncated"]}; no native/provider test run.')
 except (OSError,ValueError,subprocess.SubprocessError) as e: raise SystemExit(str(e))
